const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json());

// 1. Схема пользователя для MongoDB
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

const User = mongoose.model('User', userSchema);

// 2. Маршрут РЕГИСТРАЦИИ
app.post('/register', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Проверяем, не занято ли имя
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(400).json({ error: "Пользователь уже существует" });
        }

        // Хешируем пароль (солим 10 раз)
        const hashedPassword = await bcrypt.hash(password, 10);

        // Создаем и сохраняем пользователя
        const newUser = new User({
            username,
            password: hashedPassword
        });

        await newUser.save();

        // Сразу создаем токен, чтобы пользователю не нужно было логиниться после регистрации
        const token = jwt.sign(
            { id: newUser._id }, 
            process.env.JWT_SECRET || 'secret_key', 
            { expiresIn: '2h' }
        );

        res.status(201).json({ 
            message: "Пользователь создан",
            token: token 
        });

    } catch (err) {
        res.status(500).json({ error: "Ошибка сервера при регистрации" });
    }
});

// 3. Обновленный маршрут ЛОГИНА (с проверкой хеша)
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await User.findOne({ username });

        if (!user) return res.status(401).json({ error: "Неверный логин" });

        // Сравниваем присланный пароль с хешем в базе
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Неверный пароль" });

        const token = jwt.sign({ id: user._id }, 'secret_key', { expiresIn: '2h' });
        res.json({ token });
    } catch (err) {
        res.status(500).json({ error: "Ошибка входа" });
    }
});

app.listen(8081, () => console.log('Auth server running on port 8081'));
