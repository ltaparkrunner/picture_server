import mongoose from 'mongoose';

const imageRecordSchema = new mongoose.Schema({
    name: String,           // Можно оставить для краткости
    originalName: String,   // Имя файла
    s3Key: String,          // Путь в MinIO
    bucket: String,         // Бакет
    userLogin: String,      // ID или логин пользователя
    size: Number,
    info: mongoose.Schema.Types.Mixed, // Для произвольных данных (объектов)
    createdAt: { type: Date, default: Date.now }
});

// Создаем модель и экспортируем её
const ImageRecord = mongoose.model('ImageRecord', imageRecordSchema);
//  module.exports = ImageRecord;
export default ImageRecord; // Должно быть слово default
