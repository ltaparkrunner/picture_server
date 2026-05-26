import { handleViewFolder, handleGetFolderContent, handleGetFolderOnlyFilesContent} from './handlers.js';
import { handleRegister, handleLogin, verifyToken} from './authHandlers.js';
import https from 'https';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import mongoose from 'mongoose';
import ImageRecord from './model/ImageRecord.js';
import protobuf from 'protobufjs';
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, ListBucketsCommand, DeleteObjectCommand} from "@aws-sdk/client-s3";

import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express from 'express';
import jwt from 'jsonwebtoken';

import router from './httpAuth.js';
import User from './model/User.js';
import { handleGetUserBuckets, handleGetUserBucket, handleAddFile, handleListRequest, handleDeleteFile, handlefilesIdsRequest } from './auxHandler.js';

import 'dotenv/config';

const USERS = process.env.USERS || 'users';
const BUCKET = process.env.BUCKET_NAME || 'images';
console.log("Config variable process.env.USERS: ", process.env.USERS);
const app = express();
app.use(express.json());
app.use('/auth', router);

app.listen(8081, () => console.log('Auth server running on port 8081'));

// Настройки из окружения
const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, MONGO_URL } = process.env;

console.log("S3_ENDPOINT: ", S3_ENDPOINT, " S3_ACCESS_KEY: ", S3_ACCESS_KEY, " S3_SECRET_KEY: ", S3_SECRET_KEY, " S3_BUCKET: ", S3_BUCKET, " MONGO_URL: ", MONGO_URL);  

const serverConfig = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

// 1. Подключение к MongoDB
mongoose.connect(MONGO_URL);

// 2. Настройка S3 (MinIO) клиента
const s3Client = new S3Client({
  endpoint: S3_ENDPOINT,
  region: "us-east-1", // Для MinIO любое значение
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true // Обязательно для MinIO
});

async function getDownloadUrl(bucketName, fileName) {
    try {
        // Генерируем ссылку, которая будет жить, например, 1 час (3600 сек)
        const url = await s3Clientexternal.presignedGetObject(bucketName, fileName, 3600);
        
        console.log("Эта ссылка будет работать в браузере:", url);
        return url;
    } catch (err) {
        console.error("Ошибка генерации ссылки:", err);
    }
}

const createCommand = new CreateBucketCommand({ 
    Bucket: BUCKET 
});
async function bootstrap() {
    try {
        //  console.log("An attempt to create backet:", createCommand.input.Bucket);
        await s3Client.send(createCommand);
        //  console.log("Bucket ", reateCommand.input.Bucket, " created successfully.");
    } catch (err) {
        if (err.Code === 'BucketAlreadyOwnedByYou' || err.Code === 'BucketAlreadyExists') {
            //  console.log("Bucket ", reateCommand.input.Bucket, " exists already, proceeding...");
        } else {
            // console.error("Ошибка инициализации хранилища:", err);
        }
    }
}

//  bootstrap(); // performed once
protobuf.load("image.proto", (err, root) => {
    if (err) throw err;
    // Create HTTPS server
    const httpsServer = https.createServer({
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem'),
        minVersion: 'TLSv1.2'// Allow TLS 1.2
    });

    const wss = new WebSocketServer({ noServer: true});
    httpsServer.on('upgrade', (request, socket, head) => {
        // 3. Извлекаем заголовок авторизации
        console.log("Upgrade request received with headers:", request.headers);
        const authHeader = request.headers['authorization'];
    
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            console.log("Unauthorized upgrade attempt");
            // 4. Отклоняем на уровне HTTP, не переходя в WebSocket
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }
        const token = authHeader.split(' ')[1];

        try {
            console.log("process.env.JWT_SECRET: ", process.env.JWT_SECRET);
            // 2. Верифицируем токен (проверит и подпись, и expiration time)
            const secret = process.env.JWT_SECRET || 'secret_key';
            const decoded = jwt.verify(token, secret);
    
            // 3. Сохраняем данные пользователя прямо в запрос, чтобы достать их позже
            request.user = decoded; 
    
            // 4. Завершаем апгрейд
            wss.handleUpgrade(request, socket, head, (ws) => {
                wss.emit('connection', ws, request);
            });
        } catch (err) {
            console.error("JWT Error:", err.message);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
        }
    });
    wss.on('connection', (ws, req) => {
        console.log('Secure Qt Client connected via WSS: ', req.user);

        ws.on('message', async (message) => {
            try {
                // Декодируем входящий ClientEnvelope из сырых байт
                const ClientEnvelope = root.lookupType('ClientEnvelope');
                const envelope = ClientEnvelope.decode(message);
                
                const ClientTypeValues = ClientEnvelope.nested.Type.values;
                console.log("ClientTypeValues: ", ClientTypeValues);
                // Определяем тип запроса на основе поля 'type'
                console.log("ClientTypeValues.AUTH_REQUEST: ", ClientTypeValues.AUTH_REQUEST, "   envelope.type: ", envelope.type)
//                    , "ClientTypeValues.AUTH_REQUEST: ", ClientTypeValues.AUTH_REQUEST)
                const user = await User.findOne({ _id: req.user.id });
                const emaillogin = user ? user.login : "Unknown";
                console.log("Decoded Protobuf message content: ", envelope.type, " from user: ", emaillogin); 

                switch (envelope.type) {
                    case ClientTypeValues.AUTH_REQUEST:
                        console.log("case ClientTypeValues.AUTH_REQUEST")
                        if (envelope.authRequest) {
                            console.log("envelope.authRequest")
                            await handleLogin(ws, envelope.authRequest);
                        } else if (envelope.regRequest) {
                            console.log("envelope.regRequest")
                            await handleRegister(ws, envelope.regRequest);
                        } else {
                            console.log('Other AUTH_REQUEST content received:', envelope.content);
                        }
                        break;
                    case ClientTypeValues.CLIENT_MESSAGE:
                        if(envelope.reqUserBuckets){
                            // console.log("Received bucket list request from user: ", req.user ? req.user.id : "Unknown");
                            await handleGetUserBucket(ws, envelope.reqUserBuckets, s3Client, req.user ? req.user.id : "Unknown");
                        }                   //      envelope.content
                        if(envelope.addFile){
                            // async function handleAddFile(msg, root, s3Client, BaseMessage, ws)
                            await handleAddFile(ws, envelope.addFile, s3Client, req.user.id);
                        }
                        if(envelope.listRequest){
                            // async function handleAddFile(msg, root, s3Client, BaseMessage, ws)
                            await handleListRequest(ws, envelope.listRequest, s3Client, req.user.id);
                        }
                        if(envelope.deleteFile){
                            await handleDeleteFile(ws, envelope.deleteFile, s3Client, req.user.id);
                        }
                        if(envelope.filesIdsRequest){
                            // console.log("Received filesIdsRequest from user: ", req.user ? req.user.id : "Unknown");
                            await handlefilesIdsRequest(ws, envelope.filesIdsRequest, s3Client, req.user.id);
                        }
                        if(envelope.pathInfRequest){
                            // console.log("Received infoByNetPathRequest from user: ", req.user ? req.user.id : "Unknown");
                            await handlePathInfRequest(ws, envelope.infoByNetPathRequest, s3Client, req.user.id);
                        }
                        console.log(`User ${user.login} is authorized to see files`);
                        // Проверяем, пришел ли запрос на регистрацию
                        console.log('Other CLIENT_MESSAGE content received:', envelope.content);
                        break;

                    default:
                        console.log('Received unknown or unhandled envelope type:', envelope.type);
                        break;
                }
            } catch (error) {
                console.error('Failed to process incoming message:', error);
                sendAuthError(ws, 'Internal server error processing payload.');
            }
        });
    });

    // Слушаем порт 8080 (или 443 для стандартного HTTPS)
    httpsServer.listen(8080, '0.0.0.0', () => {
        console.log('Secure WSS Server running on port 8080');
    });

});

