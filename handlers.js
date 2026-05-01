import { DeleteObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
import User from './model/User.js';
import  path from 'path';
import  sanitize from 'sanitize-filename';

export async function handleDeleteFile(msg, root, s3Client){
    const fname = msg.deleteImage.fileName
    const bname = msg.deleteImage.bucketName
    const usrLogin = msg.deleteImage.userLogin
    const fileId = msg.deleteImage.fileId
    // console.log("deleteImage:  fname = ", fname, "bname = ", bname, 
    //     "usrLogin = ", usrLogin, "imgId = ", imgId)
    const deleteImage = new DeleteObjectCommand({
        Bucket: bname,
        Key: fname
    })
    await s3Client.send(deleteImage);
    console.log("Delete document off ", fname, " from ", bname)
}

export async function handleAddFile(msg, root, s3Client, BaseMessage, ws){
    const fileName = msg.addFile.fileName;
    const usrLogin = msg.addFile.userLogin;
    const bucket = msg.addFile.bucketName;
    const folder = msg.addFile.folder;
    const info = msg.addFile.info;
    const img_data = Buffer.from(msg.addFile.data);
    console.log("Buffer size:", img_data.length);

    console.log(" fileName= ", fileName, " usrLogin = ", usrLogin, " bucket = ", bucket, 
        " folder = ", folder, " info = ", info);
    const safefolder = sanitize(folder).replace(/\s+/g, '-');
    const {uniqueName, ext} = prepareFilename(fileName);
    const s3Key = (safefolder) ?  `${safefolder}/${uniqueName}` : uniqueName;

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

    const responsePayload = BaseMessage.create({
        serverResp: {         
            content: "upload_result",
            status: "success",
            uniqueName: uniqueName,//savedMeta._id.toString(), // Вот ваш автосгенерированный ID
            fileName: fileName
        }
    });

    console.log("responsePayload = ", responsePayload);
    ws.send(BaseMessage.encode(responsePayload).finish());
}

export async function handleViewFolder(msg, root, s3Client, BaseMessage, ws)
{
    const bucketName = msg.listRequest.bucketName;
    const folderName = msg.listRequest.folderName;
    const usrLogin = msg.listRequest.userLogin;

    const minioPath = "http://minio:9000/" + bucketName + "/";
    console.log("bucketName = ", bucketName, "  folderName = ", folderName, "  usrLogin = ", usrLogin);

    const { 
        currentPath: curPath, 
        subFolders: sFolders, 
        files: fls 
    }  = await getFolderContent(bucketName,  folderName)

    console.log("files = ", fls, "  folders = ", sFolders);
    const fs = fls.map(item => ({
        fileName : item.originalName,
        url : minioPath + item.s3Key,
        size : item.size
    }));
    const sFldrs = sFolders.map(name=> ({
        folderName: name,
        url: minioPath + folderName + name + "/"
    }));
    console.log("fs = ", fs, "  sFldrs = ", sFldrs);
    const responsePayload = BaseMessage.create({
        listResponse: { files: fs, folders: sFldrs }
    });
    //  console.log("responsePayload = ", responsePayload);
    ws.send(BaseMessage.encode(responsePayload).finish());
}

async function getFolderContent(bucketName, folderPath = "") {
    // Гарантируем, что путь заканчивается слэшем, если он не пустой
    const prefix = folderPath === "" ? "" : (folderPath.endsWith('/') ? folderPath : folderPath + '/');
    
    // Ищем все записи в заданном бакете, начинающиеся с префикса
    const items = await ImageRecord.find({
        bucket: bucketName,
        s3Key: new RegExp('^' + prefix) 
    });

    const folders = new Set();
    const files = [];

    items.forEach(item => {
        // Отрезаем префикс текущей папки от полного пути
        const relativePath = item.s3Key.substring(prefix.length);
        
        if (relativePath.includes('/')) {
            // Если в остатке есть слэш — это файл в подпапке. 
            // Берем только имя первой подпапки.
            const subFolderName = relativePath.split('/')[0];
            folders.add(subFolderName);
        } else {
            // Если слэшей больше нет — это файл непосредственно в текущей папке
            files.push(item);
        }
    });
    // folders.add("forever")
    return {
        currentPath: prefix,
        subFolders: Array.from(folders),
        files: files
    };
}

// 1. Registration
async function register(login, password) {
    const newUser = new User({ login, password });
    await newUser.save(); // The password will be automatically hashed.
    return "User created";
}

// 2. Authorization
async function login(login, password) {
    const user = await User.findOne({ login });
    if (!user) throw new Error("User not found");

    const isMatch = await user.comparePassword(password);
    if (!isMatch) throw new Error("Incorrect password");

    return "Successful login!";
}

// import ImageRecord from './model/ImageRecord.js';
// // Предположим, у вас экспортирован настроенный клиент minioClient
// import { minioClient } from './minioConfig.js'; 

async function deleteImageAndRecord(recordId) {
    try {
        // 1. Находим запись в MongoDB, чтобы узнать путь в MinIO
        const record = await ImageRecord.findById(recordId);
        
        if (!record) {
            throw new Error("Запись не найдена в базе данных");
        }

        // 2. Удаляем физический файл из MinIO
        // Нам нужны имя бакета и s3Key (путь к файлу)
        await minioClient.removeObject(record.bucket, record.s3Key);
        console.log(`Файл ${record.s3Key} удален из MinIO`);

        // 3. Удаляем метаданные из MongoDB
        await ImageRecord.findByIdAndDelete(recordId);
        console.log(`Запись ${recordId} удалена из MongoDB`);

        return { success: true };
    } catch (error) {
        console.error("Ошибка при удалении:", error.message);
        throw error;
    }
}


async function getUniqueFileName(bucket, folderPath, originalName) {
    let name = originalName;
    let extension = "";
    let baseName = originalName;

    // Разделяем имя и расширение (например, "image" и ".jpg")
    const lastDotIndex = originalName.lastIndexOf('.');
    if (lastDotIndex !== -1) {
        baseName = originalName.substring(0, lastDotIndex);
        extension = originalName.substring(lastDotIndex);
    }

    let counter = 1;
    let isUnique = false;

    while (!isUnique) {
        // Проверяем, существует ли уже такой s3Key в этом бакете
        const fullPath = `${folderPath}${name}`;
        const existing = await ImageRecord.findOne({ bucket, s3Key: fullPath });

        if (!existing) {
            isUnique = true;
        } else {
            // Если занято, создаем новое имя: "file (1).jpg"
            name = `${baseName} (${counter})${extension}`;
            counter++;
        }
    }

    return {name, extension};
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