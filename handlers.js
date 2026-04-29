import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
export async function handleDeleteFile(msg, root, s3Client){
    const fname = msg.deleteImage.fileName
    const bname = msg.deleteImage.bucketName
    const userLog = msg.deleteImage.userLogin
    const fileId = msg.deleteImage.fileId
    // console.log("deleteImage:  fname = ", fname, "bname = ", bname, 
    //     "userLog = ", userLog, "imgId = ", imgId)
    const deleteImage = new DeleteObjectCommand({
        Bucket: bname,
        Key: fname
    })
    await s3Client.send(deleteImage);
    console.log("Delete document off ", fname, " from ", bname)
}

export async function handleAddFile(msg, root, s3Client, BaseMessage, ws){
    const fileName = msg.addFile.fileName;
    const userId = msg.addFile.userLogin;
    const bucket = msg.addFile.bucketName;
    const folder = msg.addFile.folder;
    const info = msg.addFile.info;
    const img_data = Buffer.from(msg.addFile.data);
    console.log("Buffer size:", img_data.length);

    console.log(" fileName= ", fileName, " userId = ", userId, " bucket = ", bucket, 
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
        userLogin: userId,
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

