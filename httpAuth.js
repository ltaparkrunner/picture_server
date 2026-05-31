import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import User from './model/User.js';
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, ListBucketsCommand, DeleteObjectCommand} from "@aws-sdk/client-s3";

const router = express.Router();
const USERS = process.env.USERS || 'users';
const BUCKET = process.env.BUCKET_NAME || 'images';
const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, MONGO_URL } = process.env;

const s3Client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: "us-east-1", // For MinIO any value
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true // Required for MinIO
});

// 2. Маршрут РЕГИСТРАЦИИ
router.post('/register', async (req, res) => {
    console.log("Received registration request: ", req.body);
    try {
        const { username, password } = req.body;
        const login = username;
        // Checking if the name is taken.
        const existingUser = await User.findOne({ login });
        if (existingUser) {
            return res.status(400).json({ error: "Пользователь уже существует" });
        }

        const exists = await bucketExists(BUCKET);
        if (!exists) {
            await createS3Bucket(BUCKET);
        }
        // Сreate and save a user
        const newUser = new User({
            login,
            password: password
        });

        console.log("Before await newUser.save(); ", newUser.login);
        await newUser.save();
        const userId = newUser._id.toString();

        // 2. Create a "virtual folder" for the user.
        // In S3, we simply place an empty .placeholder file in the user's folder.
        const placeholderPath = `${USERS}/${userId}/.placeholder`;
        const command = new PutObjectCommand({
            Bucket: BUCKET,
            Key: placeholderPath,
            Body: ""
        });
    
        await s3Client.send(command);
        // immediately create a token
        const token = jwt.sign(
            { id: newUser._id }, 
            process.env.JWT_SECRET || 'secret_key', 
            { expiresIn: process.env.JWT_EXPIRES_IN || '4h' }
        );
        res.status(201).json({ 
            message: "Пользователь создан",
            token: token 
        });

    } catch (err) {
        console.log("Error during registration: ", err);
        res.status(500).json({ error: "Ошибка сервера при регистрации" });
    }
});

// 3. Обновленный маршрут ЛОГИНА (с проверкой хеша)
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const login = username;
        const user = await User.findOne({ login });

        if (!user) return res.status(401).json({ error: "Неверный логин" });
        console.log("User found: ", login);
        // Compare the provided password with the stored hash
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Неверный пароль" });
        }
        console.log("Correct password: ", password);
        const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET || 'secret_key', 
            { expiresIn: process.env.JWT_EXPIRES_IN || '4h' });
        res.json({ token });
    } catch (err) {
        res.status(500).json({ error: "Ошибка входа" });
    }
});

export default router; 

async function bucketExists(bucketName) {
    try {
      const command = new HeadBucketCommand({ Bucket: bucketName });
      await s3Client.send(command);
      return true; // Bucket exists and you have access
    } catch (error) {
      if (error.name === "NotFound") {
        return false; // Bucket does not exist
      }
      // Handle other errors (like 403 Forbidden) based on your needs
      console.error("Error checking bucket:", error.name);
      return false;
    }
}

async function createS3Bucket(bucketName, region = "us-west-2") {
    const input = {
      Bucket: bucketName,
      CreateBucketConfiguration: {
        LocationConstraint: region,
      },
    };
    console.log(`Attempting to create bucket: ${bucketName} in region: ${region}   input: `, input);
    try {
      const command = new CreateBucketCommand(input);
      const response = await s3Client.send(command);
      console.log(`Bucket created successfully at: ${response.Location}`);
      return response;
    } catch (error) {
      console.error("Error creating bucket:", error.message);
      throw error;
    }
  }
