import User from './model/User.js';// Ваша Mongoose модель
import protobuf from 'protobufjs';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

/**
 * Генерирует токен при успешном логине
 */
const SECRET_KEY = process.env.JWT_SECRET || 'secret_key';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '4h';
function generateToken(user) {
    // В payload кладем только безопасные данные (ID, логин)
    console.log("Env SECRET_KEY: ", SECRET_KEY, "Env JWT_EXPIRES_IN: ", JWT_EXPIRES_IN)

    return jwt.sign(
        { userId: user._id, login: user.login },
        SECRET_KEY,
        { expiresIn: JWT_EXPIRES_IN }
    );
}

/**
 * Проверяет валидность токена
 */
export function verifyToken(token) {
    try {
        return jwt.verify(token, SECRET_KEY);
    } catch (error) {
        return null; // Токен невалиден или просрочен
    }
}

// ==========================================
// ОБРАБОТЧИКИ ЗАПРОСОВ (БИЗНЕС-ЛОГИКА)
// ==========================================

const root = await protobuf.load('image.proto');
const ServerEnvelope = root.lookupType('ServerEnvelope');
//  const ServerType = ServerEnvelope.nested.Type;
const ServerTypeValues = ServerEnvelope.nested.Type.values;
// Обработка регистрации (RegisterRequest)
export async function handleRegister(ws, regRequest) {
    const { userLogin, password, full_name } = regRequest;
    try {
        // Проверяем, существует ли уже такой логин
        const existingUser = await User.findOne({ login: userLogin });
        if (existingUser) {
            return sendAuthError(ws, 'User already exists');
        }

        // Создаем нового пользователя (пароль захешируется автоматически в User.js через pre-save)
        const newUser = new User({
            login: userLogin,
            password: password
            // Если в схему User.js нужно добавить full_name, добавьте поле туда. Пока просто сохраняем логин/пароль.
        });
        await newUser.save();
        const token = generateToken(user);
        // Отправляем успешный ответ (токен можно сгенерировать через JWT, тут для примера статичная строка)
        sendAuthSuccess(ws, token);
        console.log(`User registered successfully: ${userLogin}`);

    } catch (error) {
        console.error('Registration error:', error);
        sendAuthError(ws, 'Registration failed due to server error');
    }
}

// Обработка авторизации (AuthRequest)
export async function handleLogin(ws, authRequest) {
    const { userLogin, password } = authRequest;
    try {
        // Seeking for user in database
        const user = await User.findOne({ login: userLogin });
        if (!user) {
            return sendAuthError(ws, 'Invalid login or password');
        }

        // Проверяем пароль через метод из User.js
        const isMatch = await user.comparePassword(password);
        if (!isMatch) {
            return sendAuthError(ws, 'Invalid login or password');
        }
        const token = generateToken(user);
        // Пароль верный — отправляем токен
        sendAuthSuccess(ws, token);
        console.log(`User logged in successfully: ${userLogin}`);

    } catch (error) {
        console.error('Login error:', error);
        sendAuthError(ws, 'Authentication failed due to server error');
    }
}

// ==========================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ОТПРАВКИ ОТВЕТА
// ==========================================

// Функция сборки и отправки ServerEnvelope с успешным AuthResponse
function sendAuthSuccess(ws, token) {
    const responsePayload = {
        type: ServerTypeValues.AUTH_RESPONSE,
        authResponse: {
            token: token,
            error: "No error from the server"
        }
    };
    console.log("ServerTypeValues.AUTH_RESPONSE: ", ServerTypeValues.AUTH_RESPONSE)
    sendEnvelope(ws, responsePayload);
}

// Функция сборки и отправки ServerEnvelope с ошибкой в AuthResponse
function sendAuthError(ws, errorMessage) {
    const responsePayload = {
        type: ServerTypeValues.AUTH_RESPONSE,
        authResponse: {
            token: "",
            error: errorMessage
        }
    };
    sendEnvelope(ws, responsePayload);
}

// Общая функция сериализации и отправки данных по сети
function sendEnvelope(ws, payloadStructure) {
    if (ws.readyState === ws.OPEN) {
        console.log("function sendEnvelope      payloadStructure.type: ", payloadStructure.type, 
            "payloadStructure.authResponse.token: ", payloadStructure.authResponse.token)
        // 1. Проверяем структуру на соответствие .proto схеме
        const errMsg = ServerEnvelope.verify(payloadStructure);
        if (errMsg) throw Error(errMsg);

        // 2. Создаем объект сообщения
        const message = ServerEnvelope.create(payloadStructure);

        // 3. Сериализуем в Uint8Array (бинарный формат Protobuf)
        const buffer = ServerEnvelope.encode(message).finish();

        // 4. Отправляем байты клиенту Qt/C++
        ws.send(buffer);
    }
}
