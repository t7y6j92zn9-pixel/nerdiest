# Нарды от Кондрата

Тестовая версия Telegram Mini App: нарды (длинные и короткие) онлайн с корешами, игра с ботом, хата, барахолка, наколки.

## Что внутри

- `server.js` — сервер: раздаёт игру, ведёт онлайн-партии (кубики бросает сервер), Телеграм-бот с меню.
- `engine.js` — правила нард (общие для сервера и игры).
- `catalog.js` — звания, ставки, награды.
- `app/` — сама игра (страница и картинки).

## Запуск на Back4app Containers (бесплатно)

1. back4app.com → Containers → New app → подключить GitHub и выбрать этот репозиторий (Dockerfile уже есть, порт 8080).
2. Environment variables: `BOT_TOKEN`, `BOT_USERNAME` (без @), `WEBAPP_URL` (адрес приложения из Back4app).
3. После запуска написать боту `/start`. Если бот молчит — открыть в браузере `https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=<WEBAPP_URL>/tg-hook`.

## Запуск на Render.com (нужна карта)

Web Service из репозитория, Build `npm install`, Start `node server.js`, переменные `BOT_TOKEN`, `WEBAPP_URL`.

## Проверка на компьютере

```
npm install
DEV=1 node server.js
```
Открыть в двух вкладках `http://localhost:3000/?dev=Саня&skip` и `http://localhost:3000/?dev=Вова&skip`.
