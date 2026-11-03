# Нарды от Кондрата

Тестовая версия Telegram Mini App: нарды (длинные и короткие) онлайн с корешами, игра с ботом, хата, барахолка, наколки.

## Что внутри

- `core.js` — логика: онлайн-партии (кубики бросает сервер), игроки, Телеграм-бот с меню.
- `worker.js` — запуск на Cloudflare; `server.js` — запуск на обычном сервере (Node).
- `engine.js` — правила нард (общие для сервера и игры).
- `catalog.js` — звания, ставки, награды.
- `app/` — сама игра (страница и картинки).

## Запуск на Cloudflare Workers (бесплатно, без карты, адрес постоянный)

1. dash.cloudflare.com → Workers & Pages → Create → **Import a repository** → GitHub → этот репозиторий. Настройки сборки не трогать (`npx wrangler deploy`).
2. После первой сборки: воркер `nerdiest` → Settings → Variables and Secrets → Add → тип **Secret**, имя `BOT_TOKEN`.
3. Открыть в браузере `https://nerdiest.<твой-поддомен>.workers.dev/setup` — сервер сам подключит бота (webhook, кнопка «Играть», команды).
4. Написать боту `/start`.

Файлы: `worker.js` (вход для Cloudflare), `core.js` (вся логика), `wrangler.toml` (настройки).

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
