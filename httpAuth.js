import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import User from './model/User.js';

const router = express.Router();
const USERS = process.env.USERS || 'users';
// 2. Маршрут РЕГИСТРАЦИИ
router.post('/register', async (req, res) => {
    console.log("Received registration request: ", req.body);
    try {
        const { username, password } = req.body;
        const login = username;
        // Проверяем, не занято ли имя
        const existingUser = await User.findOne({ login });
        if (existingUser) {
            return res.status(400).json({ error: "Пользователь уже существует" });
        }
        // Создаем и сохраняем пользователя
        const newUser = new User({
            login,
            password: password
        });

        console.log("Before await newUser.save(); ", newUser.login);
        await newUser.save();
        const userId = newUser._id.toString();
        const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
        if (!bucketExists) {
            await minioClient.makeBucket(BUCKET_NAME);
        }
        // 2. Create a "virtual folder" for the user.
        // In S3, we simply place an empty .placeholder file in the user's folder.
        //  const placeholderPath = `users/${userId}/.placeholder`;
        const placeholderPath = `${USERS}/${userId}/.placeholder`;
        await minioClient.putObject(BUCKET_NAME, placeholderPath, "init");
        // Сразу создаем токен, чтобы пользователю не нужно было логиниться после регистрации
        console.log("process.env.JWT_SECRET: ", process.env.JWT_SECRET);
        console.log("process.env.JWT_EXPIRES_IN: ", process.env.JWT_EXPIRES_IN);
        const token = jwt.sign(
            { id: newUser._id }, 
            process.env.JWT_SECRET || 'secret_key', 
            { expiresIn: process.env.JWT_EXPIRES_IN || '4h' }
        );
        console.log("User registered successfully: ", newUser.login);
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
    console.log("Received login request: ", req.body);
    console.log("process.env.USERS: ", process.env.USERS); 
    console.log("process.env.JWT_SECRET: ", process.env.JWT_SECRET);
    console.log("process.env.JWT_EXPIRES_IN: ", process.env.JWT_EXPIRES_IN);
    try {
        const { username, password } = req.body;
        const login = username;
        const user = await User.findOne({ login });

        if (!user) return res.status(401).json({ error: "Неверный логин" });
        console.log("User found: ", login);
        // Сравниваем присланный пароль с хешем в базе
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            console.log("Incorrect password for user: ", password);
            const hashedPassword = await bcrypt.hash(password, 10);
            console.log("Hashed version of incorrect password: ", hashedPassword, 
                "  Stored hash: ", user.password);
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

// router export

export default router; 

// 2. Логика в маршруте регистрации

// В S3 (Minio) папки не существуют как физические объекты — они создаются автоматически,
//  когда вы загружаете файл по пути folder/file.dat. Поэтому при регистрации лучше всего
//   создать «маркер-файл» или просто убедиться, что основной бакет существует.
/*
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        // ... (код проверки и хеширования из предыдущего шага) ...

        const newUser = new User({ username, password: hashedPassword });
        await newUser.save();

        // --- РАБОТА С MINIO ---
        const userId = newUser._id.toString();
        
        // 1. Проверяем/создаем общий бакет
        const bucketExists = await minioClient.bucketExists(BUCKET_NAME);
        if (!bucketExists) {
            await minioClient.makeBucket(BUCKET_NAME);
        }

        // 2. Создаем "виртуальную папку" для пользователя.
        // В S3 мы просто кладем пустой файл .placeholder в папку пользователя.
        const placeholderPath = `users/${userId}/.placeholder`;
        await minioClient.putObject(BUCKET_NAME, placeholderPath, "init");

        // --- ЗАВЕРШЕНИЕ ---
        const token = jwt.sign({ id: userId }, 'secret_key', { expiresIn: '2h' });
        res.status(201).json({ token });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Ошибка при создании окружения пользователя" });
    }
});
*/
