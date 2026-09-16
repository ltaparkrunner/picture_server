import https from 'https';
import fs from 'fs';
import mongoose from 'mongoose';
import express from 'express';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

import { S3Client } from "@aws-sdk/client-s3";
import ImageRecord from './model/ImageRecord.js';
import User from './model/User.js';
import router from './httpAuth.js';

// Импортируем ваши обработчики (их тоже нужно будет внутри переписать на JSON/HTTP, см. примечание ниже)
import { 
    handleGetUserBuckets, 
    handleGetUserBucket, 
    handleAddFile, 
    handleListRequest, 
    handleDeleteFile, 
    handlefilesIdsRequest, 
    handlePathInfRequest 
} from './auxHandler.js';

const app = express();

// Мидлвары для парсинга JSON и роутов авторизации
app.use(express.json());
app.use('/auth', router);

// Настройки из окружения
const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, MONGO_URL, JWT_SECRET } = process.env;
const secretKey = JWT_SECRET || 'secret_key';

// 1. Подключение к MongoDB
mongoose.connect(MONGO_URL)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));

// 2. Настройка S3 (MinIO) клиента
const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1", 
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true 
});

// 3. Middleware для проверки JWT (заменяет логику wss.on('upgrade'))
const authenticateToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ status: "error", message: "Unauthorized: Missing token" });
    }

    const token = authHeader.split(' ')[1];

    try {
        const decoded = jwt.verify(token, secretKey);
        req.user = decoded; // Записываем данные юзера в запрос

        // Находим юзера в БД для логирования (как было в вашем коде)
        const user = await User.findOne({ _id: req.user.id });
        req.user.login = user ? user.login : "Unknown";

        next(); // Переходим к самому эндпоинту
    } catch (err) {
        console.error("JWT Error:", err.message);
        return res.status(401).json({ status: "error", message: "Unauthorized: Invalid token" });
    }
};

// --- REST ЭНДПОИНТЫ (Замена WebSocket событий и switch-case) ---

// Заменяет: envelope.reqUserBuckets
app.post('/api/buckets', authenticateToken, async (req, res) => {
    try {
        // Передаем req и res вместо ws
        await handleGetUserBucket(req, res, s3Client);
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// Заменяет: envelope.addFile
app.post('/api/files/add', authenticateToken, async (req, res) => {
    try {
        await handleAddFile(req, res, s3Client);
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// Заменяет: envelope.listRequest
app.post('/api/files/list', authenticateToken, async (req, res) => {
    try {
        await handleListRequest(req, res, s3Client);
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// Заменяет: envelope.deleteFile
app.delete('/api/files', authenticateToken, async (req, res) => {
    try {
        await handleDeleteFile(req, res, s3Client);
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// Заменяет: envelope.filesIdsRequest
app.post('/api/files/ids', authenticateToken, async (req, res) => {
    try {
        await handlefilesIdsRequest(req, res, s3Client);
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});

// Заменяет: envelope.pathInfRequest
app.post('/api/files/path-info', authenticateToken, async (req, res) => {
    try {
        await handlePathInfRequest(req, res, s3Client);
    } catch (error) {
        console.error(error);
        res.status(500).json({ status: "error", message: "Internal server error" });
    }
});


// 4. Запуск единого HTTPS сервера для Express на порту 8080
const sslOptions = {
    key: fs.readFileSync('./key.pem'),
    cert: fs.readFileSync('./cert.pem'),
    minVersion: 'TLSv1.2'
};

https.createServer(sslOptions, app).listen(8080, '0.0.0.0', () => {
    console.log('Secure HTTPS REST API Server running on port 8080');
});
