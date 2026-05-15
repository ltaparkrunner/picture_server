import { GetObjectCommand, DeleteObjectCommand, PutObjectCommand, ListBucketsCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
import User from './model/User.js';
import protobuf from 'protobufjs';
import dotenv from 'dotenv';
import  sanitize from 'sanitize-filename';
import  path from 'path';

// dotenv.config();
const root = await protobuf.load('image.proto');
const ServerEnvelope = root.lookupType('ServerEnvelope');
//  const ServerType = ServerEnvelope.nested.Type;
const ServerTypeValues = ServerEnvelope.nested.Type.values;
const USERS = process.env.USERS || 'users';
const BUCKET = process.env.BUCKET_NAME || 'images';
//  console.log("process.env.USERS: ", process.env.USERS);

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

export async function handleGetUserBucket(ws, msg, s3Client, user){
    try {
        await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET }));
        const config = await s3Client.config.endpoint();
        const bucketInfo = [{
            bucketName: BUCKET, 
            url: `${config.protocol}//${config.hostname}:${config.port}/${BUCKET}`
        }];
        console.log("bucketInfo: ", BUCKET);
        const responsePayload = {
            type: ServerTypeValues.SERVER_MESSAGE,
            buckets: { bucketInf: bucketInfo}
        };
        sendEnvelope(ws, responsePayload);
    } catch (error) {
        if (error.name === "NotFound" || error.$metadata?.httpStatusCode === 404) {
            const responsePayload = {
                type: ServerTypeValues.SERVER_MESSAGE,
                serverResp: { 
                    content: "Bucket 'images' not found",
                    status: "error"
                }
            };
            sendEnvelope(ws, responsePayload);
        }
        const responsePayload = {
            type: ServerTypeValues.SERVER_MESSAGE,
            serverResp: { 
                content: "Access denied or other error: " + error.message,
                status: "error"
            }
        };
        sendEnvelope(ws, responsePayload); // Other errors (e.g., Access Denied)
    }
}

function sendEnvelope(ws, payloadStructure) {
    if (ws.readyState === ws.OPEN) {
        console.log("function sendEnvelope      payloadStructure.type: ", payloadStructure.type)
        // 1. We check the structure for compliance with the .proto schema
        const errMsg = ServerEnvelope.verify(payloadStructure);
        if (errMsg) throw Error(errMsg);
        // 2. Create a message object
        const message = ServerEnvelope.create(payloadStructure);
        // 3. Serialize to Uint8Array (Protobuf binary format)
        const buffer = ServerEnvelope.encode(message).finish();
        // 4. Sending bytes to a Qt/C++ client
        ws.send(buffer);
    }
}

export async function handleAddFile(ws, msg, s3Client, userId){
    const fileName = msg.fileName;

    const folder = msg.folder;
    const info = msg.info;
    const img_data = Buffer.from(msg.data);

    console.log("Buffer size:", img_data.length);

    const user = await User.findOne({ _id: userId });
    const usrLogin = user ? user.login : "Unknown";

    console.log(" fileName= ", fileName, " usrLogin = ", usrLogin,
        " folder = ", folder, " info = ", info);
    const safefolder = sanitize(folder).replace(/\s+/g, '-');
    const {uniqueName, ext} = prepareFilename(fileName);
    console.log("process.env.USERS: ", process.env.USERS);
    const s3Key = (safefolder) ?  `${USERS}/${userId}/${safefolder}/${uniqueName}` 
                                : `${USERS}/${userId}/${uniqueName}`;

    console.log("uniqueName:", uniqueName, " s3Key= ", s3Key);

    const command = new PutObjectCommand({
        Bucket: BUCKET,
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
        bucket: BUCKET,
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

export async function handleListRequest(ws, msg, s3Client, userId){
    const {/* bucketName, */ folderName, /* userLogin*/ } = msg; 
    console.log("   folderName", folderName); //,  "userLogin", userLogin);

    // 1. We get REAL FILES in the current folder
    const files = await ImageRecord.find({ 
        bucket: BUCKET, 
        folder: folderName 
    }).lean();

    // 2. Finding VIRTUAL SUB-FOLDERS through aggregation
    const prefix = folderName === "" ? "" : (folderName.endsWith('/') ? folderName : folderName + '/');

    const folders = await ImageRecord.aggregate([
        { $match: { bucket: BUCKET, folder: new RegExp(`^${prefix}[^/]+`) } },
        { $project: { 
            // Cut off the current prefix and take only the next path segment
            relativeFolder: { $substr: ["$folder", prefix.length, -1] } 
        }},
        { $project: {
            folderNm: { $arrayElemAt: [{ $split: ["$relativeFolder", "/"] }, 0] }
        }},
        { $group: { _id: "$folderNm" } } // Group to get unique names
    ]);
    console.log("Real folders in folder: ", folders);
    const foldersval = folders.map(({ _id }) => _id);
    const minioPath = "http://minio:9000/" + BUCKET + "/";
    const filesPayload = await Promise.all(files.map(async (file) => {
        // Generate a temporary link directly to Minio
        const command = new GetObjectCommand({
            Bucket: BUCKET,
            Key: file.s3Key
        });
        // The link will be valid for, for example, 1 hour (3600 seconds)
        const signedUrl = await getSignedUrl(s3Client, command, { expiresIn: process.env.S3_REF_EXPIRES || 3600 });

        return {
            fileName: file.originalName,
            mongoId: file._id.toString(),
            url: signedUrl,
            size: file.size || 0
        };
    }));
    // 3. Preparing an array of folders for Protobuf
    const foldersPayload = Array.from(folders).map(folderNm => ({
        folderName: folderNm._id,
        url: minioPath + folderName + folderNm._id + "/"
    }));
    console.log("Prepared folders payload: ", foldersPayload);
    const responsePayload = {
        type: ServerTypeValues.SERVER_MESSAGE,
        listResponse: {
            files: filesPayload,
            folders: foldersPayload
        }
    };
    console.log("Final response payload: ", responsePayload);
    sendEnvelope(ws, responsePayload);
}

export async function  handleDeleteFile(ws, msg, s3Client, userId){
    const fname = msg.fileName

    //  const usrLogin = msg.userLogin
    const mongoId = msg.mongoId
    console.log("deleteFile:  fname = ", fname, 
       /* "usrLogin = ", usrLogin, */ "mongoId = ", mongoId)

    const record = await ImageRecord.findById(mongoId);
    
    if (!record) {
        console.log("Запись не найдена в базе данных");
        throw new Error("Запись не найдена в базе данных");
    }

    const dltFile = new DeleteObjectCommand({
        Bucket: BUCKET,
        Key: record.s3Key
    });
    await s3Client.send(dltFile);
    console.log(`Файл ${record.s3Key} удален из MinIO`);

    // Removing metadata from MongoDB
    await ImageRecord.findByIdAndDelete(mongoId);
    console.log(`Запись ${mongoId} удалена из MongoDB`);
    
    const responsePayload = {
        type: ServerTypeValues.SERVER_MESSAGE,
        serverResp: {         
            content: "delete_file_result",
            status: "success",
        }
    };
    sendEnvelope(ws, responsePayload);
    console.log("Delete document off ", fname, " from ", BUCKET);  
}

function prepareFilename(originalName) {
    const ext = path.extname(originalName);
    const nameOnly = path.basename(originalName, ext);
    console.log("ext: ", ext, "  nameOnly: ", nameOnly);
    // Clear the name and add the UUID
    const safeName = sanitize(nameOnly).replace(/\s+/g, '-').toLowerCase();
    const uniqueName = `${uuidv4()}-${safeName}${ext}`;
    console.log("finalFilename: ", uniqueName, "  ext: ", ext);
    return {uniqueName, ext};
}
