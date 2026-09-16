import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import User from './model/User.js';
import ImageRecord from './model/ImageRecord.js';
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const router = express.Router();
const USERS = process.env.USERS || 'users';
const BUCKET = process.env.BUCKET_NAME || 'images';
const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY } = process.env;

// Настройка S3 (MinIO) клиента (синхронизировано с регионом из server.js)
const s3Client = new S3Client({
    endpoint: S3_ENDPOINT,
    region: "us-east-1", 
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true 
});

// 1. Маршрут РЕГИСТРАЦИИ (с исправлением хэширования)
router.post('/register', async (req, res) => {
    console.log("Received registration request: ", req.body);
    try {
        const { username, password } = req.body;
        const login = username;

        // Проверка, занято ли имя пользователя
        const existingUser = await User.findOne({ login });
        if (existingUser) {
            return res.status(400).json({ error: "Пользователь уже существует" });
        }

        // Проверяем существование бакета и создаем при необходимости
        const exists = await bucketExists(BUCKET);
        if (!exists) {
            await createS3Bucket(BUCKET);
        }

        // ХЭШИРУЕМ ПАРОЛЬ перед сохранением (ИСПРАВЛЕНИЕ БАГА)
        const saltRounds = 10;
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // Создаем и сохраняем пользователя с хэшированным паролем
        const newUser = new User({
            login,
            password: hashedPassword
        });

        console.log("Saving new user: ", newUser.login);
        await newUser.save();
        const userId = newUser._id.toString();

        // Создаем виртуальную папку в S3 (.placeholder)
        const placeholderPath = `${USERS}/${userId}/.placeholder`;
        const command = new PutObjectCommand({
            Bucket: BUCKET,
            Key: placeholderPath,
            Body: ""
        });
        await s3Client.send(command);

        // Сохраняем запись о .placeholder в MongoDB
        const placeholderRecord = new ImageRecord({
            name: '.placeholder',
            originalName: '.placeholder',
            folder: `${USERS}/${userId}/`, // Добавлен слэш для консистентности путей папок
            s3Key: placeholderPath,
            bucket: BUCKET,
            userLogin: login,
            size: 0,
            info: { type: 'initialization_file' }
        });
        await placeholderRecord.save();

        // Сразу генерируем JWT токен для автовхода
        const token = jwt.sign(
            { id: newUser._id }, 
            process.env.JWT_SECRET || 'secret_key', 
            { expiresIn: process.env.JWT_EXPIRES_IN || '4h' }
        );

        return res.status(201).json({ 
            message: "Пользователь создан",
            token: token 
        });

    } catch (err) {
        console.error("Error during registration: ", err);
        return res.status(500).json({ error: "Ошибка сервера при регистрации" });
    }
});

// 2. Маршрут ЛОГИНА
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const login = username;
        const user = await User.findOne({ login });

        if (!user) return res.status(401).json({ error: "Неверный логин" });
        console.log("User found: ", login);

        // Сравнение переданного пароля с хэшем в БД
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ error: "Неверный пароль" });
        }

        const token = jwt.sign(
            { id: user._id }, 
            process.env.JWT_SECRET || 'secret_key', 
            { expiresIn: process.env.JWT_EXPIRES_IN || '4h' }
        );
        
        return res.json({ token });
    } catch (err) {
        console.error("Error during login:", err);
        return res.status(500).json({ error: "Ошибка входа" });
    }
});

export default router; 

// --- Вспомогательные функции S3 ---

async function bucketExists(bucketName) {
    try {
      const command = new HeadBucketCommand({ Bucket: bucketName });
      await s3Client.send(command);
      return true; 
    } catch (error) {
      if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
        return false; 
      }
      console.error("Error checking bucket:", error.name);
      return false;
    }
}

async function createS3Bucket(bucketName) {
    // Для MinIO параметр CreateBucketConfiguration часто избыточен или вызывает ошибки, 
    // если регион указан неверно. Переводим на дефолтный us-east-1.
    const input = {
      Bucket: bucketName,
      CreateBucketConfiguration: {
        LocationConstraint: "us-east-1",
      },
    };
    console.log(`Attempting to create bucket: ${bucketName} in region: us-east-1`);
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
