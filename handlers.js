import { DeleteObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
import User from './model/User.js';

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

    //const minioPath = `${folder}/${Date.now()}_${uuidv4()}_${fileName}`;
    const minioPath = fileName;
    const command = new PutObjectCommand({
        Bucket: bucket,
        Key: minioPath,
        Body: img_data
    });

    await s3Client.send(command);

    // Сохранение метаданных в MongoDB
    const meta = new ImageRecord({
        name: fileName,
        originalName: fileName,
        s3Key: minioPath,
        bucket: bucket,
        userLogin: usrLogin,
        info: {type : "jpg"},
        size: img_data.length    
    });
    const savedMeta = await meta.save();

    console.log(`Saved image ${fileName} for user ${userId} with ID: ${savedMeta._id}`);

    const responsePayload = BaseMessage.create({
        serverResp: {         
            content: "upload_result",
            status: "success",
            fileId: savedMeta._id.toString(), // Вот ваш автосгенерированный ID
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

    console.log("bucketName = ", bucketName, "  folderName = ", folderName, "  usrLogin = ", usrLogin);

    const { 
    currentPath: curPath, 
    subFolders: sFolders, 
    files: fls 
    }  = await getFolderContent(bucketName,  folderName)

    const responsePayload = BaseMessage.create({
        listResponse: { files: imageInfos, folders: {} }
    });
    console.log("responsePayload = ", responsePayload);
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
