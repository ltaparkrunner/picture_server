
// const https = require('https');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const protobuf = require('protobufjs');
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const { ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

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
//    endpoint: "http://127.0.0.1:9000",
  region: "us-east-1", // Для MinIO любое значение
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true // Обязательно для MinIO
});

const s3Clientexternal = new S3Client({
//  endpoint: 'localhost',
    endpoint: "http://127.0.0.1:9000",
  region: "us-east-1", // Для MinIO любое значение
  credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
  forcePathStyle: true, // Обязательно для MinIO
  useSSL: false
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

const headCommand = new HeadBucketCommand({ 
    Bucket: "images" 
});

// Создание
const createCommand = new CreateBucketCommand({ 
    Bucket: "images" 
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

// bootstrap(); // Выполняется один раз

protobuf.load("image.proto", (err, root) => {
    if (err) throw err;
    // Создаем HTTPS сервер
    //const httpsServer = https.createServer(serverConfig);
    const httpsServer = https.createServer({
        key: fs.readFileSync('./key.pem'),
        cert: fs.readFileSync('./cert.pem'),
        minVersion: 'TLSv1.2'//, // Принудительно разрешаем TLS 1.2
    //    ciphers: 'DEFAULT@SECLEVEL=1' 
    });
    // Привязываем WebSocket к HTTPS серверу
    const wss = new WebSocket.Server({ server: httpsServer });
    console.log("protobuf.load after creating new WebSocket.Server");

    wss.on('connection', (ws) => {
        console.log('Secure Qt Client connected via WSS');

        ws.on('message', async (message) => {
            try {
                // Декодирование Protobuf сообщения
                const BaseMessage = root.lookupType("BaseMessage");
                const msg = BaseMessage.decode(message);

                if(msg.content === "pict"){
                    //  console.log("message: after if(msg.content === pict){", msg.content);
                    //  const ImageMessage = root.lookupType("Picture");
                    //  console.log("after const ImageMessage = root.lookupType(PictureServer);", msg.pict.filename);
                    //  const decoded = ImageMessage.decode(msg.pict);
                    //  const decoded = msg.pict;
                    const objName = msg.pict.filename;
                    const img_data = Buffer.from(msg.pict.data);
                    console.log("Buffer size:", img_data.length);
                    const filename = msg.pict.filename;
                    const emaillogin = msg.pict.emailLogin;

                    console.log(" emaillogin = ", emaillogin, " filename= ", filename, "  contentType= ", msg.pict.contenttype,
                        "   images= ", msg.pict.data
                    );
                    //const { emaillogin, filename, data, contentType, timestamp /*user_id, image_data*/ } = decoded;

                    const command = new PutObjectCommand({
                        Bucket: 'images',
                        Key: objName,
                        Body: img_data
                    });
                    // Сохранение в Minio
                    const objectName = `${Date.now()}_${filename}`;
    //                await minioClient.putObject('images', objectName, data/*image_data*/);
                    await s3Client.send(command);

                    // Сохранение метаданных в MongoDB
                    const meta = new ImageRecord({
                        filename,
                        emaillogin: emaillogin,//user_id,
                        minioObjectName: objectName
                    });
                    await meta.save();

                    console.log(`Saved image ${filename} for user ${emaillogin}`);
                    ws.send("Upload successful");
                }
                if(msg.content === 'listRequest') {
                    const bucketName = 'images';
                    console.log("msg.listRequest.count = ", msg.listRequest.count);
                    const command = new ListObjectsV2Command({
                        Bucket: bucketName,
                        MaxKeys: msg.listRequest.count // В 0нашем случае 6
                    });

                    const { Contents } = await s3Client.send(command);
                    
                    const imageInfos = await Promise.all((Contents || []).map(async (file) => {
                        const getCommand = new GetObjectCommand({ Bucket: bucketName, Key: file.Key });
                        const url = await getSignedUrl(s3Client, getCommand, { expiresIn: 3600 });
                        //const publicUrl = url.replace("http://minio:9000", "http://localhost:9000");
                        return { filename: file.Key, url: url };
                    }));
                    console.log("imageInfos = ", imageInfos);
                    // Формируем ответ
                    const responsePayload = BaseMessage.create({
                        listResponse: { images: imageInfos }
                    });
                    console.log("responsePayload = ", responsePayload);
                    ws.send(BaseMessage.encode(responsePayload).finish());
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

