
// const https = require('https');
const https = require('https');
const fs = require('fs');
const WebSocket = require('ws');
const mongoose = require('mongoose');
const protobuf = require('protobufjs');
const { S3Client, CreateBucketCommand, HeadBucketCommand, PutObjectCommand, ListBucketsCommand } = require("@aws-sdk/client-s3");

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

const headCommand = new HeadBucketCommand({ 
    Bucket: "images" 
});

// Создание
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
    const wss = new WebSocket.Server({ server: httpsServer });
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
                    const emaillogin = msg.pict.emailLogin;

                    console.log(" emaillogin = ", emaillogin, " filename= ", filename, "  contentType= ", msg.pict.contenttype,
                        "   images= ", msg.pict.data
                    );
                    const command = new PutObjectCommand({
                        Bucket: 'images',
                        Key: objName,
                        Body: img_data
                    });
                    // Сохранение в Minio
                    const objectName = `${Date.now()}_${filename}`;
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
                if(msg.content === "user"){
                    const listBuckets = new ListBucketsCommand({})
                    const response = await s3Client.send(listBuckets);
                    console.log(response.Buckets)
                    const bucketNames = response.Buckets.map(bucket => bucket.Name);
                    //const names2 = await s3Client.bucketNames()
                    console.log(" names: ", bucketNames, "  names2: ")//, names2)
                    // B) Code in Protobuf
                    // const payload = { buckets: names };
                    // console.log("Buckets: ", payload)
                    // const errMsg = BucketList.verify(payload);
                    // if (errMsg) throw Error(errMsg);
                    const responsePayload = BaseMessage.create({
                        buckets: { bucketNames: bucketNames }
                    });

                    //const buffer = BucketList.encode(BucketList.create(payload)).finish();

                    // C) Send binary data
                    //ws.send(buffer);
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

