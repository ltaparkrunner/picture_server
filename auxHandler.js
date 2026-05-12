import { GetObjectCommand, DeleteObjectCommand, PutObjectCommand, ListBucketsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
import User from './model/User.js';
import protobuf from 'protobufjs';
import dotenv from 'dotenv';

dotenv.config();
const root = await protobuf.load('image.proto');
const ServerEnvelope = root.lookupType('ServerEnvelope');
//  const ServerType = ServerEnvelope.nested.Type;
const ServerTypeValues = ServerEnvelope.nested.Type.values;

export async function handleGetUserBuckets(ws, msg, s3Client, user){
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

// Функция сборки и отправки ServerEnvelope с ошибкой в AuthResponse
function sendAuthError(ws, errorMessage) {
    const responsePayload = {
        type: ServerTypeValues.AUTH_RESPONSE,
        authResponse: {
            token: "",
            error: errorMessage
        }
    };
    sendEnvelope(ws, responsePayload);
}
