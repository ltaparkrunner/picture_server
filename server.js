
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const protobuf = require('protobufjs');
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// Настройки из окружения
const { S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, MONGO_URL } = process.env;

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

const server = http.createServer();
const io = new Server(server);

// 3. Загрузка Protobuf и запуск логики
protobuf.load("image.proto", (err, root) => {
  if (err) throw err;
  const Picture = root.lookupType("Picture");

  io.on('connection', (socket) => {
    socket.on('upload_image', async (buffer) => {
      try {
        // Десериализация
        const msg = Picture.decode(new Uint8Array(buffer));
        const { fileName, data, contentType } = Picture.toObject(msg);
        
        const s3Key = `${Date.now()}-${fileName}`;

        // А) Загрузка в MinIO
        await s3Client.send(new PutObjectCommand({
          Bucket: S3_BUCKET,
          Key: s3Key,
          Body: data,
          ContentType: contentType
        }));

        // Б) Запись в MongoDB
        const record = new ImageRecord({ name: fileName, s3Key, contentType });
        await record.save();

        socket.emit('status', { success: true, s3Key });
        console.log(`Uploaded to MinIO & Saved to DB: ${fileName}`);
      } catch (e) {
        console.error(e);
        socket.emit('status', { success: false, error: e.message });
      }
    });
  });
});

server.listen(3000, () => console.log('Server running on :3000'));
