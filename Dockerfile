FROM node:18-slim
WORKDIR /app
# Копируем файлы зависимостей
COPY package*.json ./
RUN npm install
# Копируем остальные файлы (server.js, image.proto)
COPY . .
EXPOSE 3000
CMD ["node", "server.js"]