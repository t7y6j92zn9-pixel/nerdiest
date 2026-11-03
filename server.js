// «Нарды от Кондрата» — запуск на обычном сервере (Node). Логика игры — в core.js.
// Переменные окружения:
//   BOT_TOKEN    — токен бота от @BotFather (в код и в репозиторий его НЕ класть)
//   WEBAPP_URL   — адрес игры, например https://nardy.example.com
//   BOT_USERNAME — имя бота без @ (если сервер не может сам спросить его у Телеграма)
//   DEV=1        — вход из обычного браузера по ссылке ?dev=Имя (только для проверки)
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createCore } = require('./core.js');

const PORT = +process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const APP = path.join(__dirname, 'app');

let db = { users: {}, meta: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { }
db.meta = db.meta || {};
let fileTimer = null;
const core = createCore({
  BOT_TOKEN: process.env.BOT_TOKEN, WEBAPP_URL: process.env.WEBAPP_URL, BOT_USERNAME: process.env.BOT_USERNAME, ADMIN_PASS: process.env.ADMIN_PASS, DEV: process.env.DEV === '1',
  users: db.users, meta: db.meta,
  saveMeta() { writeSoon(); },
  saveUser() { writeSoon(); },
});
function writeSoon() {
    if (fileTimer) return;
    fileTimer = setTimeout(() => { fileTimer = null; try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.error('save', e.message); } }, 1000);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') return res.end('ok');
  if (p === core.HOOK_PATH && req.method === 'POST') {
    if (!core.hookAllowed(req.headers['x-telegram-bot-api-secret-token'])) { res.writeHead(403); return res.end(); }
    let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let out = null; try { out = core.onUpdate(JSON.parse(body)); } catch (e) { console.error('bot', e.message); }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out ? JSON.stringify(out) : '{}');
    });
    return;
  }
  const ph = p.match(/^\/photo\/([0-9a-f]{16})\.jpg$/);
  if (ph) { core.getPhoto(ph[1]).then(b => { if (!b) { res.writeHead(404); return res.end(); } res.writeHead(200, { 'Content-Type': 'image/jpeg' }); res.end(b); }); return; }
  if (p === '/') p = '/index.html';
  const file = path.join(APP, path.normalize(p));
  if (!file.startsWith(APP + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Не найдено'); }
    const ext = path.extname(file);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, maxPayload: 800 * 1024 });
wss.on('connection', ws => {
  const sock = { send: s => ws.readyState === 1 && ws.send(s), close: () => ws.close(), uid: null };
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => core.onMessage(sock, String(raw)));
  ws.on('close', () => core.onClose(sock));
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) { } }), 25000);
setInterval(() => core.tick(), 1000);

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}${process.env.DEV === '1' ? ' (DEV=1: вход по ?dev=Имя)' : ''}`);
  core.botSetup({ poll: true });
});
