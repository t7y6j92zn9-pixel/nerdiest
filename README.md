# Нарды от Кондрата

Тестовая версия Telegram Mini App: нарды (длинные и короткие) онлайн с корешами, игра с ботом, хата, барахолка, наколки.

## Что внутри

- `server.js` — сервер: раздаёт игру, ведёт онлайн-партии (кубики бросает сервер), Телеграм-бот с меню.
- `engine.js` — правила нард (общие для сервера и игры).
- `catalog.js` — звания, ставки, награды.
- `app/` — сама игра (страница и картинки).

## Запуск на Hugging Face Spaces (бесплатно, без карты)

1. huggingface.co → New Space → SDK **Docker**, шаблон Blank, Public.
2. В Space: Files → Add file → Create new file `Dockerfile`, вставить содержимое `Dockerfile` из этого репозитория.
3. Settings → Variables and secrets: секрет `BOT_TOKEN`, переменные `WEBAPP_URL` (адрес вида `https://имя-space.hf.space`) и `BOT_USERNAME` (имя бота без @).
4. Включить webhook, открыв в браузере `https://api.telegram.org/bot<ТОКЕН>/setWebhook?url=<WEBAPP_URL>/tg-hook`.
5. Написать боту `/start`.

Обновить игру после изменений в GitHub: Settings → Factory rebuild.

## Запуск на Render.com (нужна карта)

Web Service из репозитория, Build `npm install`, Start `node server.js`, переменные `BOT_TOKEN`, `WEBAPP_URL`.

## Проверка на компьютере

```
npm install
DEV=1 node server.js
```
Открыть в двух вкладках `http://localhost:3000/?dev=Саня&skip` и `http://localhost:3000/?dev=Вова&skip`.
