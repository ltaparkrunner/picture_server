import { DeleteObjectCommand } from "@aws-sdk/client-s3";
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

