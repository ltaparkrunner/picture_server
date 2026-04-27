import { handleDeleteImage } from './handlers.js';

// const https = require('https');
import https from 'https';
import fs from 'fs';
import { WebSocketServer } from 'ws';
import mongoose from 'mongoose';
import protobuf from 'protobufjs';
import { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, ListBucketsCommand, DeleteObjectCommand} from "@aws-sdk/client-s3";

import { ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Настройки из окружения
const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, MONGO_URL } = process.env;

const serverConfig = {
    key: fs.readFileSync('key.pem'),
    cert: fs.readFileSync('cert.pem')
};

// 1. Подключение к MongoDB
mongoose.connect(MONGO_URL);
const ImageRecord = mongoose.model('ImageRecord', {
  name: String,
  s3Key: String,
  contentType: String,
  createdAt: { type: Date, default: Date.now }
});

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
    Bucket: "pictures" 
});
async function bootstrap() {
    try {
        await s3Client.send(createCommand);
        console.log("Бакет 'images' создан.");
    } catch (err) {
        if (err.Code === 'BucketAlreadyOwnedByYou' || err.Code === 'BucketAlreadyExists') {
            console.log("Бакет 'images' уже существует, пропускаем создание.");
        } else {
            console.error("Ошибка инициализации хранилища:", err);
        }
    }
}

bootstrap(); // performed once
protobuf.load("image.proto", (err, root) => {
    if (err) throw err;
    // Create HTTPS server
    const httpsServer = https.createServer({
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem'),
        minVersion: 'TLSv1.2'// Allow TLS 1.2
    });
    // Bind WebSocket to HTTPS server
    const wss = new WebSocketServer({ server: httpsServer });
    console.log("protobuf.load after creating new WebSocket.Server");

    wss.on('connection', (ws) => {
        console.log('Secure Qt Client connected via WSS');

        ws.on('message', async (message) => {
            try {
                // Decoding Protobuf message
                const BaseMessage = root.lookupType("BaseMessage");
                const msg = BaseMessage.decode(message);

                if(msg.content === "pict"){
                    const objName = msg.pict.filename;
                    const img_data = Buffer.from(msg.pict.data);
                    console.log("Buffer size:", img_data.length);
                    const filename = msg.pict.filename;
                    const userId = msg.pict.userLogin;
                    const bucket = msg.pict.bucketName

                    console.log(" userId = ", userId, " filename= ", filename, "  contentType= ", msg.pict.contenttype,
                        "   images= ", msg.pict.data
                    );
                    const command = new PutObjectCommand({
                        Bucket: bucket,
                        Key: objName,
                        Body: img_data
                    });
                    // Сохранение в Minio
                    const objectName = `${Date.now()}_${filename}`;
                    await s3Client.send(command);

                    // Сохранение метаданных в MongoDB
                    const meta = new ImageRecord({
                        filename,
                        userLogin: userId,//user_id,
                        minioObjectName: objectName
                    });
                    await meta.save();

                    console.log(`Saved image ${filename} for user ${emaillogin}`);
                    ws.send("Upload successful");
                }
                if(msg.content === 'listRequest') {
                    const bucketName = msg.listRequest.bucketName;
                    //const bucketName = 'images';
                    console.log("msg.listRequest.count = ", msg.listRequest.count, "msg.listRequest.bucketName = ", msg.listRequest.bucketName);
                    const command = new ListObjectsV2Command({
                        Bucket: bucketName,
                        MaxKeys: msg.listRequest.count // В нашем случае 6
                    });

                    const { Contents } = await s3Client.send(command);
                    const imageInfos = await Promise.all((Contents || []).map(async (file) => {
                        const getCommand = new GetObjectCommand({ Bucket: bucketName, Key: file.Key });
                        const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
                        return { filename: file.Key, url: url };
                    }));
                    //  console.log("imageInfos = ", imageInfos);

                    const responsePayload = BaseMessage.create({
                        listResponse: { images: imageInfos }
                    });
                    console.log("responsePayload = ", responsePayload);
                    ws.send(BaseMessage.encode(responsePayload).finish());
                }
                if(msg.content === "reqUserBuckets"){
                    const listBuckets = new ListBucketsCommand({})
                    const response = await s3Client.send(listBuckets);
                    //  console.log(response.Buckets)
                    const config = await s3Client.config.endpoint();

                    const bucketInfo = response.Buckets.map(bucket => {
                        return {bucketName: bucket.Name, 
                            url: `${config.protocol}//${config.hostname}:${config.port}/${bucket.Name}`};
                    });
                    //  console.log(" bucketInfo: ", bucketInfo)//, names2)
                    //  const bucketUrl = `${s3Client.protocol}//${s3Client.host}:${s3Client.port}/${bucketName}`;
                    const responsePayload = BaseMessage.create({
                        buckets: { bucketInf: bucketInfo }
                    });
                    ws.send(BaseMessage.encode(responsePayload).finish());
                }
                if(msg.content === "deleteImage"){
                    await handleDeleteImage(msg, root, s3Client);
                }

            } catch (e) {
                console.error("Error processing message:", e);
            }
        });
    });

    // Слушаем порт 8080 (или 443 для стандартного HTTPS)
    httpsServer.listen(8080, '0.0.0.0', () => {
        console.log('Secure WSS Server running on port 8080');
    });

});

