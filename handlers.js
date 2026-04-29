import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import ImageRecord from "./model/ImageRecord.js";
export async function handleDeleteImage(msg, root, s3Client){
    const fname = msg.deleteImage.filename
    const bname = msg.deleteImage.bucketName
    const userLog = msg.deleteImage.userLogin
    const imgId = msg.deleteImage.imageId
    // console.log("deleteImage:  fname = ", fname, "bname = ", bname, 
    //     "userLog = ", userLog, "imgId = ", imgId)
    const deleteImage = new DeleteObjectCommand({
        Bucket: bname,
        Key: fname
    })
    await s3Client.send(deleteImage);
    console.log("Delete document off ", fname, " from ", bname)
}

export async function handleAddImage(msg, root, s3Client, BaseMessage, ws){
    const fileName = msg.addImage.filename;
    const userId = msg.addImage.userLogin;
    const bucket = msg.addImage.bucketName;
    const folder = msg.addImage.folder;
    const info = msg.addImage.info;
    const img_data = Buffer.from(msg.addImage.data);
    console.log("Buffer size:", img_data.length);

    console.log(" filename= ", fileName, " userId = ", userId, " bucket = ", bucket, 
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

    // const response = {
    //     content: "upload_result",
    //     status: "success",
    //     imageId: savedMeta._id.toString(), // Вот ваш автосгенерированный ID
    //     filename: fileName
    // };

    const responsePayload = BaseMessage.create({
        serverResp: {         
            content: "upload_result",
            status: "success",
            imageId: savedMeta._id.toString(), // Вот ваш автосгенерированный ID
            filename: fileName
        }
    });

    console.log("responsePayload = ", responsePayload);
    ws.send(BaseMessage.encode(responsePayload).finish());
//    ws.send(JSON.stringify(response));
//    ws.send("Upload successful");
}