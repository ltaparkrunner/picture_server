FROM node:20-alpine

# Устанавливаем зависимости для сборки бинарных модулей (необходимы для bcrypt на alpine)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Сначала копируем файлы зависимостей для эффективного кэширования слоев Docker
COPY package*.json ./

# Устанавливаем зависимости (включая production и dev, если нужен nodemon для разработки)
# RUN npm ci
RUN npm install

# Копируем исходный код проекта
COPY . .

# Проект работает на порту 8080
EXPOSE 8080

CMD ["npm", "start"]
