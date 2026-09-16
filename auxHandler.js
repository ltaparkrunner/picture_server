import { GetObjectCommand, DeleteObjectCommand, PutObjectCommand, ListBucketsCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
import User from './model/User.js';
import sanitize from 'sanitize-filename';
import path from 'path';

const USERS = process.env.USERS || 'users';
const BUCKET = process.env.BUCKET_NAME || 'images';

// Вспомогательные функции (предполагается, что они объявлены ниже в вашем файле)
// sanitizeToPath, prepareFilename оставляем без изменений.

export async function handleGetUserBuckets(req, res, s3Client) {
    try {
        const listBuckets = new ListBucketsCommand({});
        const response = await s3Client.send(listBuckets);
        const config = await s3Client.config.endpoint();

        const bucketInfo = response.Buckets.map(bucket => {
            return {
                bucketName: bucket.Name, 
                url: `${config.protocol}//${config.hostname}:${config.port}/${bucket.Name}/`
            };
        });

        console.log("bucketInfo: ", bucketInfo);
        
        // Возвращаем чистый JSON вместо Protobuf-конверта
        return res.status(200).json({
            status: "success",
            buckets: { bucketInf: bucketInfo }
        });
    } catch (error) {
        console.error("Error fetching buckets:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
}

export async function handleGetUserBucket(req, res, s3Client) {
    try {
        await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET }));
        const config = await s3Client.config.endpoint();
        const bucketInfo = [{
            bucketName: BUCKET, 
            url: `${config.protocol}//${config.hostname}:${config.port}/${BUCKET}/`
        }];
        console.log("bucketInfo: ", BUCKET);
        
        return res.status(200).json({
            status: "success",
            buckets: { bucketInf: bucketInfo }
        });
    } catch (error) {
        const isNotFound = error.name === "NotFound" || error.$metadata?.httpStatusCode === 404;
        const message = isNotFound ? `Bucket '${BUCKET}' not found` : "Access denied or other error: " + error.message;
        const statusCode = isNotFound ? 404 : 403;

        console.log("Response error path: ", message);
        return res.status(statusCode).json({
            status: "error",
            message: message
        });
    }
}

export async function handleAddFile(req, res, s3Client) {
    try {
        // Данные теперь берем из req.body (присланный JSON)
        const { fileName, folder, info, data } = req.body; 
        // id и login юзера берем из нашей middleware авторизации (req.user)
        const userId = req.user.id;
        const usrLogin = req.user.login || "Unknown";

        // Если файл передается в формате Base64 строки (стандарт для JSON)
        const img_data = Buffer.from(data, 'base64');

        console.log("Buffer size:", img_data.length);
        console.log(" fileName= ", fileName, " usrLogin = ", usrLogin, " folder = ", folder, " info = ", info);

        const userBasePath = `${USERS}/${userId}`;

        const targetFolder = folder.startsWith(userBasePath) 
            ? (folder.endsWith('/') ? folder : folder + '/') 
            : (folder === '' 
                ? `${userBasePath}/` 
                : `${userBasePath}/${sanitizeToPath(folder)}/`);
            
        const { uniqueName, ext } = prepareFilename(fileName);
        const s3Key = `${targetFolder}${uniqueName}`;
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
            info: { type: ext },
            size: img_data.length    
        });
        const savedMeta = await meta.save();

        console.log(`Saved image ${uniqueName} for user ${usrLogin} with ID: ${savedMeta._id}`);

        return res.status(201).json({
            status: "success",
            content: "upload_result"
        });

    } catch (error) {
        console.error("Error adding file:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
}

// import { GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
// import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
// import ImageRecord from "./model/ImageRecord.js";

// const USERS = process.env.USERS || 'users';
// const BUCKET = process.env.BUCKET_NAME || 'images';

export async function handleListRequest(req, res, s3Client) {
    try {
        // Данные берем из тела HTTP-запроса (JSON)
        let { folderName } = req.body; 
        const userId = req.user.id;

        console.log("function handleListRequest folderName", folderName);
        
        if (folderName && folderName.endsWith('/')) {
            folderName = folderName.slice(0, -1);
        }
        
        const userBasePath = `${USERS}/${userId}`;

        const targetFolder = folderName.startsWith(userBasePath) 
          ? (folderName.endsWith('/') ? folderName : folderName + '/') 
          : (folderName === '' 
              ? `${userBasePath}/` 
              : `${userBasePath}/${sanitizeToPath(folderName)}/`);
        
        console.log("targetFolder: ", targetFolder, "  BUCKET: ", BUCKET);

        // 1. Получаем реальные файлы в папке пользователя
        const files = await ImageRecord.find({ 
            bucket: BUCKET, 
            folder: targetFolder 
        }).lean();
        console.log("Real files in folder: ", files, " targetFolder: ", targetFolder);

        // 2. Поиск виртуальных подпапок пользователя через агрегацию
        const folders = await ImageRecord.aggregate([
            { $match: { bucket: BUCKET, folder: new RegExp(`^${targetFolder}[^/]+`) } },
            { $project: { 
                relativeFolder: { $substr: ["$folder", targetFolder.length, -1] } 
            }},
            { $project: {
                folderNm: { $arrayElemAt: [{ $split: ["$relativeFolder", "/"] }, 0] }
            }},
            { $group: { _id: "$folderNm" } }
        ]);
        
        console.log("Real folders in folder: ", folders);

        const minioPath = "http://minio:9000/" + BUCKET + "/";
        const filesPayload = await Promise.all(files.map(async (file) => {
            const command = new GetObjectCommand({
                Bucket: BUCKET,
                Key: file.s3Key
            });
            const signedUrl = await getSignedUrl(s3Client, command, { 
                expiresIn: parseInt(process.env.S3_REF_EXPIRES) || 3600 
            });

            return {
                fileName: file.originalName,
                mongoId: file._id.toString(),
                url: signedUrl,
                size: file.size || 0
            };
        }));
        
        // 3. Формируем массив папок для JSON ответа
        const foldersPayload = Array.from(folders).map(folderNm => ({
            folderName: folderNm._id,
            url: folderName === "" ? `${minioPath}${folderNm._id}/` : `${minioPath}${folderName}/${folderNm._id}/`
        }));
        
        console.log("Prepared folders payload: ", foldersPayload);
        
        // Возвращаем чистый JSON
        return res.status(200).json({
            status: "success",
            listResponse: {
                files: filesPayload,
                folders: foldersPayload
            }
        });
    } catch (error) {
        console.error("Error in handleListRequest:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
}

export async function handleDeleteFile(req, res, s3Client) {
    try {
        // Данные берем из req.body
        const { fileName: fname, mongoId } = req.body;
        console.log("deleteFile: fname = ", fname, "mongoId = ", mongoId);

        const record = await ImageRecord.findById(mongoId);
        
        if (!record) {
            console.log("Запись не найдена в базе данных");
            return res.status(404).json({ status: "error", message: "Запись не найдена в базе данных" });
        }

        const dltFile = new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: record.s3Key
        });
        await s3Client.send(dltFile);
        console.log(`Файл ${record.s3Key} удален из MinIO`);

        // Удаление метаданных из MongoDB
        await ImageRecord.findByIdAndDelete(mongoId);
        console.log(`Запись ${mongoId} удалена из MongoDB`);
        
        return res.status(200).json({
            status: "success",
            content: "delete_file_result"
        });
    } catch (error) {
        console.error("Error in handleDeleteFile:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
}

export async function handlefilesIdsRequest(req, res, s3Client) {
    try {
        // Ожидаем массив mongoIds из тела запроса
        const ids = req.body.mongoIds; 
        
        if (!ids || !Array.isArray(ids)) {
            return res.status(400).json({ status: "error", message: "Invalid or missing mongoIds array" });
        }

        const filesPayload = await Promise.all(ids.map(async (id) => {
            console.log("Processing ID: ", id);
            const record = await ImageRecord.findById(id);
            if (record) {
                const command = new GetObjectCommand({
                    Bucket: BUCKET,
                    Key: record.s3Key
                });
                const signedUrl = await getSignedUrl(s3Client, command, { 
                    expiresIn: parseInt(process.env.S3_REF_EXPIRES) || 360 
                });
                return {
                    fileName: record.originalName,
                    mongoId: record._id.toString(),
                    url: signedUrl,
                    size: record.size || 0
                };
            } else {              
                console.log(`Record with ID ${id} not found in MongoDB`);   
                return {
                    fileName: "",
                    mongoId: id.toString(),
                    url: "",
                    size: 0
                };          
            } 
        }));

        return res.status(200).json({
            status: "success",
            filesIdsResponse: {
                files: filesPayload
            }
        });
    } catch (error) {
        console.error("Error in handlefilesIdsRequest:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
}

// import { GetObjectCommand } from "@aws-sdk/client-s3";
// import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
// import { v4 as uuidv4 } from 'uuid';
// import sanitize from 'sanitize-filename';
// import path from 'path';
// import ImageRecord from "./model/ImageRecord.js";

// const USERS = process.env.USERS || 'users';
// const BUCKET = process.env.BUCKET_NAME || 'images';
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://minio:9000/';

// --- ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ СБОРА СОДЕРЖИМОГО ПАПКИ ---
// Нужна, чтобы не дублировать код между handleListRequest и handlePathInfRequest
async function getFolderContents(targetFolder, folderName, s3Client) {
    const files = await ImageRecord.find({ bucket: BUCKET, folder: targetFolder }).lean();
    
    const folders = await ImageRecord.aggregate([
        { $match: { bucket: BUCKET, folder: new RegExp(`^${targetFolder}[^/]+`) } },
        { $project: { relativeFolder: { $substr: ["$folder", targetFolder.length, -1] } }},
        { $project: { folderNm: { $arrayElemAt: [{ $split: ["$relativeFolder", "/"] }, 0] } }},
        { $group: { _id: "$folderNm" } }
    ]);

    const minioPath = `${S3_ENDPOINT}${BUCKET}/`;
    
    const filesPayload = await Promise.all(files.map(async (file) => {
        const command = new GetObjectCommand({ Bucket: BUCKET, Key: file.s3Key });
        const signedUrl = await getSignedUrl(s3Client, command, { 
            expiresIn: parseInt(process.env.S3_REF_EXPIRES) || 3600 
        });
        return {
            fileName: file.originalName,
            mongoId: file._id.toString(),
            url: signedUrl,
            size: file.size || 0
        };
    }));

    const foldersPayload = Array.from(folders).map(folderNm => ({
        folderName: folderNm._id,
        url: folderName === "" ? `${minioPath}${folderNm._id}/` : `${minioPath}${folderName}/${folderNm._id}/`
    }));

    return { files: filesPayload, folders: foldersPayload };
}

// --- ОСНОВНОЙ ЭНДПОИНТ ---
export async function handlePathInfRequest(req, res, s3Client) {
    try {
        const { netPath: inputPath } = req.body;
        const userId = req.user.id;

        console.log("handlePathInfRequest msg.netPath: ", inputPath, " userId: ", userId);
        const prefix = `${USERS}/${userId}`;

        let formattedPath = inputPath;
        if (!formattedPath.startsWith(prefix)) {
            if (formattedPath.startsWith(USERS)) { 
                formattedPath = prefix + formattedPath.substring(USERS.length); 
            } else {
                formattedPath = prefix + '/' + formattedPath;
            }
        }

        console.log("Formatted path after prefix check: ", formattedPath);
        const isExplicitFolder = formattedPath.endsWith('/');

        // 1. Если путь явно заканчивается на '/'
        if (isExplicitFolder) {
            const query = { folder: { $regex: `^${sanitizeToPath(formattedPath)}` } };
            const doc = await ImageRecord.findOne(query, { _id: 1 });
            
            if (doc) {
                // Вместо отправки двух сообщений в сокет, собираем данные папки и отдаем в одном HTTP-ответе
                const folderContents = await getFolderContents(formattedPath, inputPath, s3Client);
                return res.status(200).json({
                    status: "success",
                    result: "folder",
                    netPath: `${S3_ENDPOINT}${BUCKET}/${inputPath}`,
                    netStorePath: "",
                    listResponse: folderContents // Вкладываем содержимое папки
                });
            } else {
                return res.status(200).json({
                    status: "success",
                    result: "not exist",
                    netPath: `${S3_ENDPOINT}${BUCKET}/${inputPath}/`,
                    netStorePath: ""
                });
            }
        }

        // 2. Проверка, является ли путь папкой БЕЗ косой черты на конце
        const folderWithSlash = `${formattedPath}/`;
        const folderQuery = { folder: { $regex: `^${sanitizeToPath(folderWithSlash)}` } };
        const folderDoc = await ImageRecord.findOne(folderQuery, { _id: 1 });

        if (folderDoc) {
            const folderContents = await getFolderContents(folderWithSlash, inputPath, s3Client);
            return res.status(200).json({
                status: "success",
                result: "folder",
                netPath: `${S3_ENDPOINT}${BUCKET}/${inputPath}/`,
                netStorePath: "",
                listResponse: folderContents
            });
        }

        // 3. Проверка, является ли путь файлом
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
        const fileDoc = await ImageRecord.findOne(fileQuery);
        
        if (fileDoc) {
            const command = new GetObjectCommand({
                Bucket: BUCKET,
                Key: fileDoc.s3Key // Исправлено: в исходнике была опечатка (record.s3Key вместо fileDoc.s3Key)
            });
            const signedUrl = await getSignedUrl(s3Client, command, { 
                expiresIn: parseInt(process.env.S3_REF_EXPIRES) || 360 
            });

            return res.status(200).json({
                status: "success",
                result: "file",
                filesIdsResponse: {
                    files: {
                        fileName: fileDoc.originalName,
                        mongoId: fileDoc._id.toString(),
                        url: signedUrl,
                        size: fileDoc.size || 0     
                    }
                }
            });
        }

        // 4. Если ничего не найдено
        return res.status(200).json({
            status: "success",
            result: "not exist",
            netPath: `${S3_ENDPOINT}${BUCKET}/${inputPath}/`,
            netStorePath: ""
        });

    } catch (error) {
        console.error("Error in handlePathInfRequest:", error);
        return res.status(500).json({ status: "error", message: error.message });
    }
}

// --- СИНХРОННЫЕ УТИЛИТЫ (Остаются без изменений) ---

export function prepareFilename(originalName) {
    const ext = path.extname(originalName);
    const nameOnly = path.basename(originalName, ext);
    const safeName = sanitize(nameOnly).replace(/\s+/g, '-').toLowerCase();
    const uniqueName = `${uuidv4()}-${safeName}${ext}`;
    return { uniqueName, ext };
}

export function sanitizeToPath(input) {
    let cleanPath = input.replace(/\\/g, '/');
    cleanPath = cleanPath.replace(/\/+/g, '/');
    cleanPath = cleanPath.replace(/^\/+|\/+$/g, '');
    
    return cleanPath
      .split('/')
      .map(segment => sanitize(segment))
      .filter(segment => segment.length > 0)
      .join('/');
}
