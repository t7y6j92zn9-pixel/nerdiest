// «Нарды от Кондрата» — сервер: раздаёт игру, ведёт онлайн-партии и Телеграм-бота.
// Настройки берутся из переменных окружения (на Render — раздел Environment):
//   BOT_TOKEN  — токен бота от @BotFather (в код и в репозиторий его НЕ класть)
//   WEBAPP_URL — адрес игры, например https://nardy.onrender.com
//   DEV=1      — вход из обычного браузера по ссылке ?dev=Имя (только для проверки)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./engine.js');
const C = require('./catalog.js');

const PORT = +process.env.PORT || 3000;
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const WEBAPP_URL = (process.env.WEBAPP_URL || '').trim().replace(/\/$/, '');
const DEV = process.env.DEV === '1';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const APP = path.join(__dirname, 'app');
const TURN_SECONDS = 90;
const HOOK_PATH = '/tg-hook';
const HOOK_SECRET = BOT_TOKEN ? crypto.createHash('sha256').update('hook:' + BOT_TOKEN).digest('hex').slice(0, 40) : '';

// ---------- Хранилище: простой JSON-файл ----------
let db = { users: {} };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try { fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db)); fs.renameSync(DATA_FILE + '.tmp', DATA_FILE); } catch (e) { console.error('save', e.message); }
  }, 1000);
}
function getUser(id, name, username) {
  let u = db.users[id];
  if (!u) u = db.users[id] = { id, name: name || 'Игрок', username: username || '', cigs: 2500, rating: 0, wins: 0, losses: 0, eq: null, lvl: 1, friends: [], created: Date.now() };
  if (name) u.name = name;
  if (username) u.username = username;
  u.seen = Date.now(); save();
  return u;
}
function publicUser(u) {
  return { id: u.id, name: u.name, rating: u.rating, rank: C.rankOf(u.rating), wins: u.wins, losses: u.losses, eq: u.eq, lvl: u.lvl || 1 };
}
function me(u) {
  return { ...publicUser(u), cigs: u.cigs, friends: u.friends.map(f => db.users[f]).filter(Boolean).map(f => ({ ...publicUser(f), online: online.has(f.id) })) };
}

// ---------- Проверка входа через Телеграм ----------
function checkInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash'); if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - +params.get('auth_date') > 7 * 86400) return null;
  try { return { user: JSON.parse(params.get('user')), start: params.get('start_param') || '' }; } catch (e) { return null; }
}

// ---------- Веб-сервер ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.json': 'application/json', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(req.url.split('?')[0]); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') return res.end('ok');
  if (p === HOOK_PATH && req.method === 'POST') return onHook(req, res);
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

// ---------- Онлайн ----------
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
const online = new Map();      // userId -> ws
const games = new Map();       // gameId -> партия
const userGame = new Map();    // userId -> gameId
const rooms = new Map();       // код -> {code, host, variant, stake, created}
const queue = [];              // [{uid, variant, stake}]

function send(uid, msg) { const ws = online.get(uid); if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function sendMe(uid) { const u = db.users[uid]; if (u) send(uid, { t: 'me', me: me(u), bot: botUsername }); }
function err(uid, text) { send(uid, { t: 'err', text }); }
const r6 = () => 1 + crypto.randomInt(6);
function newCode() { let c; do { c = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(c)); return c; }

// внешний вид и счёт игрока присылает само приложение (сырой тестовый вариант)
function applyProf(u, p) {
  if (!p || typeof p !== 'object') return;
  if (Number.isFinite(+p.cigs)) u.cigs = Math.max(0, Math.min(1e7, Math.floor(+p.cigs)));
  if (Number.isFinite(+p.rating)) u.rating = Math.max(0, Math.min(1e6, Math.floor(+p.rating)));
  if (Number.isFinite(+p.lvl)) u.lvl = Math.max(1, Math.min(11, Math.floor(+p.lvl)));
  if (p.eq && typeof p.eq === 'object') { const s = JSON.stringify(p.eq); if (s.length < 2000) u.eq = JSON.parse(s); }
  save();
}

wss.on('connection', ws => {
  let uid = null;
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'auth') {
      let tg = null, start = '';
      const r = checkInitData(m.initData);
      if (r) { tg = r.user; start = r.start; }
      else if (DEV && m.dev && m.dev.id) tg = { id: 'dev' + String(m.dev.id).slice(0, 20), first_name: String(m.dev.name || 'Тестер').slice(0, 30) };
      if (!tg) { ws.send(JSON.stringify({ t: 'err', text: 'Открой игру через Телеграм-бота', fatal: true })); return; }
      uid = String(tg.id);
      const old = online.get(uid); if (old && old !== ws) { try { old.close(); } catch (e) { } }
      online.set(uid, ws);
      const u = getUser(uid, [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 40), tg.username);
      applyProf(u, m.prof);
      sendMe(uid);
      const gid = userGame.get(uid);
      if (gid && games.has(gid)) { const g = games.get(gid); g.away[g.uids.indexOf(uid)] = 0; sendGame(g); }
      const code = String(m.room || start || '').replace(/^room_?/i, '').toUpperCase();
      if (code && !gid) joinRoom(uid, code);
      return;
    }
    if (!uid) return;
    try { handle(uid, m); } catch (e) { console.error(e); err(uid, 'Ошибка сервера'); }
  });
  ws.on('close', () => {
    if (uid && online.get(uid) === ws) {
      online.delete(uid);
      leaveQueue(uid);
      const gid = userGame.get(uid);
      if (gid && games.has(gid)) { const g = games.get(gid); g.away[g.uids.indexOf(uid)] = Date.now(); }
    }
  });
});
setInterval(() => wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; try { ws.ping(); } catch (e) { } }), 25000);

function handle(uid, m) {
  const u = db.users[uid];
  switch (m.t) {
    case 'prof': return applyProf(u, m.prof);
    case 'top': {
      const all = Object.values(db.users).sort((a, b) => b.rating - a.rating || b.wins - a.wins);
      return send(uid, { t: 'top', list: all.slice(0, 50).map(publicUser), place: all.findIndex(x => x.id === uid) + 1, total: all.length });
    }
    case 'create': {
      if (userGame.has(uid)) return err(uid, 'Сначала доиграй партию');
      applyProf(u, m.prof);
      const stake = C.ECON.stakes.includes(+m.stake) ? +m.stake : 0;
      if (u.cigs < stake) return err(uid, 'Не хватает сигарет на ставку');
      for (const [c, r] of rooms) if (r.host === uid) rooms.delete(c);
      leaveQueue(uid);
      const code = newCode(), room = { code, host: uid, variant: m.variant === 'short' ? 'short' : 'long', stake, created: Date.now() };
      rooms.set(code, room);
      send(uid, { t: 'room', code, variant: room.variant, stake });
      if (m.friend && u.friends.includes(String(m.friend))) inviteFriend(u, String(m.friend), room);
      return;
    }
    case 'join': return joinRoom(uid, String(m.code || '').toUpperCase());
    case 'cancel': {
      for (const [c, r] of rooms) if (r.host === uid) rooms.delete(c);
      leaveQueue(uid); return send(uid, { t: 'lobby' });
    }
    case 'quick': {
      if (userGame.has(uid)) return;
      applyProf(u, m.prof);
      const variant = m.variant === 'short' ? 'short' : 'long';
      const stake = C.ECON.stakes.includes(+m.stake) ? +m.stake : 0;
      if (u.cigs < stake) return err(uid, 'Не хватает сигарет на ставку');
      leaveQueue(uid);
      const i = queue.findIndex(q => q.variant === variant && q.stake === stake && q.uid !== uid && online.has(q.uid));
      if (i >= 0) { const o = queue.splice(i, 1)[0]; return startGame([o.uid, uid], variant, stake); }
      queue.push({ uid, variant, stake });
      return send(uid, { t: 'searching', variant, stake, waiting: queue.length });
    }
    case 'roll': return gameRoll(uid);
    case 'move': return gameMove(uid, m.moves);
    case 'resign': {
      const g = games.get(userGame.get(uid)); if (!g || g.over) return;
      return endGame(g, 1 - g.uids.indexOf(uid), 1, 'resign');
    }
    case 'chat': {
      const g = games.get(userGame.get(uid)); if (!g || g.over) return;
      const now = Date.now(); if (now - (g.chatAt[uid] || 0) < 2500) return; g.chatAt[uid] = now;
      const text = m.text ? String(m.text).slice(0, 60) : '';
      const img = /^stikery\/[\w-]+\.webp$/.test(String(m.img || '')) ? m.img : '';
      if (!text && !img) return;
      g.uids.forEach(x => x !== uid && send(x, { t: 'chat', text, img }));
      return;
    }
  }
}
function leaveQueue(uid) { for (let i = queue.length - 1; i >= 0; i--) if (queue[i].uid === uid) queue.splice(i, 1); }

function joinRoom(uid, code) {
  const r = rooms.get(code);
  if (!r) return err(uid, 'Комната не найдена: кореш уже сел играть или отменил');
  if (r.host === uid) return send(uid, { t: 'room', code, variant: r.variant, stake: r.stake });
  if (userGame.has(uid)) return err(uid, 'Сначала доиграй партию');
  if (userGame.has(r.host) || !online.has(r.host)) { rooms.delete(code); return err(uid, 'Кореш сейчас не в игре, попроси позвать заново'); }
  if (db.users[uid].cigs < r.stake) return err(uid, `Нужно ${r.stake} сигарет на ставку`);
  rooms.delete(code);
  startGame([r.host, uid], r.variant, r.stake);
}
function addFriends(a, b) {
  const ua = db.users[a], ub = db.users[b]; if (!ua || !ub) return;
  ua.friends = [b, ...ua.friends.filter(x => x !== b)].slice(0, 50);
  ub.friends = [a, ...ub.friends.filter(x => x !== a)].slice(0, 50);
}

// ---------- Партия ----------
function startGame(uids, variant, stake) {
  uids.forEach(leaveQueue);
  for (const [c, r] of rooms) if (uids.includes(r.host)) rooms.delete(c);
  const g = {
    id: crypto.randomBytes(6).toString('hex'), uids, variant, stake, s: E.newState(variant), turn: 0, dice: [], shown: [],
    phase: 'roll', last: null, seq: 0, away: [0, 0], timeouts: [0, 0], deadline: 0, over: null, opening: null, chatAt: {},
  };
  let a, b; do { a = r6(); b = r6(); } while (a === b);
  g.opening = [a, b]; g.turn = a > b ? 0 : 1;
  if (stake) uids.forEach(x => { db.users[x].cigs -= stake; });
  addFriends(uids[0], uids[1]);
  save();
  games.set(g.id, g);
  uids.forEach(x => userGame.set(x, g.id));
  beginPhase(g, 3500); // время на анимацию розыгрыша у игроков
}
function beginPhase(g, delay) {
  g.phase = 'roll'; g.dice = []; g.shown = []; g.last = null;
  g.deadline = Date.now() + TURN_SECONDS * 1000 + (delay || 0);
  sendGame(g);
}
function doRoll(g) {
  const a = r6(), b = r6();
  g.shown = [a, b];
  g.dice = E.beginTurn(g.s, g.turn, a, b);
  g.last = null;
  if (!E.legalSteps(g.s, g.turn, g.dice).length) {
    g.phase = 'pass'; sendGame(g);
    setTimeout(() => nextTurn(g), 1800);
    return false;
  }
  g.phase = 'move'; return true;
}
function gameRoll(uid) {
  const g = games.get(userGame.get(uid)); if (!g || g.over) return;
  const p = g.uids.indexOf(uid);
  if (p !== g.turn || g.phase !== 'roll') return;
  g.timeouts[p] = 0;
  if (doRoll(g)) sendGame(g);
}
function gameMove(uid, moves) {
  const g = games.get(userGame.get(uid)); if (!g || g.over) return;
  const p = g.uids.indexOf(uid);
  if (p !== g.turn || g.phase !== 'move' || !Array.isArray(moves)) return;
  moves = moves.slice(0, 4).map(x => ({ i: x.i | 0, d: x.d | 0 }));
  const n = E.applyTurn(g.s, p, g.dice, moves);
  if (!n) { err(uid, 'Такой ход нельзя'); g.resync = true; sendGame(g); g.resync = false; return; }
  g.timeouts[p] = 0;
  finishMove(g, p, n, moves);
}
function finishMove(g, p, n, moves) {
  const before = g.s;
  g.s = n; g.s.first[p] = false; g.last = { p, moves, before };
  if (n.off[p] === 15) { g.phase = 'anim'; sendGame(g); return setTimeout(() => endGame(g, p, E.winMult(n, p), 'win'), 400 + moves.length * 600); }
  g.dice = []; g.phase = 'anim';
  sendGame(g);
  setTimeout(() => nextTurn(g), 400 + moves.length * 600);
}
function nextTurn(g) { if (g.over) return; g.turn = 1 - g.turn; beginPhase(g, 0); }

// долго не ходит — за него ходит автомат; три пропуска подряд или 2 минуты без связи — поражение
setInterval(() => {
  const now = Date.now();
  for (const g of games.values()) {
    if (g.over) { if (now - g.over.at > 600e3) games.delete(g.id); continue; }
    for (let p = 0; p < 2; p++) if (g.away[p] && now - g.away[p] > 120e3) { endGame(g, 1 - p, 1, 'left'); break; }
    if (g.over || !g.deadline || now < g.deadline || !['roll', 'move'].includes(g.phase)) continue;
    const p = g.turn;
    if (++g.timeouts[p] >= 3) { endGame(g, 1 - p, 1, 'timeout'); continue; }
    g.deadline = now + TURN_SECONDS * 1000;
    if (g.phase === 'roll' && !doRoll(g)) continue;
    if (g.phase === 'move') {
      const plan = E.botPlan(g.s, p, g.dice);
      finishMove(g, p, E.applyTurn(g.s, p, g.dice, plan) || g.s, plan);
    }
  }
  for (const [c, r] of rooms) if (now - r.created > 6 * 3600e3) rooms.delete(c);
}, 1000);

function gameView(g, i) {
  return {
    t: 'game', id: g.id, seq: ++g.seq, me: i, variant: g.variant, stake: g.stake, s: g.s, turn: g.turn, dice: g.dice, shown: g.shown,
    phase: g.phase, last: g.last, opening: g.opening, over: g.over, resync: !!g.resync,
    deadline: g.deadline ? Math.max(0, g.deadline - Date.now()) : 0,
    players: g.uids.map(x => ({ ...publicUser(db.users[x]), online: online.has(x) })),
  };
}
function sendGame(g) { g.uids.forEach((x, i) => send(x, gameView(g, i))); }

function endGame(g, w, mult, reason) {
  if (g.over) return;
  const l = 1 - w, res = { winner: w, mult, reason, at: Date.now() };
  const uw = db.users[g.uids[w]], ul = db.users[g.uids[l]];
  uw.cigs += g.stake * 2 + C.ECON.onlineWin * mult;
  uw.rating += C.RATING.win[mult];
  ul.rating = Math.max(0, ul.rating + (reason === 'resign' ? C.RATING.resign : C.RATING.loss[mult]));
  uw.wins++; ul.losses++;
  g.over = res; g.phase = 'over'; g.deadline = 0;
  save();
  sendGame(g);
  g.uids.forEach(x => userGame.delete(x));
}

// ---------- Телеграм-бот ----------
let botUsername = '';
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  return r.json();
}
const appUrl = q => WEBAPP_URL + '/' + (q || '');
const RULES = `📜 Как играть

Длинные нарды. У каждого 15 шашек на «голове». Все ходят против часовой стрелки, бить нельзя: на пункт, где стоит чужая шашка, вставать нельзя. С головы за ход снимается одна шашка (на первом ходу при 6:6, 4:4 и 3:3 — две). Нельзя строить забор из 6 шашек подряд, если впереди него нет ни одной шашки соперника.

Короткие нарды. Шашки идут навстречу друг другу. Одиночную шашку соперника можно сбить, она уходит на бар и заходит заново.

Общее. Дубль ходится 4 раза. Когда все 15 шашек дома, их можно выводить. Кто первым вывел все — победил. Если соперник не вывел ни одной — это марс, награда вдвое.

На ход даётся 90 секунд, иначе за тебя сходит автомат. Три пропуска подряд — поражение.`;
function menuKeyboard() {
  const share = `https://t.me/share/url?url=${encodeURIComponent('https://t.me/' + botUsername)}&text=${encodeURIComponent('Го в нарды на сигареты! Проверим, кто кого 🎲')}`;
  return { inline_keyboard: [
    [{ text: '🎲 Играть', web_app: { url: appUrl() } }],
    [{ text: '📜 Правила', callback_data: 'rules' }, { text: '🏆 Рейтинг', callback_data: 'top' }],
    [{ text: '🤝 Позвать кореша', url: share }],
  ] };
}
function topText() {
  const all = Object.values(db.users).sort((a, b) => b.rating - a.rating || b.wins - a.wins).slice(0, 10);
  if (!all.length) return '🏆 Доска почёта пока пустая. Сыграй первым!';
  return '🏆 Доска почёта\n\n' + all.map((u, i) => `${i + 1}. ${u.name} — ${u.rating} (${C.rankOf(u.rating)}), побед: ${u.wins}`).join('\n');
}
function inviteFriend(u, fid, room) {
  if (!BOT_TOKEN || !WEBAPP_URL || fid.startsWith('dev')) return;
  tg('sendMessage', {
    chat_id: fid,
    text: `🎲 ${u.name} зовёт тебя в ${room.variant === 'short' ? 'короткие' : 'длинные'} нарды. ${room.stake ? `Ставка: ${room.stake} сигарет.` : 'Без ставки.'}`,
    reply_markup: { inline_keyboard: [[{ text: 'Сесть за доску', web_app: { url: appUrl('?room=' + room.code) } }]] },
  }).catch(() => { });
}
async function onUpdate(up) {
  if (up.callback_query) {
    const q = up.callback_query;
    await tg('answerCallbackQuery', { callback_query_id: q.id });
    const chat = q.message && q.message.chat.id; if (!chat) return;
    if (q.data === 'rules') await tg('sendMessage', { chat_id: chat, text: RULES });
    if (q.data === 'top') await tg('sendMessage', { chat_id: chat, text: topText() });
    return;
  }
  const msg = up.message; if (!msg || !msg.text) return;
  const [cmd0, payload] = msg.text.trim().split(/\s+/);
  const cmd = cmd0.split('@')[0].toLowerCase();
  const chat_id = msg.chat.id;
  if (cmd === '/start' && /^room_/i.test(payload || '')) {
    const code = payload.replace(/^room_?/i, '').toUpperCase();
    return tg('sendMessage', { chat_id, text: '🎲 Тебя позвали сыграть в нарды! Жми кнопку, чтобы сесть за доску.', reply_markup: { inline_keyboard: [[{ text: 'Сесть за доску', web_app: { url: appUrl('?room=' + code) } }]] } });
  }
  if (cmd === '/start' || cmd === '/menu') return tg('sendMessage', { chat_id, text: 'Здорово, арестант! Это «Нарды от Кондрата».\n\nОдевай своего персонажа, набивай наколки, обставляй хату и играй в нарды с корешами на сигареты.\n\n⚠️ Это первая тестовая версия: что-то может работать криво.', reply_markup: menuKeyboard() });
  if (cmd === '/play') return tg('sendMessage', { chat_id, text: 'Садись за доску 👇', reply_markup: { inline_keyboard: [[{ text: '🎲 Играть', web_app: { url: appUrl() } }]] } });
  if (cmd === '/rules') return tg('sendMessage', { chat_id, text: RULES });
  if (cmd === '/top') return tg('sendMessage', { chat_id, text: topText() });
  if (cmd === '/invite') return tg('sendMessage', { chat_id, text: 'Скинь корешу ссылку на бота, или открой игру → «Играть» → «Вызвать кореша»: там будет ссылка прямо на твою партию.', reply_markup: { inline_keyboard: [[menuKeyboard().inline_keyboard[2][0]]] } });
}
function onHook(req, res) {
  if (!HOOK_SECRET || req.headers['x-telegram-bot-api-secret-token'] !== HOOK_SECRET) { res.writeHead(403); return res.end(); }
  let body = ''; req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', () => { res.end('ok'); try { onUpdate(JSON.parse(body)).catch(e => console.error('bot', e.message)); } catch (e) { } });
}
async function botSetup() {
  if (!BOT_TOKEN) return console.log('BOT_TOKEN не задан — бот не запущен');
  try {
    const r = await tg('getMe');
    if (!r.ok) return console.log('Телеграм не принял токен:', r.description);
    botUsername = r.result.username; console.log('Бот: @' + botUsername);
    await tg('setMyCommands', { commands: [
      { command: 'start', description: 'Главное меню' }, { command: 'play', description: 'Играть в нарды' },
      { command: 'rules', description: 'Правила' }, { command: 'top', description: 'Доска почёта' }, { command: 'invite', description: 'Позвать кореша' },
    ] });
    if (!WEBAPP_URL) { console.log('WEBAPP_URL не задан — кнопки «Играть» не будет, бот слушает через getUpdates'); return poll(); }
    await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: appUrl() } } });
    const h = await tg('setWebhook', { url: WEBAPP_URL + HOOK_PATH, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    console.log('Webhook:', h.ok ? 'включён' : h.description);
  } catch (e) { console.log('Не удалось связаться с Телеграмом:', e.message); }
}
async function poll() {
  await tg('deleteWebhook', {}).catch(() => { });
  let offset = 0;
  for (; ;) {
    try {
      const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const up of r.result || []) { offset = up.update_id + 1; await onUpdate(up).catch(() => { }); }
    } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
  }
}

server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}${DEV ? ' (DEV=1: вход по ?dev=Имя)' : ''}`);
  botSetup();
});
