// «Нарды от Кондрата» — логика сервера: игроки, онлайн-партии, Телеграм-бот.
// Общая для запуска на Node (server.js) и на Cloudflare (worker.js).
const crypto = require('crypto');
const { Buffer } = require('buffer');
const E = require('./engine.js');
const C = require('./catalog.js');

const TURN_SECONDS = 90;
const HOOK_PATH = '/tg-hook';

// cfg: { BOT_TOKEN, WEBAPP_URL, BOT_USERNAME, DEV, users, saveUser(u), meta, saveMeta(meta), putPhoto(id, buf), getPhoto(id), log }
function createCore(cfg) {
  const BOT_TOKEN = (cfg.BOT_TOKEN || '').trim();
  const WEBAPP_URL = (cfg.WEBAPP_URL || '').trim().replace(/\/$/, '');
  const DEV = !!cfg.DEV;
  const HOOK_SECRET = BOT_TOKEN ? crypto.createHash('sha256').update('hook:' + BOT_TOKEN).digest('hex').slice(0, 40) : '';
  const log = cfg.log || console.log;
  const users = cfg.users || {};
  const meta = cfg.meta || {};
  let metaTimer = null;
  function saveMeta() { if (metaTimer) return; metaTimer = setTimeout(() => { metaTimer = null; cfg.saveMeta && cfg.saveMeta(meta); }, 1000); }
  const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // по Москве
  const dirty = new Set(); let saveTimer = null;
  function save(u) { if (u) dirty.add(u.id); if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; const ids = [...dirty]; dirty.clear(); ids.forEach(id => users[id] && cfg.saveUser && cfg.saveUser(users[id])); }, 1000); }
  let botUsername = (cfg.BOT_USERNAME || '').replace(/^@/, '').trim();

  // ---------- игроки ----------
  function getUser(id, name, username) {
    let u = users[id];
    if (!u) u = users[id] = { id, name: name || 'Игрок', username: username || '', cigs: 2500, rating: 0, wins: 0, losses: 0, eq: null, lvl: 1, friends: [], created: Date.now() };
    if (name) u.name = name;
    if (username) u.username = username;
    u.seen = Date.now(); save(u);
    return u;
  }
  function publicUser(u) { return { id: u.id, name: u.name, rating: u.rating, rank: C.rankOf(u.rating), wins: u.wins, losses: u.losses, eq: u.eq, lvl: u.lvl || 1, mars: u.mars || 0, best: u.best || 0, longG: u.longG || 0, shortG: u.shortG || 0, created: u.created, num: String(u.id).replace(/\D/g, '').slice(-4).padStart(4, '0') }; }
  function meView(u) { return { ...publicUser(u), cigs: u.cigs, friends: u.friends.map(f => users[f]).filter(Boolean).map(f => ({ ...publicUser(f), online: online.has(f.id) })) }; }
  // внешний вид и счёт игрока присылает само приложение (сырой тестовый вариант)
  function applyProf(u, p) {
    if (!p || typeof p !== 'object') return;
    if (Number.isFinite(+p.cigs)) u.cigs = Math.max(0, Math.min(1e7, Math.floor(+p.cigs)));
    if (Number.isFinite(+p.rating)) u.rating = Math.max(0, Math.min(1e6, Math.floor(+p.rating)));
    if (Number.isFinite(+p.lvl)) u.lvl = Math.max(1, Math.min(11, Math.floor(+p.lvl)));
    if (p.eq && typeof p.eq === 'object') { const s = JSON.stringify(p.eq); if (s.length < 2000) u.eq = JSON.parse(s); }
    save(u);
  }

  // ---------- вход через Телеграм ----------
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

  // ---------- соединения ----------
  const online = new Map();      // userId -> sock
  const games = new Map();
  const userGame = new Map();
  const rooms = new Map();
  const queue = [];
  function send(uid, msg) { const s = online.get(uid); if (s) { try { s.send(JSON.stringify(msg)); } catch (e) { } } }
  function sendMe(uid) { const u = users[uid]; if (u) send(uid, { t: 'me', me: meView(u), bot: botUsername }); }
  function err(uid, text) { send(uid, { t: 'err', text }); }
  const r6 = () => 1 + crypto.randomInt(6);
  function newCode() { let c; do { c = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(c)); return c; }

  function onMessage(sock, raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'auth') {
      let tg = null, start = '';
      const r = checkInitData(m.initData);
      if (r) { tg = r.user; start = r.start; }
      else if (DEV && m.dev && m.dev.id) tg = { id: 'dev' + String(m.dev.id).slice(0, 20), first_name: String(m.dev.name || 'Тестер').slice(0, 30) };
      if (!tg) { try { sock.send(JSON.stringify({ t: 'err', text: 'Открой игру через Телеграм-бота', fatal: true })); } catch (e) { } return; }
      const uid = sock.uid = String(tg.id);
      const old = online.get(uid); if (old && old !== sock) { try { old.close(); } catch (e) { } }
      online.set(uid, sock);
      const u = getUser(uid, [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 40), tg.username);
      if (!u.app) { u.app = Date.now(); save(u); }
      applyProf(u, m.prof);
      sendMe(uid);
      const gid = userGame.get(uid);
      if (gid && games.has(gid)) { const g = games.get(gid); g.away[g.uids.indexOf(uid)] = 0; sendGame(g); }
      const code = String(m.room || start || '').replace(/^room_?/i, '').toUpperCase();
      if (code && !gid) joinRoom(uid, code);
      return;
    }
    if (!sock.uid) return;
    try { handle(sock.uid, m); } catch (e) { log(e && e.stack || e); err(sock.uid, 'Ошибка сервера'); }
  }
  function onClose(sock) {
    const uid = sock.uid;
    if (uid && online.get(uid) === sock) {
      online.delete(uid);
      leaveQueue(uid);
      const gid = userGame.get(uid);
      if (gid && games.has(gid)) { const g = games.get(gid); g.away[g.uids.indexOf(uid)] = Date.now(); }
    }
  }

  function handle(uid, m) {
    const u = users[uid];
    switch (m.t) {
      case 'prof': return applyProf(u, m.prof);
      case 'me': return sendMe(uid);
      case 'peek': { // ход ещё идёт: показать сопернику шашки сразу
        const g = games.get(userGame.get(uid)); if (!g || g.over || g.phase !== 'move' || g.uids[g.turn] !== uid || !Array.isArray(m.moves)) return;
        const moves = m.moves.slice(0, 4).map(x => ({ i: x.i | 0, d: x.d | 0 }));
        g.uids.forEach(x => x !== uid && send(x, { t: 'peek', id: g.id, moves }));
        return;
      }
      case 'photo': return sharePhoto(uid, m);
      case 'top': {
        const all = Object.values(users).filter(x => x.app).sort((a, b) => b.rating - a.rating || b.wins - a.wins);
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
    if (users[uid].cigs < r.stake) return err(uid, `Нужно ${r.stake} сигарет на ставку`);
    rooms.delete(code);
    startGame([r.host, uid], r.variant, r.stake);
  }
  function addFriends(a, b) {
    const ua = users[a], ub = users[b]; if (!ua || !ub) return;
    ua.friends = [b, ...ua.friends.filter(x => x !== b)].slice(0, 50);
    ub.friends = [a, ...ub.friends.filter(x => x !== a)].slice(0, 50);
  }

  // ---------- партия ----------
  function startGame(uids, variant, stake) {
    uids.forEach(leaveQueue);
    for (const [c, r] of rooms) if (uids.includes(r.host)) rooms.delete(c);
    const g = {
      id: crypto.randomBytes(6).toString('hex'), uids, variant, stake, s: E.newState(variant), turn: 0, dice: [], shown: [],
      phase: 'roll', last: null, seq: 0, away: [0, 0], timeouts: [0, 0], deadline: 0, over: null, opening: null, chatAt: {},
    };
    meta.gamesTotal = (meta.gamesTotal || 0) + 1; if (meta.day !== today()) { meta.day = today(); meta.gamesDay = 0; } meta.gamesDay = (meta.gamesDay || 0) + 1; saveMeta();
    let a, b; do { a = r6(); b = r6(); } while (a === b);
    g.opening = [a, b]; g.turn = a > b ? 0 : 1;
    if (stake) uids.forEach(x => { users[x].cigs -= stake; });
    addFriends(uids[0], uids[1]);
    uids.forEach(x => save(users[x]));
    games.set(g.id, g);
    uids.forEach(x => userGame.set(x, g.id));
    beginPhase(g, 3500);
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
    if (n.off[p] === 15) { g.phase = 'anim'; sendGame(g); return setTimeout(() => endGame(g, p, E.winMult(n, p), 'win'), 300); }
    g.dice = []; g.phase = 'anim';
    sendGame(g);
    setTimeout(() => nextTurn(g), 200);
  }
  function nextTurn(g) { if (g.over) return; g.turn = 1 - g.turn; beginPhase(g, 0); }

  // раз в секунду: автоход по таймауту, поражение за уход
  function tick() {
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
  }
  function busy() { return online.size > 0 || [...games.values()].some(g => !g.over); }

  function gameView(g, i) {
    return {
      t: 'game', id: g.id, seq: ++g.seq, me: i, variant: g.variant, stake: g.stake, s: g.s, turn: g.turn, dice: g.dice, shown: g.shown,
      phase: g.phase, last: g.last, opening: g.opening, over: g.over, resync: !!g.resync,
      deadline: g.deadline ? Math.max(0, g.deadline - Date.now()) : 0,
      players: g.uids.map(x => ({ ...publicUser(users[x]), online: online.has(x) })),
    };
  }
  function sendGame(g) { g.uids.forEach((x, i) => send(x, gameView(g, i))); }
  function endGame(g, w, mult, reason) {
    if (g.over) return;
    const l = 1 - w, res = { winner: w, mult, reason, at: Date.now() };
    const uw = users[g.uids[w]], ul = users[g.uids[l]];
    uw.cigs += g.stake * 2 + C.ECON.onlineWin * mult;
    uw.rating += C.RATING.win[mult];
    ul.rating = Math.max(0, ul.rating + (reason === 'resign' ? C.RATING.resign : C.RATING.loss[mult]));
    uw.wins++; ul.losses++;
    if (mult > 1) uw.mars = (uw.mars || 0) + 1;
    uw.streak = (uw.streak || 0) + 1; uw.best = Math.max(uw.best || 0, uw.streak); ul.streak = 0;
    const vk = g.variant === 'short' ? 'shortG' : 'longG'; uw[vk] = (uw[vk] || 0) + 1; ul[vk] = (ul[vk] || 0) + 1;
    g.over = res; g.phase = 'over'; g.deadline = 0;
    save(uw); save(ul);
    sendGame(g);
    g.uids.forEach(x => userGame.delete(x));
  }

  // ---------- Телеграм-бот ----------
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
    const all = Object.values(users).filter(x => x.app).sort((a, b) => b.rating - a.rating || b.wins - a.wins).slice(0, 10);
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
  // ---------- фото на память: сохранить и отдать Телеграму готовое сообщение для пересылки ----------
  const photosMem = new Map();
  async function sharePhoto(uid, m) {
    const d = String(m.data || ''); const mt = d.match(/^data:image\/jpeg;base64,(.+)$/);
    if (!mt || d.length > 600000) return err(uid, 'Фото не получилось');
    if (!BOT_TOKEN || !WEBAPP_URL || uid.startsWith('dev')) return err(uid, 'Пересылка фото работает только в Телеграме');
    const id = crypto.randomBytes(8).toString('hex'), buf = Buffer.from(mt[1], 'base64');
    if (cfg.putPhoto) await cfg.putPhoto(id, buf); else { photosMem.set(id, buf); if (photosMem.size > 200) photosMem.delete(photosMem.keys().next().value); }
    const url = `${WEBAPP_URL}/photo/${id}.jpg`;
    try {
      const r = await tg('savePreparedInlineMessage', {
        user_id: +uid, allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true, allow_bot_chats: false,
        result: { type: 'photo', id, photo_url: url, thumbnail_url: url, caption: String(m.caption || 'Нарды от Кондрата').slice(0, 300),
          reply_markup: { inline_keyboard: [[{ text: '🎲 Сыграть в нарды', url: 'https://t.me/' + botUsername }]] } },
      });
      if (r.ok) return send(uid, { t: 'prepared', id: r.result.id });
      log('savePreparedInlineMessage: ' + r.description); err(uid, 'Телеграм не дал отправить фото: ' + r.description);
    } catch (e) { err(uid, 'Нет связи с Телеграмом'); }
  }
  async function getPhoto(id) { if (!/^[0-9a-f]{16}$/.test(id)) return null; return cfg.getPhoto ? cfg.getPhoto(id) : photosMem.get(id) || null; }

  // ---------- админка ----------
  function adminText() {
    const all = Object.values(users), day = Date.now() - 864e5;
    const inGames = [...games.values()].filter(g => !g.over).length;
    const top = all.slice().sort((a, b) => b.rating - a.rating).slice(0, 3).map((u, i) => `${i + 1}. ${u.name} — ${u.rating}`).join('\n') || '—';
    const fresh = all.filter(u => u.created > day).sort((a, b) => b.created - a.created).slice(0, 5).map(u => u.name).join(', ') || '—';
    return `🛠 Админка «Нарды от Кондрата»

👥 Всего игроков: ${all.length} (новых за сутки: ${all.filter(u => u.created > day).length})
🤖 Запускали бота: ${all.filter(u => u.bot).length}
🎮 Открывали игру: ${all.filter(u => u.app).length}
📅 Заходили за сутки: ${all.filter(u => (u.seen || 0) > day).length}

🟢 Сейчас в игре: ${online.size}
🎲 Идёт партий: ${inGames}, ищут соперника: ${queue.length}
📊 Партий сегодня: ${meta.day === today() ? meta.gamesDay || 0 : 0}, всего: ${meta.gamesTotal || 0}

🏆 Топ:
${top}

🆕 Новенькие: ${fresh}`;
  }
  const adminKb = { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'adm' }], [{ text: '🎲 Играть', web_app: { url: WEBAPP_URL + '/' } }]] };
  function touchBotUser(from) {
    if (!from || !from.id) return null;
    const u = getUser(String(from.id), [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 40), from.username);
    if (!u.bot) { u.bot = Date.now(); save(u); }
    return u;
  }

  // ответ боту отдаётся прямо в ответ на webhook
  function onUpdate(up) {
    if (up.callback_query) {
      const q = up.callback_query;
      tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => { });
      const chat_id = q.message && q.message.chat.id; if (!chat_id) return null;
      if (q.data === 'rules') return { method: 'sendMessage', chat_id, text: RULES };
      if (q.data === 'adm' && meta.admin && String(q.from.id) === meta.admin) return { method: 'editMessageText', chat_id, message_id: q.message.message_id, text: adminText(), reply_markup: adminKb };
      if (q.data === 'top') return { method: 'sendMessage', chat_id, text: topText() };
      return null;
    }
    const msg = up.message; if (!msg || !msg.text) return null;
    const [cmd0, payload] = msg.text.trim().split(/\s+/);
    const cmd = cmd0.split('@')[0].toLowerCase();
    const chat_id = msg.chat.id, M = (text, reply_markup) => ({ method: 'sendMessage', chat_id, text, ...(reply_markup ? { reply_markup } : {}) });
    if (!WEBAPP_URL) return M('Игра ещё не настроена: на сервере не задан WEBAPP_URL.');
    const me = touchBotUser(msg.from);
    if (cmd === '/admin' && me) {
      if (!meta.admin) {
        meta.admin = me.id; saveMeta();
        tg('setMyCommands', { scope: { type: 'chat', chat_id }, commands: [
          { command: 'admin', description: 'Админка' }, { command: 'start', description: 'Главное меню' }, { command: 'play', description: 'Играть' },
          { command: 'top', description: 'Доска почёта' }, { command: 'rules', description: 'Правила' }] }).catch(() => { });
        return M('👑 Ты записан как хозяин бота. Эта команда теперь работает только у тебя.\n\n' + adminText(), adminKb);
      }
      if (meta.admin === me.id) return M(adminText(), adminKb);
    }
    if (cmd === '/start' && /^fr_/i.test(payload || '') && me) {
      const fid = payload.slice(3), f = users[fid];
      if (f && fid !== me.id) {
        const was = me.friends.includes(fid); addFriends(me.id, fid); save(me); save(f);
        if (!was) { send(fid, { t: 'toast', text: `${me.name} теперь твой кореш` }); sendMe(fid); if (!online.has(fid)) tg('sendMessage', { chat_id: fid, text: `🤝 ${me.name} принял твоё приглашение, теперь вы кореша.` }).catch(() => { }); }
        return M(`🤝 Теперь ты кореш с ${f.name}. Он появится у тебя во вкладке «Кореша», оттуда можно звать друг друга на партию.`, menuKeyboard());
      }
    }
    if (cmd === '/start' && /^room_/i.test(payload || '')) {
      const code = payload.replace(/^room_?/i, '').toUpperCase();
      return M('🎲 Тебя позвали сыграть в нарды! Жми кнопку, чтобы сесть за доску.', { inline_keyboard: [[{ text: 'Сесть за доску', web_app: { url: appUrl('?room=' + code) } }]] });
    }
    if (cmd === '/play') return M('Садись за доску 👇', { inline_keyboard: [[{ text: '🎲 Играть', web_app: { url: appUrl() } }]] });
    if (cmd === '/rules') return M(RULES);
    if (cmd === '/top') return M(topText());
    if (cmd === '/invite') return M('Скинь корешу ссылку на бота, или открой игру → «Играть» → «Вызвать кореша»: там будет ссылка прямо на твою партию.', { inline_keyboard: [[menuKeyboard().inline_keyboard[2][0]]] });
    return M('Здорово, арестант! Это «Нарды от Кондрата».\n\nОдевай своего персонажа, набивай наколки, обставляй хату и играй в нарды с корешами на сигареты.\n\n⚠️ Это первая тестовая версия: что-то может работать криво.', menuKeyboard());
  }
  // проверка заголовка webhook; true — запрос от Телеграма (или без секрета)
  async function fetchName() { if (!BOT_TOKEN || botUsername) return; try { const r = await tg('getMe'); if (r.ok) botUsername = r.result.username; } catch (e) { } }
  function hookAllowed(secretHeader) { return !secretHeader || secretHeader === HOOK_SECRET; }
  async function botSetup(opts) {
    if (!BOT_TOKEN) return log('BOT_TOKEN не задан — вход в игру через Телеграм работать не будет');
    try {
      const r = await tg('getMe');
      if (!r.ok) return log('Телеграм не принял токен: ' + r.description);
      botUsername = r.result.username; log('Бот: @' + botUsername);
      await tg('setMyCommands', { commands: [
        { command: 'start', description: 'Главное меню' }, { command: 'play', description: 'Играть в нарды' },
        { command: 'rules', description: 'Правила' }, { command: 'top', description: 'Доска почёта' }, { command: 'invite', description: 'Позвать кореша' },
      ] });
      if (!WEBAPP_URL) { log('WEBAPP_URL не задан'); return (opts && opts.poll) ? poll() : null; }
      await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: appUrl() } } });
      const h = await tg('setWebhook', { url: WEBAPP_URL + HOOK_PATH, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
      log('Webhook: ' + (h.ok ? 'включён' : h.description));
      return h.ok;
    } catch (e) { log('Сервер не может сам связаться с Телеграмом (' + e.message + ')'); }
  }
  async function poll() {
    await tg('deleteWebhook', {}).catch(() => { });
    let offset = 0;
    for (; ;) {
      try {
        const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
        for (const up of r.result || []) { offset = up.update_id + 1; const o = onUpdate(up); if (o) { const { method, ...rest } = o; await tg(method, rest).catch(() => { }); } }
      } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
    }
  }

  return { onMessage, onClose, tick, busy, onUpdate, hookAllowed, botSetup, fetchName, getPhoto, HOOK_PATH, get botUsername() { return botUsername; } };
}

module.exports = { createCore };
