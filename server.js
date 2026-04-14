
// const https = require('https');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const protobuf = require('protobufjs');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
//const Minio = require('minio');

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

const server = https.createServer({
  cert: fs.readFileSync('cert.pem'),
  key: fs.readFileSync('key.pem') // У вас должен быть еще и файл ключа!
});

const wss = new WebSocket.Server({ server });

server.listen(8080, '0.0.0.0', () => {
    console.log('WSS Server is running on port 8080');
});
// 3. Загрузка Protobuf и запуск WebSocket сервера
/*
protobuf.load("image.proto", (err, root) => {
    console.log("protobuf.load(image.proto, (err, root)) the begin");
    if (err) throw err;
    const ImageMessage = root.lookupType("Picture");
    console.log("protobuf.load(image.proto, (err, root)) the first step");
    // Создаем HTTPS сервер
    //const httpsServer = https.createServer(serverConfig);
    const httpsServer = https.createServer({
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem'),
        minVersion: 'TLSv1.2'//, // Принудительно разрешаем TLS 1.2
    //    ciphers: 'DEFAULT@SECLEVEL=1' 
    });
    console.log("protobuf.load after creating https server");
    // Привязываем WebSocket к HTTPS серверу
    const wss = new WebSocket.Server({ server: httpsServer });
    console.log("protobuf.load after creating new WebSocket.Server");

    // const wss = new WebSocket.Server({ port: 8080 }, () => {
    //   console.log('--- WebSocket Server is running on port 8080 ---');
    // });

    wss.on('connection', (ws) => {
        console.log('Secure Qt Client connected via WSS');

        ws.on('message', async (message) => {
            try {
                // Декодирование Protobuf сообщения
                const decoded = ImageMessage.decode(message);
                const { filename, user_id, image_data } = decoded;

                // Сохранение в Minio
                const objectName = `${Date.now()}_${filename}`;
                await minioClient.putObject('images', objectName, image_data);

                // Сохранение метаданных в MongoDB
                const meta = new ImageMetadata({
                    filename,
                    userId: user_id,
                    minioObjectName: objectName
                });
                await meta.save();

                console.log(`Saved image ${filename} for user ${user_id}`);
                ws.send("Upload successful");
            } catch (e) {
                console.error("Error processing message:", e);
            }
        });
    });


    // Слушаем порт 8080 (или 443 для стандартного HTTPS)
    // httpsServer.listen(8080, '0.0.0.0', () => {
    //     console.log('Secure WSS Server running on port 8080');
    // });

});
*/
