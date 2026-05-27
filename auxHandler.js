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
const S3_ENDPOINT = process.S3_ENDPOINT || 'http://minio:9000/'
//  console.log("process.env.USERS: ", process.env.USERS);

export async function handleGetUserBuckets(ws, msg, s3Client, user){
    const listBuckets = new ListBucketsCommand({})
    const response = await s3Client.send(listBuckets);
    //  console.log(resp14onse.Buckets)
    const config = await s3Client.config.endpoint();

    const bucketInfo = response.Buckets.map(bucket => {
        return {bucketName: bucket.Name, 
            url: `${config.protocol}//${config.hostname}:${config.port}/${bucket.Name}/`};
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

    const folderName = msg.folder;
    const info = msg.info;
    const img_data = Buffer.from(msg.data);

    console.log("Buffer size:", img_data.length);

    const user = await User.findOne({ _id: userId });
    const usrLogin = user ? user.login : "Unknown";

    console.log(" fileName= ", fileName, " usrLogin = ", usrLogin,
        " folder = ", folderName, " info = ", info);

    const userBasePath = `${USERS}/${userId}/`;
    const targetFolder = folderName === "" 
        ? userBasePath 
//        : `${userBasePath}${sanitize(folderName).replace(/^\/+|\/+$/g, '')}/`;
        : `${userBasePath}${sanitizeToPath(folderName)}/`;
    //const safefolder = sanitize(folder).replace(/\s+/g, '-');
    const {uniqueName, ext} = prepareFilename(fileName);
    console.log("process.env.USERS: ", process.env.USERS);
    const s3Key = `${targetFolder}${uniqueName}` 
    console.log("uniqueName:", uniqueName, " s3Key= ", s3Key, " targetFolder: ", targetFolder, " ext: ", ext);

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
        folder: targetFolder,
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
    const {folderName} = msg; 
    console.log("function handleListRequest folderName", folderName); //,  "userLogin", userLogin);

    const userBasePath = `${USERS}/${userId}/`;
    const targetFolder = folderName === "" 
        ? userBasePath 
        : `${userBasePath}${sanitizeToPath(folderName)}/`;
    console.log("targetFolder: ", targetFolder, "  BUCKET: ", BUCKET);
    // 1. We get REAL FILES in the user's target folder
    const files = await ImageRecord.find({ 
        bucket: BUCKET, 
        folder: targetFolder 
    }).lean();
    console.log("Real files in folder: ", files, " targetFolder: ", targetFolder);
    // 2. Finding VIRTUAL user's SUB-FOLDERS through aggregation
    const folders = await ImageRecord.aggregate([
        { $match: { bucket: BUCKET, folder: new RegExp(`^${targetFolder}[^/]+`) } },
        { $project: { 
            // Cut off the current prefix and take only the next path segment
            relativeFolder: { $substr: ["$folder", targetFolder.length, -1] } 
        }},
        { $project: {
            folderNm: { $arrayElemAt: [{ $split: ["$relativeFolder", "/"] }, 0] }
        }},
        { $group: { _id: "$folderNm" } } // Group to get unique names
    ]);
    //console.log("targetFolder: ", targetFolder);
    console.log("Real folders in folder: ", folders);
    //  const foldersval = folders.map(({ _id }) => _id);
    const minioPath = "http://minio:9000/" + BUCKET + "/";
    const filesPayload = await Promise.all(files.map(async (file) => {
        // Generate a temporary link directly to Minio
        const command = new GetObjectCommand({
            Bucket: BUCKET,
            Key: file.s3Key
        });
        // The link will be valid for, for example, 1 hour (3600 seconds)
        const signedUrl = await getSignedUrl(s3Client, command, { 
            expiresIn: process.env.S3_REF_EXPIRES || 3600 });

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
        url: `${minioPath}${targetFolder}${folderNm._id}/`
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

export async function handlefilesIdsRequest(ws, msg, s3Client, userId){
    const ids = msg.mongoIds; // Array of MongoDB IDs
    const filesPayload = await Promise.all(ids.map(async (id) => {
        console.log("Processing ID: ", id);
        const record = await ImageRecord.findById(id);
        if (record) {
            const command = new GetObjectCommand({
                Bucket: BUCKET,
                Key: record.s3Key
            });
            const signedUrl = await getSignedUrl(s3Client, command, { 
                expiresIn: process.env.S3_REF_EXPIRES || 360 
            });
            return {
                    fileName: record.originalName,
                    mongoId: record._id.toString(),
                    url: signedUrl,
                    size: record.size || 0
                }
        }   else {              
            console.log(`Record with ID ${id} not found in MongoDB`);   
                return{
                    fileName: "",
                    mongoId: id.toString(),
                    url: "",
                    size: 0
                }          
        } 
    }));
    const responsePayload = {
        type: ServerTypeValues.SERVER_MESSAGE,
        filesIdsResponse: {
            files: filesPayload // This will be filled with file info objects
        }
    };
    sendEnvelope(ws, responsePayload);      
}

export async function handlePathInfRequest(ws, msg, s3Client, userId){
    console.log("handlePathInfRequest  msg.netPath: ", msg.netPath, " userId: ", userId);
    const prefix = `${USERS}/${userId}/`;
    const inputPath = msg.netPath;

    // 1. Ensure the path starts with the required prefix
    let formattedPath = msg.netPath;
//    if (!formattedPath.includes(prefix)) {
    if (!formattedPath.startsWith(prefix)) {
        formattedPath = prefix + formattedPath;
    }

    const isExplicitFolder = formattedPath.endsWith('/');
    const escapeRegex = (str) => str.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    // Если путь заканчивается на '/', это может быть ТОЛЬКО папка
    if (isExplicitFolder) {
//        const query = { folder: { $regex: `^${escapeRegex(formattedPath)}` } };
        const query = { folder: { $regex: `^${sanitizeToPath(formattedPath)}` } };
        const doc = await ImageRecord.findOne(query, { projection: { _id: 1 } });
        if(doc) {
            console.log("formattedPath: ", formattedPath, " sanitizeToPath(formattedPath): ", sanitizeToPath(formattedPath))
            await handleListRequest(ws, {folderName: inputPath}/*inputPath formattedPathor msg*/, s3Client, userId)
            const responsePayload = {
                type: ServerTypeValues.SERVER_MESSAGE,
                pathInfResponse: {         
//                    netPath: escapeRegex(formattedPath),
                    netPath: `${S3_ENDPOINT}${BUCKET}/${sanitizeToPath(formattedPath)}/`,
                    netStorePath: "",
                    result: "folder"
                }
            };
            sendEnvelope(ws, responsePayload);
            return
        } else {
            const responsePayload = {
                type: ServerTypeValues.SERVER_MESSAGE,
                serverResp: { 
                    content: "The path does not exist:" + formattedPath,
                    status: "error"
                }
            };
            sendEnvelope(ws, responsePayload);
        }
        return;
    }
    const folderWithSlash = `${formattedPath}/`;
//    const folderQuery = { folder: { $regex: `^${escapeRegex(folderWithSlash)}` } };
    const folderQuery = { folder: { $regex: `^${sanitizeToPath(folderWithSlash)}` } };
    const folderDoc = await ImageRecord.findOne(folderQuery, { projection: { _id: 1 } });
    if (folderDoc){
        await handleListRequest(ws, {folderName: inputPath}/*inputPath or msg*/, s3Client, userId)
        const responsePayload = {
            type: ServerTypeValues.SERVER_MESSAGE,
            pathInfResponse: {         
                netPath: `${S3_ENDPOINT}${BUCKET}/${sanitizeToPath(formattedPath)}/`,
//                netPath: S3_ENDPOINT+sanitizeToPath(formattedPath),
                netStorePath: "",
                result: "folder"
            }
        };
        sendEnvelope(ws, responsePayload);
        return
    }

    const fileQuery = {
        $or: [
            { s3Key: formattedPath },
            {
                $expr: {
                    $eq: [
                        { $concat: ["$folder", "$originalName"] },
                        formattedPath
                    ]
                }
            }
        ]
    };
    const fileDoc = await ImageRecord.findOne(fileQuery, { projection: { _id: 1 } });
    
    if (fileDoc) {
        const command = new GetObjectCommand({
            Bucket: BUCKET,
            Key: record.s3Key
        });
        const signedUrl = await getSignedUrl(s3Client, command, { 
            expiresIn: process.env.S3_REF_EXPIRES || 360 
        });
        const responsePayload = {
            type: ServerTypeValues.SERVER_MESSAGE,
            filesIdsResponse: {
                files: {
                    fileName: fileDoc.originalName,
                    mongoId: fileDoc._id.toString(),
                    url: signedUrl,
                    size: fileDoc.size || 0     
                } // This will be filled with file info objects
            }
        };
        sendEnvelope(ws, responsePayload);
        return;
    }

    const responsePayload = {
        type: ServerTypeValues.SERVER_MESSAGE,
        serverResp: { 
            content: "The path does not exist:" + formattedPath,
            status: "error"
        }
    };
    sendEnvelope(ws, responsePayload);
    return;
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

function sanitizeToPath(input) {
    // 1. Replace backslashes with forward slashes
    let path = input.replace(/\\/g, '/');
    
    // 2. Collapse multiple slashes into a single slash
    path = path.replace(/\/+/g, '/');
    
    // 3. Trim leading and trailing slashes
    path = path.replace(/^\/+|\/+$/g, '');
    
    // 4. Sanitize each individual segment to protect the filesystem
    return path
      .split('/')
      .map(segment => sanitize(segment))
      .filter(segment => segment.length > 0) // Remove any empty segments created by sanitization
      .join('/');
}