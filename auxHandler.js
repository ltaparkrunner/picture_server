import { GetObjectCommand, DeleteObjectCommand, PutObjectCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
import User from './model/User.js';
import protobuf from 'protobufjs';
import dotenv from 'dotenv';
import  sanitize from 'sanitize-filename';
import  path from 'path';

dotenv.config();
const root = await protobuf.load('image.proto');
const ServerEnvelope = root.lookupType('ServerEnvelope');
//  const ServerType = ServerEnvelope.nested.Type;
const ServerTypeValues = ServerEnvelope.nested.Type.values;
const USERS = 'users';

export async function handleGetUserBuckets(ws, msg, s3Client, user){
    const listBuckets = new ListBucketsCommand({})
    const response = await s3Client.send(listBuckets);
    //  console.log(resp14onse.Buckets)
    const config = await s3Client.config.endpoint();

    const bucketInfo = response.Buckets.map(bucket => {
        return {bucketName: bucket.Name, 
            url: `${config.protocol}//${config.hostname}:${config.port}/${bucket.Name}`};
    });
    //  console.log(" bucketInfo: ", bucketInfo)//, names2)
    //  const bucketUrl = `${s3Client.protocol}//${s3Client.host}:${s3Client.port}/${bucketName}`;
    console.log("bucketInfo: ", bucketInfo);
    const responsePayload = {
        type: ServerTypeValues.SERVER_MESSAGE,
        buckets: { bucketInf: bucketInfo }
    };
    sendEnvelope(ws, responsePayload);
}

// Общая функция сериализации и отправки данных по сети
function sendEnvelope(ws, payloadStructure) {
    if (ws.readyState === ws.OPEN) {
        console.log("function sendEnvelope      payloadStructure.type: ", payloadStructure.type)
        // 1. Проверяем структуру на соответствие .proto схеме
        const errMsg = ServerEnvelope.verify(payloadStructure);
        if (errMsg) throw Error(errMsg);

        // 2. Создаем объект сообщения
        const message = ServerEnvelope.create(payloadStructure);

        // 3. Сериализуем в Uint8Array (бинарный формат Protobuf)
        const buffer = ServerEnvelope.encode(message).finish();

        // 4. Отправляем байты клиенту Qt/C++
        ws.send(buffer);
    }
}

// Функция сборки и отправки ServerEnvelope с ошибкой в ServerResponse
function sendAuthError(ws, errorMessage) {
    const responsePayload = {
        type: ServerTypeValues.SERVER_MESSAGE,
        authResponse: {
            token: "",
            error: errorMessage
        }
    };
    sendEnvelope(ws, responsePayload);
}


export async function handleAddFile(ws, msg, s3Client, userId){
    const fileName = msg.fileName;
//    const usrLogin = msg.addFile.userLogin;
    const bucket = msg.bucketName;
    const folder = msg.folder;
    const info = msg.info;
    const img_data = Buffer.from(msg.data);

    console.log("Buffer size:", img_data.length);

    const user = await User.findOne({ _id: userId });
    const usrLogin = user ? user.login : "Unknown";

    console.log(" fileName= ", fileName, " usrLogin = ", usrLogin, " bucket = ", bucket, 
        " folder = ", folder, " info = ", info);
    const safefolder = sanitize(folder).replace(/\s+/g, '-');
    const {uniqueName, ext} = prepareFilename(fileName);
    const s3Key = (safefolder) ?  `${USERS}/${userId}/${safefolder}/${uniqueName}` 
                                : `${USERS}/${userId}/${uniqueName}`;

    console.log("uniqueName:", uniqueName, " s3Key= ", s3Key);

    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: img_data
    });

    await s3Client.send(command);
    console.log(" s3Client.send(command) successful ", s3Key);
    // Сохранение метаданных в MongoDB
    const meta = new ImageRecord({
        name: uniqueName,
        originalName: fileName,
        folder: safefolder,
        s3Key: s3Key,
        bucket: bucket,
        userLogin: usrLogin,
        info: {type : ext},
        size: img_data.length    
    });
    const savedMeta = await meta.save();

    console.log(`Saved image ${uniqueName} for user ${usrLogin} with ID: ${savedMeta._id}`);

    const responsePayload = {
        type: ServerTypeValues.SERVER_MESSAGE,
        serverResp: {         
            content: "upload_result",
            status: "success",
        }
    };

    sendEnvelope(ws, responsePayload);
}


function prepareFilename(originalName) {
    const ext = path.extname(originalName); // .jpg
    const nameOnly = path.basename(originalName, ext); // photo
    console.log("ext: ", ext, "  nameOnly: ", nameOnly);
    // Очищаем имя и добавляем UUID
    const safeName = sanitize(nameOnly).replace(/\s+/g, '-').toLowerCase();
    const uniqueName = `${uuidv4()}-${safeName}${ext}`;
    console.log("finalFilename: ", uniqueName, "  ext: ", ext);
    return {uniqueName, ext};
}
