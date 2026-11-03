# Запуск в контейнере (Back4app Containers и подобные). Порт 8080.
FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=8080 DATA_FILE=/tmp/data.json
EXPOSE 8080
CMD ["node", "server.js"]
