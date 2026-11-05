// «Нарды от Кондрата» — логика сервера: игроки, онлайн-партии, Телеграм-бот.
// Общая для запуска на Node (server.js) и на Cloudflare (worker.js).
const crypto = require('crypto');
const { Buffer } = require('buffer');
const E = require('./engine.js');
const C = require('./catalog.js');
const ITEMS = require('./items.json'); // цены барахолки (собираются из игры)
const RANK_NAMES = C.RANKS.map(r => r.name);

// покупки за Telegram Stars (цены в звёздах). Что входит — решает только сервер.
// за рыжьё (вторая валюта). Рыжьё покупается только за звёзды Телеграма (GOLD ниже)
const STARS = {
  pk500: { title: 'Пачка: 500 сигарет', stars: 100, cigs: 500 },
  pk1500: { title: 'Блок: 1500 сигарет', stars: 250, cigs: 1500 },
  pk4000: { title: 'Ящик: 4000 сигарет', stars: 500, cigs: 4000 },
  set1: { title: 'Набор «Первоход»', stars: 200, cigs: 500, items: ['o_05_sportivka', 'h_3', 'b_3', 'g_2', 'br_2'] },
  set2: { title: 'Набор «Блатной»', stars: 400, cigs: 1000, items: ['o_13_malinovyi', 'n_3', 'w_3', 'd_4', 'g_1', 'br_1'] },
  set3: { title: 'Набор «Хата под ключ»', stars: 500, cigs: 0, items: ['l_4', 'wl_5', 'pt_1', 'fd_6', 'm_3', 'a_3'] },
  spin: { title: 'Прокрут колеса фортуны', stars: 50, cigs: 0, spins: 1 },
  pass: { title: 'Блатная ходка на сезон', stars: 500, cigs: 0, pass: 1 },
  chif1: { title: 'Кружка чифира', stars: 10, cigs: 0, chif: 1 },
  chif5: { title: 'Пять кружек чифира', stars: 40, cigs: 0, chif: 5 },
  vip: { title: 'Блатной статус на 30 дней', stars: 750, cigs: 0, vip: 30 },
};
for (const k in STARS) STARS[k].gold = STARS[k].stars;   // цена в рыжье = старой цене в звёздах
const GOLD = {
  gd50: { title: 'Горсть рыжья: 50', stars: 50, give: 50 },
  gd100: { title: 'Кисет рыжья: 110', stars: 100, give: 110 },
  gd250: { title: 'Мешочек рыжья: 290', stars: 250, give: 290 },
  gd500: { title: 'Котелок рыжья: 600', stars: 500, give: 600 },
  gd1000: { title: 'Сундук рыжья: 1250', stars: 1000, give: 1250 },
};
const CHIF_BONUS = 0.25;
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
  if (meta.admin && !meta.admins) { meta.admins = [String(meta.admin)]; } // кто уже стал админом — остаётся
  let metaTimer = null;
  function saveMeta() { if (metaTimer) return; metaTimer = setTimeout(() => { metaTimer = null; cfg.saveMeta && cfg.saveMeta(meta); }, 1000); }
  const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // по Москве
  const dirty = new Set(); let saveTimer = null;
  function save(u) { if (u) dirty.add(u.id); if (saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; const ids = [...dirty]; dirty.clear(); ids.forEach(id => users[id] && cfg.saveUser && cfg.saveUser(users[id])); }, 1000); }
  // сервер перезапустился посреди партии (обновление) — партия пропала, ставку возвращаем
  for (const u of Object.values(users)) if (u && u.hold) { u.cigs = (u.cigs || 0) + (u.hold.s | 0); u.refund = u.hold.s | 0; delete u.hold; save(u); }
  let botUsername = (cfg.BOT_USERNAME || '').replace(/^@/, '').trim();
  // ---------- этап 6: статистика по дням ----------
  function dayStat(k, n) {
    const d = today(); meta.days = meta.days || {}; const x = meta.days[d] = meta.days[d] || {};
    x[k] = (x[k] || 0) + (n == null ? 1 : n);
    const keys = Object.keys(meta.days); if (keys.length > 60) keys.sort().slice(0, keys.length - 60).forEach(k2 => delete meta.days[k2]);
    saveMeta();
  }

  // ---------- игроки ----------
  function getUser(id, name, username) {
    let u = users[id];
    if (!u) { u = users[id] = { id, name: name || 'Игрок', username: username || '', cigs: 2500, rating: 0, wins: 0, losses: 0, eq: null, lvl: 1, friends: [], created: Date.now() }; dayStat('new'); }
    if (u.dauDay !== today()) { u.dauDay = today(); dayStat('dau'); }
    if (name) u.name = name;
    if (username) u.username = username;
    u.seen = Date.now(); save(u);
    return u;
  }
  const isVip = u => (u.vipTill || 0) > Date.now();
  const freeSpins = u => (isVip(u) ? 3 : 1) - (u.spinDay === today() ? (u.spinN == null ? 1 : u.spinN) : 0);
  function eqv(u) { if ((u.capTill || 0) > Date.now()) return eqv0({ ...u, eq: { ...(u.eq || {}), hat: 'h_10' } }); return eqv0(u); }
  function eqv0(u) { return u.photo ? { ...(u.eq || {}), _av: '/ava/' + u.id + '.jpg?v=' + crypto.createHash('md5').update(u.photo).digest('hex').slice(0, 6) } : u.eq; }
  function publicUser(u) { return { id: u.id, name: u.name, rating: u.rating, rank: C.rankOf(u.rating), wins: u.wins, losses: u.losses, eq: eqv(u), lvl: u.lvl || 1, mars: u.mars || 0, best: u.best || 0, longG: u.longG || 0, shortG: u.shortG || 0, created: u.created, title: u.title && ACH_BY[u.title] ? ACH_BY[u.title].title : '', brig: (b => b ? { id: b.id, name: b.name, emblem: b.emblem || 0 } : null)(u.brig && meta.brig && meta.brig[u.brig]), num: String(u.id).replace(/\D/g, '').slice(-4).padStart(4, '0'), smotr: isSmotr(u.id), vip: isVip(u), auth: u.authN | 0, cap: (u.capTill || 0) > Date.now() }; }
  function meView(u) { const dT = dnum(Date.now()), ld = u.lastDaily ? dnum(u.lastDaily) : -9; return { ...publicUser(u), dailyReady: ld !== dT, streakD: u.streakD | 0, tasksReady: (() => { const q = quests(u); return q.list.filter(x => !x.c && x.p >= QPOOL[x.i].n).length + (freeSpins(u) > 0 ? 1 : 0) + passReady(u); })(), unread: unread(u), bchat: chatUnread(u), admin: isAdmin(u.id), brigInv: (u.brigInv || []).length, giftLeft: u.giftDay === today() ? 500 - (u.giftSum | 0) : 500, cigs: u.cigs, gold: u.gold | 0, vipTill: isVip(u) ? u.vipTill : 0, goldFirst: !!u.goldFirst, boss: bossView(u), wq: wqView(u), chif: u.chif | 0, chifOn: !!u.chifOn && (u.chif | 0) > 0, owned: u.owned || [], lastDaily: u.lastDaily || 0, botWins: u.botWins || 0, friends: u.friends.map(f => users[f]).filter(Boolean).map(f => ({ ...publicUser(f), online: online.has(f.id) })) }; }
  // внешний вид и счёт игрока присылает само приложение (сырой тестовый вариант)
  // кошелёк живёт на сервере. С телефона принимается только внешний вид (и только из того, что куплено).
  // Один раз, при переходе со старой версии, сервер забирает с телефона сигареты, рейтинг и покупки.
  const rankOk = (u, it) => !it.rank || RANK_NAMES.indexOf(C.rankOf(u.rating)) >= RANK_NAMES.indexOf(it.rank);
  const canUse = (u, id) => { const it = ITEMS[id]; if (!it) return false; return u.owned.includes(id) || (!it.price && rankOk(u, it)) || (it.free && rankOk(u, it)) || (!!it.ach && !it.price); };
  function applyProf(u, p) {
    if (!p || typeof p !== 'object') return;
    if (!Array.isArray(u.owned)) u.owned = [];
    if (!u.eco) {
      u.eco = Date.now();
      if (Number.isFinite(+p.cigs)) u.cigs = Math.max(0, Math.min(20000, Math.floor(+p.cigs)));
      if (Number.isFinite(+p.rating)) u.rating = Math.max(u.rating || 0, Math.min(5000, Math.floor(+p.rating)));
      if (Array.isArray(p.owned)) u.owned = [...new Set(p.owned.filter(id => ITEMS[id]))];
      if (Number.isFinite(+p.lastDaily)) u.lastDaily = +p.lastDaily;
    }
    if (p.eq && typeof p.eq === 'object' && JSON.stringify(p.eq).length < 2000) {
      const eq = {};
      for (const k in p.eq) { const v = p.eq[k]; if (k === 'tats' && v && typeof v === 'object') { eq.tats = {}; for (const t in v) if (canUse(u, v[t])) eq.tats[t] = v[t]; } else if (typeof v === 'string' && canUse(u, v)) eq[k] = v; }
      u.eq = eq;
      const lv = eq.level && /^l_(\d+)$/.exec(eq.level); u.lvl = lv ? Math.max(1, Math.min(11, +lv[1])) : 1;
    }
    save(u);
  }
  function starsDesc(p) { const names = (p.items || []).map(id => ITEMS[id] && ITEMS[id].name).filter(Boolean); return [p.cigs ? `${p.cigs} сигарет` : '', names.length ? names.join(', ') : ''].filter(Boolean).join(' + ') || p.title; }
  // оплата прошла: выдаём (повторная доставка того же платежа ничего не даёт)
  function giveProd(u, p) {
    if (!Array.isArray(u.owned)) u.owned = [];
    u.cigs += p.cigs || 0; if (p.spins) u.spins = (u.spins | 0) + p.spins; if (p.pass) ps(u).prem = 1; if (p.chif) u.chif = (u.chif | 0) + p.chif; if (p.vip) u.vipTill = Math.max(Date.now(), u.vipTill || 0) + p.vip * 864e5; (p.items || []).forEach(x => { if (ITEMS[x] && !u.owned.includes(x)) u.owned.push(x); });
  }
  function grantStars(uid, id, charge, paid) {
    const g = GOLD[id], p = g || STARS[id], u = users[uid]; if (!p || !u) return false;
    meta.paid = meta.paid || {}; if (meta.paid[charge]) return false; meta.paid[charge] = uid;
    if (g) { const x2 = !u.goldFirst; u.goldFirst = Date.now(); u.gold = (u.gold | 0) + g.give * (x2 ? 2 : 1); if (x2) send(uid, { t: 'toast', text: `Первая покупка — рыжья вдвойне: +${g.give * 2}` }); } else giveProd(u, p);
    u.stars = (u.stars || 0) + (paid || p.stars); dayStat('stars', paid || p.stars);
    meta.sales = (meta.sales || []).concat([{ at: Date.now(), uid, id, stars: paid || p.stars, charge }]).slice(-1000);
    addLog('оплата', `${u.name} купил(а) «${p.title}» за ${paid || p.stars} ⭐`);
    save(u); saveMeta(); sendMe(uid); send(uid, { t: 'paid', id, title: p.title });
    return true;
  }
  function addLog(by, text) { meta.alog = (meta.alog || []).concat([{ at: Date.now(), by, text }]).slice(-200); saveMeta(); }

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
      const bu = users[String(tg.id)]; if (bu && bu.banned) { try { sock.send(JSON.stringify({ t: 'err', text: 'Доступ закрыт администратором' + (bu.banReason ? ': ' + bu.banReason : ''), fatal: true })); } catch (e) { } return; }
      const uid = sock.uid = String(tg.id);
      const old = online.get(uid); if (old && old !== sock) { try { old.send(JSON.stringify({ t: 'kicked' })); } catch (e) { } try { old.close(); } catch (e) { } }
      online.set(uid, sock);
      const u = getUser(uid, [tg.first_name, tg.last_name].filter(Boolean).join(' ').slice(0, 40), tg.username);
      const fresh = !u.app;
      if (tg.photo_url && /^https:\/\/[a-z0-9.-]*(t\.me|telegram\.org|telesco\.pe)\//i.test(tg.photo_url)) { if (u.photo !== tg.photo_url) { u.photo = tg.photo_url; save(u); } }
      if (!u.app) { u.app = Date.now(); save(u); }
      if (u.seenAt && Date.now() - u.seenAt > 7 * 864e5) { u.cigs += COMEBACK; pushMal(uid, { fn: 'Администрация', text: `С возвращением! Тебя тут ждали — держи ${COMEBACK} сигарет на разгон.`, sys: true }); }
      u.seenAt = Date.now(); save(u);
      if (fresh) { const rm = String(start || '').match(/^ref_(\w+)$/i); const rr = rm ? rm[1] : (rooms.get(String(m.room || start || '').replace(/^room_?/i, '').toUpperCase()) || {}).host; setRef(u, rr); }
      applyProf(u, m.prof);
      sendMe(uid);
      const gid = userGame.get(uid);
      if (!gid || !games.has(gid)) send(uid, { t: 'nogame', refund: u.refund || 0 });
      if (u.refund) { delete u.refund; save(u); }
      if (gid && games.has(gid)) { const g = games.get(gid); g.away[g.uids.indexOf(uid)] = 0; g.resync = true; sendGame(g); g.resync = false; }
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
      leaveQueue(uid); unwatch(uid);
      const gid = userGame.get(uid);
      if (gid && games.has(gid)) { const g = games.get(gid); g.away[g.uids.indexOf(uid)] = Date.now(); }
    }
  }


  // ================= Этап 3: малявы, подарки, общак (бригады) =================
  const MAT = /(х[уy][йеёяию]|п[иi]зд|[её]б[аеиуо]|ебл|бл[яd]|сук[аио]|муд[аио]к|п[иеё]д[оа]р|залуп|г[аo]нд[оo]н|шлюх|\bхер|д[оa]лб[оа][её]б|уеб|еб[ао]н)/i;
  function clean(t) { return String(t || '').replace(/[\u0000-\u001f]/g, ' ').split(/(\s+)/).map(w => MAT.test(w) ? w[0] + '***' : w).join('').trim(); }
  const dayKey = () => today();
  function pushMal(to, m) {
    const r = users[to]; if (!r) return;
    m.id = m.id || crypto.randomBytes(5).toString('hex'); m.at = m.at || Date.now();
    r.inbox = [m].concat(r.inbox || []).slice(0, 60); save(r);
    if (online.has(to)) { send(to, { t: 'mal', m }); sendMe(to); }
    else if (BOT_TOKEN && !String(to).startsWith('dev') && m.from && (r.malTg || 0) < Date.now() - 600e3) {   // не чаще раза в 10 минут
      r.malTg = Date.now(); tg('sendMessage', { chat_id: to, text: `📨 Тебе малява от ${m.fn}${m.gift ? ' (подарок 🎁)' : ''}. Глянь, пока не остыла.\n\n${m.text.slice(0, 300)}`, reply_markup: { inline_keyboard: [[{ text: 'Открыть малявы', web_app: { url: appUrl('?tab=mal') } }]] } }).catch(() => { });
    }
  }
  function unread(u) { return (u.inbox || []).filter(x => !x.read).length; }
  // --- бригады ---
  if (!meta.brig) meta.brig = {};
  const BRIG = { max: 15, cost: 5000, emblem: 2000, bonus: 10000, bonusDays: 30, emblems: 9 };
  function brigOf(u) { const b = u && u.brig && meta.brig[u.brig]; if (b && !b.members.includes(u.id)) { delete u.brig; return null; } return b || null; }
  function brigRole(b, uid) { return !b ? '' : b.owner === uid ? 'owner' : (b.deps || []).includes(uid) ? 'dep' : (b.smot || []).includes(uid) ? 'smot' : 'member'; }
  function brigView(b, full) {
    const v = { id: b.id, name: b.name, emblem: b.emblem || 0, n: b.members.length, pot: b.pot | 0, bonus: (b.bonusTill || 0) > Date.now() ? b.bonusTill : 0, owner: b.owner, rating: b.rp | 0, wins: b.rpW | 0, cups: b.cups | 0, c1: b.cup1 | 0, c2: b.cup2 | 0, c3: b.cup3 | 0, warsWon: b.wars | 0, month: b.mp && b.mp.id === sid() ? b.mp.pts : 0 };
    if (full) { v.members = b.members.map(x => users[x]).filter(Boolean).map(x => ({ ...publicUser(x), online: online.has(x.id), role: brigRole(b, x.id), gave: (b.gave || {})[x.id] | 0, pts: x.brigPts | 0 })); v.log = (b.log || []).slice(0, 20); v.deps = b.deps || []; v.smot = b.smot || []; v.war = warView(b); v.req = (b.req || []).filter(r => users[r.id] && !users[r.id].brig).map(r => ({ id: r.id, name: users[r.id].name, rating: users[r.id].rating | 0 })); }
    return v;
  }
  // ---------- битва общаков: война на неделю (А) + кубок месяца (Г) ----------
  const WAR_DAYS = 7, WAR_STAKES = [1000, 3000, 5000, 10000], CUP_PRIZE = [15000, 10000, 5000];
  function warOf(b) { warRoll(); const w = b && b.war && (meta.wars || {})[b.war]; return w && !w.done && w.start ? w : null; }
  function warRoll() {
    const W = meta.wars || {}; const now = Date.now();
    for (const w of Object.values(W)) {
      if (w.done) continue;
      if (!w.start && now - w.at > 24 * 3600e3) { w.done = 'expired'; const a = meta.brig[w.a]; if (a) { a.pot += w.stake; if (a.war === w.id) delete a.war; } continue; }   // вызов не приняли за сутки — ставка назад
      if (w.start && now >= w.end) {
        const a = meta.brig[w.a], b = meta.brig[w.b]; w.done = 'over';
        const win = w.pa === w.pb ? null : (w.pa > w.pb ? a : b), lose = win === a ? b : a;
        if (!win) { if (a) a.pot += w.stake; if (b) b.pot += w.stake; }
        else { win.pot += w.stake * 2; win.wars = (win.wars | 0) + 1; brigLog(win, `Победа в войне с «${lose ? lose.name : '?'}» ${Math.max(w.pa, w.pb)}:${Math.min(w.pa, w.pb)}, +${w.stake * 2} в общак`); if (lose) brigLog(lose, `Проиграли войну «${win.name}» ${Math.min(w.pa, w.pb)}:${Math.max(w.pa, w.pb)}`); }
        [a, b].forEach(x => { if (x && x.war === w.id) delete x.war; });
      }
    }
  }
  function warView(b) {
    warRoll(); const w = b && b.war && (meta.wars || {})[b.war]; if (!w || w.done) return null;
    const me = w.a === b.id, other = meta.brig[me ? w.b : w.a];
    return { id: w.id, vs: other ? other.name : '?', vsId: other ? other.id : null, stake: w.stake, my: me ? w.pa : w.pb, their: me ? w.pb : w.pa, started: !!w.start, left: w.start ? Math.max(0, w.end - Date.now()) : 0, incoming: !w.start && !me };
  }
  function cupRoll() {
    const id = sid(); if (meta.cup === id) return; const prev = meta.cup; meta.cup = id;
    if (!prev) return;
    const top = Object.values(meta.brig).filter(b => b.mp && b.mp.id === prev && b.mp.pts > 0).sort((a, b) => b.mp.pts - a.mp.pts).slice(0, 3);
    top.forEach((b, i) => { b.pot += CUP_PRIZE[i]; b.cups = (b.cups | 0) + (i === 0 ? 1 : 0); b['cup' + (i + 1)] = (b['cup' + (i + 1)] | 0) + 1; brigLog(b, `Кубок общаков: ${i + 1}-е место за месяц, +${CUP_PRIZE[i]} в общак`); });
    meta.cupLast = { id: prev, top: top.map(b => ({ id: b.id, name: b.name, pts: b.mp.pts })) };
  }
  function cupView() { cupRoll(); const id = sid(); return { prizes: CUP_PRIZE, last: meta.cupLast || null, top: Object.values(meta.brig).filter(b => b.mp && b.mp.id === id && b.mp.pts > 0).sort((a, b) => b.mp.pts - a.mp.pts).slice(0, 10).map(b => ({ id: b.id, name: b.name, emblem: b.emblem || 0, pts: b.mp.pts })) }; }
  function brigLog(b, t) { b.log = [{ at: Date.now(), t }].concat(b.log || []).slice(0, 40); }
  function brigSend(b, msg) { b.members.forEach(x => send(x, msg)); }
  function brigUpdate(b) { saveMeta(); b.members.forEach(x => { if (online.has(x)) { send(x, { t: 'brig', b: brigView(b, true) }); sendMe(x); } }); }
  // --- чат бригады (базар): хранится отдельно от meta ---
  const chats = cfg.chats || (meta.chats = meta.chats || {});
  function saveChat(id) { if (cfg.saveChat) cfg.saveChat(id, chats[id] || null); else saveMeta(); }
  function chatUnread(u) { const b = u && u.brig && meta.brig[u.brig]; const l = b && chats[b.id]; if (!l || !l.length) return 0; const seen = u.bcSeen || 0; let n = 0; for (let i = l.length - 1; i >= 0 && l[i].at > seen; i--) if (l[i].uid !== u.id) n++; return Math.min(n, 99); }
  function brigBonus(u) { const b = brigOf(u); return b && (b.bonusTill || 0) > Date.now() ? 0.05 : 0; }


  // ================= Этап 4: задания, серия входов, сезоны, колесо, достижения =================
  const dnum = t => Math.floor((t + 3 * 3600e3) / 864e5);   // номер дня по Москве
  const STREAK = [100, 150, 200, 250, 300, 400, 600];
  const WEEK_BONUS = 1000;   // каждый 7-й день серии сверху
  const COMEBACK = 300;
  const QPOOL = [
    { k: 'play', n: 3, r: 150, t: 'Сыграй 3 онлайн-партии' }, { k: 'win', n: 1, r: 150, t: 'Выиграй онлайн-партию' }, { k: 'win', n: 3, r: 400, t: 'Выиграй 3 онлайн-партии' },
    { k: 'bot', n: 2, r: 100, t: 'Победи бота 2 раза' }, { k: 'mars', n: 1, r: 250, t: 'Поставь марс сопернику' }, { k: 'mal', n: 2, r: 60, t: 'Отправь 2 малявы' },
    { k: 'gift', n: 1, r: 80, t: 'Подогрей кореша' }, { k: 'pot', n: 1, r: 80, t: 'Закинь в общак бригады' }, { k: 'short', n: 2, r: 150, t: 'Сыграй 2 партии в короткие' },
    { k: 'long', n: 2, r: 150, t: 'Сыграй 2 партии в длинные' }, { k: 'watch', n: 1, r: 50, t: 'Посмотри чужую партию' }, { k: 'spin', n: 1, r: 40, t: 'Крутани колесо фортуны' },
  ];
  const Q_ALL = 200;
  const WPOOL = [{ k: 'win', n: 10, r: 1000, t: 'Выиграй 10 онлайн-партий' }, { k: 'play', n: 25, r: 800, t: 'Сыграй 25 онлайн-партий' }, { k: 'mars', n: 3, r: 800, t: 'Поставь 3 марса' }];
  function wq(u) { const w = weekNo(); if (!u.wq || u.wq.w !== w) { u.wq = { w, list: WPOOL.map(() => ({ p: 0, c: 0 })) }; } return u.wq; }
  function wqView(u) { const q = wq(u); return { left: 7 - ((dnum(Date.now()) + 3) % 7), list: WPOOL.map((x, i) => ({ ...x, p: q.list[i].p, c: q.list[i].c })) }; }
  // босс недели: один раз в неделю можно сыграть против Кондрата
  const BOSS_PRIZE = 3000;
  function bossView(u) { return { prize: BOSS_PRIZE, used: u.bossW === weekNo(), won: u.bossWon === weekNo() }; }
  function hashN(str) { let h = 2166136261; for (const ch of str) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function quests(u) {
    const d = today();
    if (!u.q || u.q.d !== d) {
      const idx = [], used = new Set(); let h = hashN(u.id + d);
      while (idx.length < 3) { const i = h % QPOOL.length; h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0; if (!used.has(QPOOL[i].k)) { used.add(QPOOL[i].k); idx.push(i); } }
      u.q = { d, list: idx.map(i => ({ i, p: 0, c: 0 })), all: 0 }; save(u);
    }
    return u.q;
  }
  function qEvent(u, k, n) { if (!u) return; { const w = wq(u); WPOOL.forEach((Q, i) => { const x = w.list[i]; if (Q.k === k && x.p < Q.n) x.p = Math.min(Q.n, x.p + (n || 1)); }); } const q = quests(u); let ch = false; q.list.forEach(x => { const Q = QPOOL[x.i]; if (Q.k === k && x.p < Q.n) { x.p = Math.min(Q.n, x.p + (n || 1)); ch = true; } }); if (ch) { save(u); if (online.has(u.id)) send(u.id, tasksView(u)); } }
  const WHEEL = [{ t: '25', c: 25, w: 22 }, { t: '100', c: 100, w: 16 }, { t: '50', c: 50, w: 22 }, { t: 'вещь', item: 1, w: 9 }, { t: '200', c: 200, w: 12 }, { t: '75', c: 75, w: 11 }, { t: '500', c: 500, w: 6 }, { t: '1000', c: 1000, w: 2 }];
  const sid = () => today().slice(0, 7);
  const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const SEASON_PRIZE = [25000, 15000, 10000];
  function spts(u) { return u.sp && u.sp.id === sid() ? u.sp.pts | 0 : 0; }
  function seasonAdd(u, d) { const id = sid(); if (!u.sp || u.sp.id !== id) u.sp = { id, pts: 0 }; u.sp.pts = Math.max(0, (u.sp.pts | 0) + d); }
  // --- сезонный пропуск: 30 ступеней по 100 опыта, бесплатная и платная («Блатной пропуск») ветки ---
  const PASS_LV = 30, PASS_XP = 100;
  const PASS_FREE = { 3: { c: 100 }, 6: { c: 150 }, 9: { c: 200 }, 12: { s: 1 }, 15: { c: 300 }, 18: { c: 350 }, 21: { s: 1 }, 24: { c: 500 }, 27: { c: 600 }, 30: { c: 1000 } };
  const PASS_PREM = {}; for (let l = 1; l <= PASS_LV; l++) PASS_PREM[l] = { c: Math.round((150 + l * 15) / 10) * 10 };
  Object.assign(PASS_PREM, { 5: { s: 2 }, 8: { i: 's_11' }, 12: { c: 600, s: 1 }, 16: { i: 'w_3' }, 20: { s: 3 }, 24: { i: 'd_15' }, 30: { c: 5000, i: 'o_08_troika', t: 1 } });
  function ps(u) { const id = sid(); if (!u.ps || u.ps.id !== id) u.ps = { id, xp: 0, prem: 0, gf: [], gp: [] }; return u.ps; }
  function psAdd(u, n) { if (!u) return; const p = ps(u), was = Math.min(PASS_LV, Math.floor(p.xp / PASS_XP)); p.xp = Math.min(PASS_LV * PASS_XP, p.xp + n); const now = Math.min(PASS_LV, Math.floor(p.xp / PASS_XP)); save(u); if (now > was && online.has(u.id)) send(u.id, { t: 'toast', text: `Ходка: ступень ${now}! Загляни в «Задания» → «Сезон»` }); }
  function psGive(u, r) { let c = r.c || 0; const out = []; if (r.s) { u.spins = (u.spins | 0) + r.s; out.push(`${r.s} ${r.s === 1 ? 'прокрут' : 'прокрута'} колеса`); }
    if (r.i) { u.owned = u.owned || []; if (ITEMS[r.i] && !u.owned.includes(r.i)) { u.owned.push(r.i); out.push('вещь'); } else c += Math.round(((ITEMS[r.i] || {}).price || 1000) / 2); }
    if (r.t) u.passMax = 1; if (c) { u.cigs += c; out.unshift(c + ' сигарет'); } return c; }
  function passReady(u) { const p = ps(u), lv = Math.min(PASS_LV, Math.floor(p.xp / PASS_XP)); let n = 0; for (let l = 1; l <= lv; l++) { if (PASS_FREE[l] && !p.gf.includes(l)) n++; if (p.prem && !p.gp.includes(l)) n++; } return n ? 1 : 0; }
  function passView(u) { const p = ps(u); return { lv: Math.min(PASS_LV, Math.floor(p.xp / PASS_XP)), xp: p.xp % PASS_XP, per: PASS_XP, max: PASS_LV, prem: !!p.prem, gf: p.gf, gp: p.gp, free: PASS_FREE, paid: PASS_PREM, price: STARS.pass.stars }; }
  function seasonRoll() {
    const id = sid(); if (meta.sid === id) return; const old = meta.sid; meta.sid = id; saveMeta(); if (!old) return;
    const top = Object.values(users).filter(u => u.sp && u.sp.id === old && u.sp.pts > 0).sort((a, b) => b.sp.pts - a.sp.pts).slice(0, 3);
    top.forEach((u, i) => { u.cigs += SEASON_PRIZE[i]; u.seasonTop = (u.seasonTop | 0) + 1; save(u); achCheck(u); pushMal(u.id, { fn: 'Сезон', text: `🏆 Сезон ${old} закончился. Ты ${i + 1}-й! Награда: ${SEASON_PRIZE[i]} сигарет.` }); });
    meta.seasons = [{ id: old, top: top.map(u => ({ id: u.id, name: u.name, pts: u.sp.pts })) }].concat(meta.seasons || []).slice(0, 24); saveMeta();
  }
  const COLL = { beads: 'Все чётки', board: 'Все нарды', mug: 'Все кружки', pet: 'Все питомцы', glasses: 'Все очки', watch: 'Все часы' };
  const collOf = (u, slot) => { const all = Object.entries(ITEMS).filter(([id, it]) => it.slot === slot && it.price > 0 && !it.hidden).map(([id]) => id); const own = all.filter(id => (u.owned || []).includes(id)).length; return { n: all.length, own }; };
  const ACHS = [
    { k: 'win1', t: 'Первая кровь', d: 'Выиграть онлайн-партию', title: 'Фартовый', r: 100, ok: u => u.wins >= 1 },
    { k: 'win10', t: 'Набил руку', d: 'Выиграть 10 онлайн-партий', title: 'Бывалый игрок', r: 300, ok: u => u.wins >= 10 },
    { k: 'win50', t: 'Катала', d: 'Выиграть 50 онлайн-партий', title: 'Катала', r: 1000, ok: u => u.wins >= 50 },
    { k: 'win200', t: 'Шулер в законе', d: 'Выиграть 200 онлайн-партий', title: 'Шулер в законе', r: 3000, ok: u => u.wins >= 200 },
    { k: 'mars5', t: 'Марсоход', d: 'Поставить 5 марсов', title: 'Марсоход', r: 300, ok: u => (u.mars | 0) >= 5 },
    { k: 'mars25', t: 'Гроза марсов', d: 'Поставить 25 марсов', title: 'Гроза марсов', r: 1200, ok: u => (u.mars | 0) >= 25 },
    { k: 'str5', t: 'На кураже', d: '5 побед онлайн подряд', title: 'На кураже', r: 400, ok: u => (u.best | 0) >= 5 },
    { k: 'str10', t: 'Непобедимый', d: '10 побед онлайн подряд', title: 'Непобедимый', r: 1500, ok: u => (u.best | 0) >= 10 },
    { k: 'g100', t: 'Старожил', d: 'Сыграть 100 онлайн-партий', title: 'Старожил', r: 800, ok: u => (u.wins | 0) + (u.losses | 0) >= 100 },
    { k: 'bot50', t: 'Тренер бота', d: 'Победить бота 50 раз', title: 'Тренер бота', r: 300, ok: u => (u.botWins | 0) >= 50 },
    { k: 'ref3', t: 'Вербовщик', d: 'Привести 3 новичков, которые сыграли по 3 партии', title: 'Вербовщик', r: 600, ok: u => (u.refPaidN | 0) >= 3 },
    { k: 'boss', t: 'Бригадир', d: 'Собрать свою бригаду', title: 'Бригадир', r: 300, ok: u => !!(u.brig && meta.brig[u.brig] && meta.brig[u.brig].owner === u.id) },
    { k: 'gift5', t: 'Щедрая душа', d: 'Подогреть корешей 5 раз', title: 'Щедрая душа', r: 200, ok: u => (u.giftN | 0) >= 5 },
    { k: 'mal50', t: 'Писатель', d: 'Отправить 50 маляв', title: 'Писатель', r: 200, ok: u => (u.malTotal | 0) >= 50 },
    { k: 'login7', t: 'Не пропускает', d: 'Заходить 7 дней подряд', title: 'Не пропускает', r: 300, ok: u => (u.streakBest | 0) >= 7 },
    { k: 'login30', t: 'Прописался', d: 'Заходить 30 дней подряд', title: 'Прописался', r: 2000, ok: u => (u.streakBest | 0) >= 30 },
    { k: 'jack', t: 'Везунчик', d: 'Выбить 1000 на колесе', title: 'Везунчик', r: 0, ok: u => !!u.jackpot },
    { k: 'passmax', t: 'Хозяин сезона', d: 'Пройти Блатную ходку до конца', title: 'Хозяин сезона', r: 0, ok: u => !!u.passMax },
    { k: 'season', t: 'Чемпион сезона', d: 'Попасть в тройку сезона', title: 'Чемпион сезона', r: 0, ok: u => (u.seasonTop | 0) >= 1 },
    // жаргон нард
    { k: 'krest', t: 'Крестьянин', d: 'Проиграть 10 онлайн-партий. Не беда — все так начинали', title: 'Крестьянин', r: 100, ok: u => (u.losses | 0) >= 10 },
    { k: 'katala', t: 'Катала', d: 'Выиграть 25 партий на ставку', title: 'Катала', r: 700, ok: u => (u.stakeWins | 0) >= 25 },
    { k: 'katala100', t: 'Король катал', d: 'Выиграть 100 партий на ставку', title: 'Король катал', r: 3000, ok: u => (u.stakeWins | 0) >= 100 },
    { k: 'zaryad', t: 'Заряженные зарики', d: 'Выбросить 3 дубля подряд в одной онлайн-партии', title: 'Заряженный', r: 300, ok: u => !!u.dbl3 },
    { k: 'dushesh', t: 'Ду-шеш', d: 'Выбросить ду-шеш (6:6) 25 раз', title: 'Ду-шеш', r: 400, ok: u => ((u.dice || {})['6-6'] | 0) >= 25 },
    { k: 'c_beads', t: 'Чёточник', d: 'Собрать все чётки', title: 'Чёточник', r: 2000, coll: 'beads', ok: u => { const c = collOf(u, 'beads'); return c.n && c.own >= c.n; } },
    { k: 'c_board', t: 'Коллекционер нард', d: 'Собрать все нарды', title: 'Мастер нард', r: 3000, coll: 'board', ok: u => { const c = collOf(u, 'board'); return c.n && c.own >= c.n; } },
    { k: 'c_mug', t: 'Чифирист', d: 'Собрать все кружки', title: 'Чифирист', r: 1000, coll: 'mug', ok: u => { const c = collOf(u, 'mug'); return c.n && c.own >= c.n; } },
    { k: 'c_pet', t: 'Зоопарк в хате', d: 'Собрать всех питомцев', title: 'Дрессировщик', r: 2500, coll: 'pet', ok: u => { const c = collOf(u, 'pet'); return c.n && c.own >= c.n; } },
    { k: 'c_glasses', t: 'Очкарик', d: 'Собрать все очки', title: 'Очкарик', r: 1000, coll: 'glasses', ok: u => { const c = collOf(u, 'glasses'); return c.n && c.own >= c.n; } },
    { k: 'c_watch', t: 'Часовщик', d: 'Собрать все часы', title: 'Часовщик', r: 1000, coll: 'watch', ok: u => { const c = collOf(u, 'watch'); return c.n && c.own >= c.n; } },
    { k: 'bosswin', t: 'Обыграл Кондрата', d: 'Победить босса недели', title: 'Кондратобой', r: 0, ok: u => (u.bossWins | 0) >= 1 },
    { k: 'auth10', t: 'Авторитет', d: 'Получить 10 уважух от соперников', title: 'Авторитет', r: 500, ok: u => (u.authN | 0) >= 10 },
    { k: 'sheshbesh', t: 'Шеш-беш', d: 'Выбросить шеш-беш (6:5) 50 раз', title: 'Шеш-беш', r: 300, ok: u => ((u.dice || {})['5-6'] | 0) >= 50 },
  ];
  const ACH_BY = Object.fromEntries(ACHS.map(a => [a.k, a]));
  function achCheck(u) {
    if (!u) return; u.achs = u.achs || {}; const got = [];
    for (const a of ACHS) if (!u.achs[a.k] && a.ok(u)) { u.achs[a.k] = Date.now(); u.cigs += a.r; got.push(a); }
    if (!got.length) return; save(u);
    got.forEach(a => pushMal(u.id, { fn: 'Достижение', text: `🏅 «${a.t}»${a.r ? `: +${a.r} сигарет` : ''}. Открыт титул «${a.title}» — поставь его в «Заданиях» → «Достижения».` }));
    if (online.has(u.id)) { sendMe(u.id); send(u.id, tasksView(u)); send(u.id, { t: 'achGot', list: got.map(a => ({ k: a.k, t: a.t, d: a.d, title: a.title, r: a.r })) }); }
  }
  function tasksView(u) {
    const q = quests(u), now = Date.now(), dToday = dnum(now), last = u.lastDaily ? dnum(u.lastDaily) : -9;
    const cont = last === dToday - 1 || last === dToday, nextStreak = last === dToday ? (u.streakD | 0) : (cont ? (u.streakD | 0) + 1 : 1);
    const id = sid(), all = Object.values(users).filter(x => x.sp && x.sp.id === id && x.sp.pts > 0).sort((a, b) => b.sp.pts - a.sp.pts);
    const end = new Date(Date.UTC(+id.slice(0, 4), +id.slice(5, 7), 1)) - 3 * 3600e3;
    return { t: 'tasks', quests: q.list.map(x => ({ ...QPOOL[x.i], p: x.p, c: x.c })), qAll: q.all, qAllR: Q_ALL,
      daily: { ready: last !== dToday, streak: nextStreak, reward: Math.round((STREAK[Math.min(Math.max(nextStreak, 1), 7) - 1] + (nextStreak % 7 === 0 ? WEEK_BONUS : 0)) * (isVip(u) ? 1.5 : 1)), table: STREAK, week: WEEK_BONUS, vip: isVip(u) },
      weekly: wqView(u), boss: bossView(u),
      wheel: { free: freeSpins(u) > 0, spins: u.spins | 0, sectors: WHEEL.map(w => w.t) },
      pass: passView(u), ready: { q: (last !== dToday ? 1 : 0) + q.list.filter(x => !x.c && x.p >= QPOOL[x.i].n).length + wqView(u).list.filter(x => !x.c && x.p >= x.n).length, w: (freeSpins(u) > 0 ? 1 : 0) + (u.spins | 0), s: passReady(u) },
      season: { id, name: MONTHS[+id.slice(5, 7) - 1], left: Math.max(0, Math.ceil((end - now) / 864e5)), pts: spts(u), place: all.findIndex(x => x.id === u.id) + 1, prizes: SEASON_PRIZE,
        top: all.slice(0, 10).map(x => ({ id: x.id, name: x.name, pts: x.sp.pts, eq: eqv(x) })), last: (meta.seasons || [])[0] || null },
      achs: ACHS.map(a => ({ k: a.k, t: a.t, d: a.d, title: a.title, r: a.r, got: !!(u.achs && u.achs[a.k]), prog: a.coll ? collOf(u, a.coll) : null })), title: u.title || '' };
  }

  function handle(uid, m) {
    const u = users[uid];
    switch (m.t) {
      case 'prof': return applyProf(u, m.prof);
      case 'buy': {
        const it = ITEMS[m.id]; if (!it || !it.price) return sendMe(uid);
        if (u.owned.includes(m.id)) return sendMe(uid);
        if (!rankOk(u, it)) { err(uid, 'Нужно звание «' + it.rank + '»'); return sendMe(uid); }
        if (u.cigs < it.price) { err(uid, 'Не хватает сигарет'); return sendMe(uid); }
        u.cigs -= it.price; u.owned.push(m.id); save(u); achCheck(u); return sendMe(uid);
      }
      case 'daily': {
        const dT = dnum(Date.now()), last = u.lastDaily ? dnum(u.lastDaily) : -9; if (last === dT) return sendMe(uid);
        u.streakD = last === dT - 1 ? (u.streakD | 0) + 1 : 1; u.streakBest = Math.max(u.streakBest | 0, u.streakD);
        const r0 = STREAK[Math.min(u.streakD, 7) - 1], wk = u.streakD % 7 === 0 ? WEEK_BONUS : 0, r = Math.round((r0 + wk) * (isVip(u) ? 1.5 : 1)); u.lastDaily = Date.now(); u.cigs += r; psAdd(u, 30); save(u);
        send(uid, { t: 'toast', text: `${wk ? '🎉 Неделя без пропусков! ' : ''}С воли подогрели: +${r} 🚬${isVip(u) ? ' (блатной ×1.5)' : ''} · серия ${u.streakD} ${u.streakD % 10 === 1 && u.streakD % 100 !== 11 ? 'день' : [2, 3, 4].includes(u.streakD % 10) && ![12, 13, 14].includes(u.streakD % 100) ? 'дня' : 'дней'} подряд!` }); achCheck(u); sendMe(uid); return send(uid, tasksView(u));
      }
      case 'clean': { if (u.cigs >= 10) { u.cigs -= 10; save(u); } return sendMe(uid); }
      case 'jserr': {   // ошибка в приложении у игрока — админ видит через /errs
        if (u.jsErrAt && Date.now() - u.jsErrAt < 20000) return; u.jsErrAt = Date.now();
        meta.jserr = (meta.jserr || []).concat([{ at: Date.now(), who: u.name, scr: String(m.scr || '').slice(0, 12), msg: String(m.msg || '').slice(0, 300), ua: String(m.ua || '').slice(0, 120) }]).slice(-30); saveMeta(); return;
      }
      case 'wqClaim': {
        const q = wq(u), i = m.i | 0, Q = WPOOL[i], x = q.list[i]; if (!Q || x.c || x.p < Q.n) return;
        x.c = 1; u.cigs += Q.r; psAdd(u, 80); save(u); sendMe(uid); send(uid, { t: 'toast', text: `Задание недели: +${Q.r} сигарет` }); return send(uid, tasksView(u));
      }
      case 'bossStart': { if (u.bossW === weekNo()) return err(uid, 'Против босса играют раз в неделю. Жди понедельника'); u.bossW = weekNo(); save(u); sendMe(uid); return send(uid, { t: 'bossGo' }); }
      case 'bossWin': {
        if (u.bossW !== weekNo() || u.bossWon === weekNo()) return; u.bossWon = weekNo(); u.bossWins = (u.bossWins | 0) + 1; u.cigs += BOSS_PRIZE; psAdd(u, 100);
        addLog('босс', `${u.name} обыграл(а) Кондрата`); save(u); achCheck(u); sendMe(uid); return send(uid, { t: 'toast', text: `Ты обыграл(а) Кондрата! +${BOSS_PRIZE} сигарет` });
      }
      case 'respect': {   // уважуха сопернику после партии
        const r = lastG.get(uid); if (!r || r.resp || Date.now() - r.at > 10 * 60e3) return; const o = users[r.opp]; if (!o) return;
        r.resp = 1; o.authN = (o.authN | 0) + 1; save(o); send(uid, { t: 'toast', text: `Уважуха ушла: ${o.name}` }); if (online.has(o.id)) { send(o.id, { t: 'toast', text: `👍 ${u.name} выразил(а) уважуху` }); sendMe(o.id); } return;
      }
      case 'botgame': {   // партия с ботом закончилась: для статистики (админ видит), зарики — в профиль
        if (Date.now() - (u.botGAt || 0) < 15e3) return; u.botGAt = Date.now();
        u.botGames = (u.botGames | 0) + 1; if (m.w === 0) u.botW = (u.botW | 0) + 1; dayStat('bot'); if (m.w === 0) dayStat('botW');
        const d = m.dice && typeof m.dice === 'object' ? m.dice : {}; let tot = 0;
        for (const k in d) { const mm = /^([1-6])-([1-6])$/.exec(k), n = Math.max(0, Math.min(200, d[k] | 0)); if (mm && +mm[1] <= +mm[2] && n && tot + n <= 400) { diceAdd(u, +mm[1], +mm[2], n); tot += n; } }
        save(u); return;
      }
      case 'botwin': { // победа над ботом в тренировке: не чаще раза в 40 секунд
        const mult = Math.max(1, Math.min(3, m.mult | 0));
        if (Date.now() - (u.botAt || 0) > 40e3) { u.botAt = Date.now(); u.cigs += [10, 20, 40][Math.max(0, Math.min(2, m.lv | 0))] * mult; u.botWins = (u.botWins || 0) + 1; psAdd(u, 10); save(u); qEvent(u, 'bot'); achCheck(u); }
        return sendMe(uid);
      }
      case 'me': return sendMe(uid);
      case 'ping': return send(uid, { t: 'pong' });
      case 'promo': return usePromo(uid, m.code);
      case 'tasks': seasonRoll(); achCheck(u); return send(uid, tasksView(u));
      case 'psClaim': {   // забрать все открытые награды пропуска
        const p = ps(u), lv = Math.min(PASS_LV, Math.floor(p.xp / PASS_XP)); let c = 0, n = 0;
        for (let l = 1; l <= lv; l++) {
          if (PASS_FREE[l] && !p.gf.includes(l)) { p.gf.push(l); c += psGive(u, PASS_FREE[l]); n++; }
          if (p.prem && PASS_PREM[l] && !p.gp.includes(l)) { p.gp.push(l); c += psGive(u, PASS_PREM[l]); n++; }
        }
        if (!n) return; save(u); achCheck(u); sendMe(uid); send(uid, { t: 'psGot', n, cigs: c }); return send(uid, tasksView(u));
      }
      case 'qClaim': {
        const q = quests(u), x = q.list[m.i | 0]; if (!x) return; const Q = QPOOL[x.i];
        if (x.c || x.p < Q.n) return; x.c = 1; u.cigs += Q.r; let extra = 0; psAdd(u, 40);
        if (!q.all && q.list.every(y => y.c)) { q.all = 1; u.cigs += Q_ALL; extra = Q_ALL; }
        save(u); sendMe(uid); send(uid, { t: 'toast', text: `Задание выполнено: +${Q.r}${extra ? ` и +${extra} за все три` : ''} сигарет` }); return send(uid, tasksView(u));
      }
      case 'spin': {
        if (m.test && isAdmin(uid)) { let sm = WHEEL.reduce((a, w) => a + w.w, 0), rr = crypto.randomInt(sm), kk = 0; while (rr >= WHEEL[kk].w) { rr -= WHEEL[kk].w; kk++; } return send(uid, { t: 'spun', k: kk, cigs: WHEEL[kk].c || 0, item: WHEEL[kk].item ? 'test' : null, test: true }); }
        const free = freeSpins(u) > 0; if (!free && !(u.spins > 0)) return err(uid, 'Бесплатные прокруты закончились. Ещё один можно взять за 50 рыжья');
        if (free) { if (u.spinDay !== today()) { u.spinDay = today(); u.spinN = 0; } u.spinN = (u.spinN | 0) + 1; } else u.spins--;
        let sum = WHEEL.reduce((a, w) => a + w.w, 0), r = crypto.randomInt(sum), k = 0; while (r >= WHEEL[k].w) { r -= WHEEL[k].w; k++; }
        const w = WHEEL[k]; let text;
        if (w.item) {
          const pool = Object.entries(ITEMS).filter(([id, it]) => it.price > 0 && it.price <= 900 && !it.rank && !it.ach && !it.stars && !(u.owned || []).includes(id) && !/^(z_|l_)/.test(id));
          if (pool.length) { const [id] = pool[crypto.randomInt(pool.length)]; u.owned = u.owned || []; u.owned.push(id); text = 'вещь'; send(uid, { t: 'spun', k, item: id }); }
          else { u.cigs += 300; send(uid, { t: 'spun', k, cigs: 300 }); }
        } else { u.cigs += w.c; if (w.c >= 1000) u.jackpot = 1; send(uid, { t: 'spun', k, cigs: w.c }); }
        save(u); qEvent(u, 'spin'); achCheck(u); setTimeout(() => sendMe(uid), 4500); return send(uid, tasksView(u));
      }
      case 'setTitle': { if (m.k && !(u.achs && u.achs[m.k])) return; u.title = m.k || ''; save(u); sendMe(uid); return send(uid, tasksView(u)); }

      // ---------- малявы ----------
      case 'mals': if ((u.inbox || []).some(x => !x.read)) { u.inbox.forEach(x => { x.read = 1; }); save(u); sendMe(uid); } return send(uid, { t: 'mals', inbox: u.inbox || [], sent: u.sent || [] });
      case 'mal': {
        const to = String(m.to || ''), r = users[to]; if (!r || to === uid) return err(uid, 'Некому отправить');
        if (u.muted && u.muted > Date.now()) return err(uid, 'Тебе пока запрещено писать малявы');
        let text = clean(String(m.text || '').slice(0, 300)); if (text.length < 1) return err(uid, 'Пустая малява');
        const now = Date.now(); if (now - (u.malAt || 0) < 4000) return err(uid, 'Не так быстро'); u.malAt = now;
        if (u.malDay !== dayKey()) { u.malDay = dayKey(); u.malN = 0; } if (++u.malN > 150) return err(uid, 'На сегодня хватит маляв');
        const msg = { from: uid, fn: u.name, text };
        pushMal(to, msg);
        u.sent = [{ id: msg.id, to, tn: r.name, text, at: msg.at }].concat(u.sent || []).slice(0, 40); u.malTotal = (u.malTotal | 0) + 1; save(u); qEvent(u, 'mal'); achCheck(u);
        return send(uid, { t: 'toast', text: 'Малява ушла' });
      }
      case 'malReport': {
        const x = (u.inbox || []).find(y => y.id === m.id); if (!x || !x.from || x.rep) return;
        x.rep = 1; save(u);
        meta.reports = [{ at: Date.now(), by: uid, bn: u.name, about: x.from, an: x.fn, text: x.text }].concat(meta.reports || []).slice(0, 200); saveMeta();
        (meta.admins || []).forEach(a => tg('sendMessage', { chat_id: a, text: `🚨 Жалоба на маляву\nОт: ${u.name} (id ${uid})\nНа: ${x.fn} (id ${x.from})\n\n«${x.text}»\n\nЗаткнуть на сутки: /mute ${x.from}\nЗабанить: /ban ${x.from}` }).catch(() => { }));
        return send(uid, { t: 'toast', text: 'Жалоба ушла админам' });
      }
      case 'malDel': u.inbox = (u.inbox || []).filter(y => y.id !== m.id); save(u); return send(uid, { t: 'mals', inbox: u.inbox, sent: u.sent || [] });
      // ---------- подарки ----------
      case 'gift': {
        const to = String(m.to || ''), r = users[to]; if (!r || to === uid) return err(uid, 'Некому дарить');
        if (!u.friends.includes(to)) return err(uid, 'Дарить можно только корешам');
        const note = clean(String(m.text || '').slice(0, 120));
        if (m.item) {
          const it = ITEMS[m.item]; if (!it || !it.price || it.rank || it.ach) return err(uid, 'Это нельзя подарить');
          if ((r.owned || []).includes(m.item)) return err(uid, 'У кореша это уже есть');
          if (u.cigs < it.price) return err(uid, 'Не хватает сигарет');
          u.cigs -= it.price; r.owned = (r.owned || []).concat([m.item]); save(u); save(r);
          pushMal(to, { from: uid, fn: u.name, gift: { item: m.item }, text: `🎁 Подарил тебе: ${m.name ? String(m.name).slice(0, 40) : 'вещь'}. Уже лежит у тебя в барахолке.${note ? '\n' + note : ''}` });
          u.giftN = (u.giftN | 0) + 1; qEvent(u, 'gift'); achCheck(u); sendMe(uid); sendMe(to); return send(uid, { t: 'toast', text: 'Подарок ушёл(ла)' });
        }
        const n = Math.floor(+m.cigs || 0); if (n < 10) return err(uid, 'Минимум 10 сигарет');
        if (u.giftDay !== dayKey()) { u.giftDay = dayKey(); u.giftSum = 0; }
        if (u.giftSum + n > 500) return err(uid, `Сегодня можно подогреть ещё на ${500 - u.giftSum} сигарет`);
        if (u.cigs < n) return err(uid, 'Не хватает сигарет');
        u.cigs -= n; u.giftSum += n; r.cigs += n; save(u); save(r);
        pushMal(to, { from: uid, fn: u.name, gift: { cigs: n }, text: `🎁 Подогрел тебя: ${n} сигарет.${note ? '\n' + note : ''}` });
        u.giftN = (u.giftN | 0) + 1; qEvent(u, 'gift'); achCheck(u); sendMe(uid); sendMe(to); return send(uid, { t: 'toast', text: `Подогрел на ${n}` });
      }
      // ---------- общак ----------
      case 'brig': { const b = brigOf(u); return send(uid, { t: 'brig', b: b ? brigView(b, true) : null, invites: (u.brigInv || []).filter(i => meta.brig[i.id]).map(i => ({ ...i, ...brigView(meta.brig[i.id]) })) }); }
      case 'brigTop': return send(uid, { t: 'brigTop', cup: cupView(), list: Object.values(meta.brig).map(b => brigView(b)).sort((a, b) => b.rating - a.rating || b.n - a.n || b.pot - a.pot).slice(0, 50) });
      case 'warCall': {   // создатель вызывает другую бригаду на войну (ставка из общака)
        const b = brigOf(u); if (!b || b.owner !== uid) return err(uid, 'Объявить войну может только создатель бригады');
        const t = meta.brig[m.id]; if (!t || t.id === b.id) return; const stake = WAR_STAKES.includes(+m.stake) ? +m.stake : 0; if (!stake) return;
        if (warOf(b) || b.war && meta.wars[b.war] && !meta.wars[b.war].done) return err(uid, 'Твоя бригада уже воюет или ждёт ответа');
        if (t.war && meta.wars[t.war] && !meta.wars[t.war].done) return err(uid, 'Эта бригада уже занята другой войной');
        if (b.pot < stake) return err(uid, `В общаке не хватает: нужно ${stake}`);
        meta.wars = meta.wars || {}; const id = crypto.randomBytes(5).toString('hex');
        meta.wars[id] = { id, a: b.id, b: t.id, stake, at: Date.now(), start: 0, end: 0, pa: 0, pb: 0 }; b.pot -= stake; b.war = id; t.war = id;
        brigLog(b, `Вызвали на войну «${t.name}», ставка ${stake}`); brigLog(t, `«${b.name}» вызывает на войну, ставка ${stake}`);
        [t.owner, ...(t.deps || [])].forEach(x => { if (online.has(x)) send(x, { t: 'toast', text: `⚔️ «${b.name}» вызывает вашу бригаду на войну` }); else pushMal(x, { fn: 'Бригада', text: `⚔️ «${b.name}» вызывает «${t.name}» на войну. Ставка ${stake} из общака. Ответь во вкладке «Общак» в течение суток.`, sys: true }); });
        brigUpdate(b); brigUpdate(t); return;
      }
      case 'warAns': {
        const b = brigOf(u); if (!b || b.owner !== uid) return; const w = b.war && meta.wars[b.war]; if (!w || w.done || w.start || w.b !== b.id) return;
        const a = meta.brig[w.a];
        if (!m.ok) { w.done = 'declined'; if (a) { a.pot += w.stake; delete a.war; brigLog(a, `«${b.name}» отказались от войны, ставка вернулась`); brigUpdate(a); } delete b.war; brigUpdate(b); return; }
        if (b.pot < w.stake) return err(uid, `В общаке не хватает: нужно ${w.stake}`);
        b.pot -= w.stake; w.start = Date.now(); w.end = w.start + WAR_DAYS * 864e5;
        [a, b].forEach(x => { if (x) { brigLog(x, `Война началась! 7 дней, кто больше наберёт очков общака`); brigSend(x, { t: 'toast', text: '⚔️ Война бригад началась!' }); brigUpdate(x); } }); return;
      }
      case 'brigInfo': {   // профиль чужой бригады: название, очки, состав
        const b = meta.brig[m.id]; if (!b) return err(uid, 'Бригады уже нет');
        const v = brigView(b, true); delete v.log; delete v.req; v.members.forEach(x => delete x.gave);
        const all = Object.values(meta.brig).sort((a, c) => (c.rp | 0) - (a.rp | 0)); v.place = all.indexOf(b) + 1;
        v.asked = (b.req || []).some(r => r.id === uid);
        return send(uid, { t: 'brigInfo', b: v });
      }
      case 'brigReq': {   // попроситься в бригаду из рейтинга
        if (brigOf(u)) return err(uid, 'Ты уже в бригаде');
        const b = meta.brig[m.id]; if (!b) return err(uid, 'Бригады уже нет');
        if (b.members.length >= BRIG.max) return err(uid, 'Бригада уже полная');
        b.req = (b.req || []).filter(r => r.id !== uid && users[r.id] && !users[r.id].brig).concat([{ id: uid, at: Date.now() }]).slice(-30);
        [b.owner, ...(b.deps || [])].forEach(x => { if (online.has(x)) { send(x, { t: 'toast', text: `${u.name} просится в бригаду` }); send(x, { t: 'brig', b: brigView(b, true) }); } else pushMal(x, { fn: 'Бригада', text: `${u.name} просится в бригаду «${b.name}». Ответь во вкладке «Общак».`, sys: true }); });
        saveMeta(); send(uid, { t: 'toast', text: 'Заявка ушла. Ответят создатель или заместитель' }); return handle(uid, { t: 'brigInfo', id: b.id });
      }
      case 'brigReqAns': {
        const b = brigOf(u); if (!b || !['owner', 'dep'].includes(brigRole(b, uid))) return;
        const x = users[m.id]; b.req = (b.req || []).filter(r => r.id !== m.id);
        if (m.ok && x && !brigOf(x)) {
          if (b.members.length >= BRIG.max) { brigUpdate(b); return err(uid, 'Бригада уже полная'); }
          b.members.push(x.id); x.brig = b.id; x.brigInv = []; save(x); brigLog(b, `${x.name} вступил(а) в бригаду`); brigSend(b, { t: 'toast', text: `${x.name} теперь в бригаде` });
          if (!online.has(x.id)) pushMal(x.id, { fn: 'Бригада', text: `Тебя приняли в бригаду «${b.name}». Добро пожаловать!`, sys: true }); else { send(x.id, { t: 'toast', text: `Тебя приняли в бригаду «${b.name}»` }); handle(x.id, { t: 'brig' }); sendMe(x.id); }
        }
        brigUpdate(b); return;
      }
      case 'brigCreate': {
        if (brigOf(u)) return err(uid, 'Ты уже в бригаде');
        const name = clean(String(m.name || '').replace(/\s+/g, ' ').slice(0, 20)).trim();
        if (name.length < 3 || /\*/.test(name)) return err(uid, 'Название от 3 до 20 букв, без мата');
        if (Object.values(meta.brig).some(b => b.name.toLowerCase() === name.toLowerCase())) return err(uid, 'Такая бригада уже есть');
        if (u.cigs < BRIG.cost) return err(uid, `Нужно ${BRIG.cost} сигарет`);
        u.cigs -= BRIG.cost; const id = crypto.randomBytes(4).toString('hex');
        const b = meta.brig[id] = { id, name, owner: uid, deps: [], smot: [], members: [uid], pot: 0, gave: {}, emblem: 0, created: Date.now(), log: [] };
        brigLog(b, `${u.name} собрал бригаду`); u.brig = id; u.brigInv = []; save(u); brigUpdate(b); achCheck(u); return sendMe(uid);
      }
      case 'brigInvite': {
        const b = brigOf(u); if (!b || brigRole(b, uid) === 'member') return err(uid, 'Звать могут создатель, заместитель и смотрящий');
        const to = String(m.to || ''), r = users[to]; if (!r) return;
        if (brigOf(r)) return err(uid, `${r.name} уже в бригаде`);
        if (b.members.length >= BRIG.max) return err(uid, `В бригаде максимум ${BRIG.max} человек`);
        r.brigInv = [{ id: b.id, by: u.name, at: Date.now() }].concat((r.brigInv || []).filter(i => i.id !== b.id)).slice(0, 10); save(r);
        pushMal(to, { from: uid, fn: u.name, text: `🤝 Зову тебя в бригаду «${b.name}». Принять можно во вкладке «Кореша» → «Общак».`, brigInv: b.id });
        return send(uid, { t: 'toast', text: 'Приглашение ушло' });
      }
      case 'brigJoin': {
        if (brigOf(u)) return err(uid, 'Ты уже в бригаде');
        const b = meta.brig[m.id]; if (!b || !(u.brigInv || []).some(i => i.id === m.id)) return err(uid, 'Приглашение устарело');
        if (b.members.length >= BRIG.max) return err(uid, 'Бригада уже полная');
        b.members.push(uid); u.brig = b.id; u.brigInv = []; save(u); brigLog(b, `${u.name} вступил в бригаду`); brigSend(b, { t: 'toast', text: `${u.name} теперь в бригаде` }); brigUpdate(b); return;
      }
      case 'brigDecline': u.brigInv = (u.brigInv || []).filter(i => i.id !== m.id); save(u); return handle(uid, { t: 'brig' });
      case 'brigLeave': {
        const b = brigOf(u); if (!b) return;
        b.members = b.members.filter(x => x !== uid); b.deps = (b.deps || []).filter(x => x !== uid); b.smot = (b.smot || []).filter(x => x !== uid); delete u.brig; save(u);
        if (!b.members.length) { delete meta.brig[b.id]; delete chats[b.id]; saveChat(b.id); saveMeta(); return handle(uid, { t: 'brig' }); }
        if (b.owner === uid) { b.owner = (b.deps[0] || b.members[0]); b.deps = b.deps.filter(x => x !== b.owner); brigLog(b, `${u.name} ушёл(ла), главный теперь ${users[b.owner].name}`); }
        else brigLog(b, `${u.name} ушёл(ла) из бригады`);
        brigUpdate(b); return handle(uid, { t: 'brig' });
      }
      case 'brigRole': {   // role: dep | smot | member | kick
        const b = brigOf(u); if (!b) return; const me = brigRole(b, uid), x = String(m.id || ''), xr = brigRole(b, x);
        if (!b.members.includes(x) || x === uid) return;
        if (m.role === 'kick') {
          if (!(me === 'owner' || (me === 'dep' && (xr === 'member' || xr === 'smot')))) return err(uid, 'Нет прав');
          b.members = b.members.filter(y => y !== x); b.deps = b.deps.filter(y => y !== x); b.smot = b.smot.filter(y => y !== x); if (users[x]) { delete users[x].brig; save(users[x]); send(x, { t: 'toast', text: `Тебя выгнали из бригады «${b.name}»` }); send(x, { t: 'brig', b: null, invites: [] }); }
          brigLog(b, `${u.name} выгнал ${(users[x] || {}).name}`); return brigUpdate(b);
        }
        if (me !== 'owner') return err(uid, 'Роли раздаёт только создатель');
        b.deps = b.deps.filter(y => y !== x); b.smot = b.smot.filter(y => y !== x);
        if (m.role === 'dep') b.deps.push(x); if (m.role === 'smot') b.smot.push(x);
        if (m.role === 'owner') { b.deps.push(uid); b.owner = x; }
        const RN = { dep: 'заместитель', smot: 'смотрящий', member: 'боец', owner: 'создатель' };
        brigLog(b, `${(users[x] || {}).name} теперь ${RN[m.role] || 'боец'}`); return brigUpdate(b);
      }
      case 'bchatGet': { const b = brigOf(u); if (!b) return; u.bcSeen = Date.now(); save(u); sendMe(uid); return send(uid, { t: 'bchatAll', id: b.id, list: chats[b.id] || [] }); }
      case 'bchatAsk': {   // «Попросить закурить» — сообщение в Базар, свои могут подогреть
        const b = brigOf(u); if (!b) return err(uid, 'Ты не в бригаде');
        const now = Date.now(); if (now - (u.askAt || 0) < 3600e3) return err(uid, `Просить можно раз в час. Ещё ${Math.ceil((3600e3 - (now - u.askAt)) / 60e3)} мин.`); u.askAt = now;
        const msg = { id: crypto.randomBytes(4).toString('hex'), uid, fn: u.name, text: 'просит закурить 🚬', ask: 1, got: 0, at: now, role: brigRole(b, uid) };
        chats[b.id] = (chats[b.id] || []).concat([msg]).slice(-150); saveChat(b.id); save(u);
        b.members.forEach(x => { if (online.has(x)) { send(x, { t: 'bchat', id: b.id, m: msg }); if (x !== uid) sendMe(x); } });
        return send(uid, { t: 'toast', text: 'Попросил(а) в Базаре' });
      }
      case 'bchatGive': {
        const b = brigOf(u); if (!b) return; const l = chats[b.id] || [], msg = l.find(x => x.id === m.mid && x.ask); if (!msg) return err(uid, 'Просьба уже пропала');
        if (msg.uid === uid) return err(uid, 'Себе нельзя'); const r = users[msg.uid]; if (!r || !b.members.includes(msg.uid)) return err(uid, 'Его уже нет в бригаде');
        const n = [50, 100, 200, 300].includes(+m.n) ? +m.n : 0; if (!n) return;
        if (u.giftDay !== dayKey()) { u.giftDay = dayKey(); u.giftSum = 0; }
        if (u.giftSum + n > 500) return err(uid, `Сегодня можно подогреть ещё на ${500 - u.giftSum} сигарет`);
        if (u.cigs < n) return err(uid, 'Не хватает сигарет');
        u.cigs -= n; u.giftSum += n; r.cigs += n; msg.got = (msg.got | 0) + n; (msg.from = msg.from || []).push(u.name); saveChat(b.id); save(u); save(r);
        u.giftN = (u.giftN | 0) + 1; qEvent(u, 'gift'); achCheck(u);
        b.members.forEach(x => { if (online.has(x)) send(x, { t: 'bchatUpd', m: msg }); });
        if (online.has(r.id)) send(r.id, { t: 'toast', text: `${u.name} дал(а) тебе закурить: +${n}` });
        sendMe(uid); sendMe(r.id); return send(uid, { t: 'toast', text: `Подогрел(а) на ${n}` });
      }
      case 'bchatSeen': { u.bcSeen = Date.now(); save(u); return sendMe(uid); }
      case 'bchat': {
        const b = brigOf(u); if (!b) return err(uid, 'Ты не в бригаде');
        if (u.muted && u.muted > Date.now()) return err(uid, 'Тебе пока запрещено писать');
        const text = clean(String(m.text || '').slice(0, 300)); if (!text) return;
        const now = Date.now(); if (now - (u.bcAt || 0) < 1500) return err(uid, 'Не так быстро'); u.bcAt = now;
        const msg = { id: crypto.randomBytes(4).toString('hex'), uid, fn: u.name, text, at: now, role: brigRole(b, uid) };
        const l = chats[b.id] = (chats[b.id] || []).concat([msg]).slice(-150); saveChat(b.id);
        u.bcSeen = now; save(u);
        b.members.forEach(x => { if (online.has(x)) { send(x, { t: 'bchat', id: b.id, m: msg }); if (x !== uid) sendMe(x); } });
        return;
      }
      case 'brigPot': {
        const b = brigOf(u); if (!b) return; const n = Math.floor(+m.cigs || 0);
        if (n < 10) return err(uid, 'Минимум 10 сигарет'); if (u.cigs < n) return err(uid, 'Не хватает сигарет');
        u.cigs -= n; b.pot = (b.pot | 0) + n; b.gave = b.gave || {}; b.gave[uid] = (b.gave[uid] | 0) + n; save(u);
        brigLog(b, `${u.name} закинул в общак ${n}`); brigUpdate(b); qEvent(u, 'pot'); return;
      }
      case 'brigBuy': {   // what: emblem (k) | bonus
        const b = brigOf(u); if (!b) return; if (brigRole(b, uid) !== 'owner') return err(uid, 'Тратить общак может только создатель');
        if (m.what === 'emblem') { const k = Math.floor(+m.k); if (!(k >= 1 && k <= BRIG.emblems)) return; if (b.pot < BRIG.emblem) return err(uid, `В общаке нужно ${BRIG.emblem}`); b.pot -= BRIG.emblem; b.emblem = k; brigLog(b, `${u.name} поставил новый герб`); return brigUpdate(b); }
        if (m.what === 'bonus') { if (b.pot < BRIG.bonus) return err(uid, `В общаке нужно ${BRIG.bonus}`); b.pot -= BRIG.bonus; b.bonusTill = Math.max(Date.now(), b.bonusTill || 0) + BRIG.bonusDays * 864e5; brigLog(b, `${u.name} взял +5% к выигрышу на ${BRIG.bonusDays} дней`); return brigUpdate(b); }
        return;
      }

      case 'watch': {
        const g = games.get(userGame.get(String(m.id))); if (!g || g.over) return err(uid, 'Эта партия уже закончилась');
        if (g.uids.includes(uid)) return;
        if (userGame.has(uid)) return err(uid, 'Сначала доиграй свою партию');
        unwatch(uid); (g.watchers = g.watchers || new Set()).add(uid); watching.set(uid, g.id);
        g.uids.forEach(x => send(x, { t: 'toast', text: `${u.name} смотрит вашу партию 👀` })); qEvent(u, 'watch');
        send(uid, { ...gameView(g, 0), watch: true }); return wcount(g);
      }
      case 'unwatch': return unwatch(uid);
      case 'live': {
        const list = [...games.values()].filter(g => !g.over).map(g => ({ id: g.uids[0], v: g.variant, s: g.stake, w: g.watchers ? g.watchers.size : 0, p: g.uids.map(x => publicUser(users[x])) }))
          .sort((a, b) => Math.max(b.p[0].rating, b.p[1].rating) - Math.max(a.p[0].rating, a.p[1].rating)).slice(0, 30);
        return send(uid, { t: 'live', list });
      }
      case 'profile': {
        const x = users[String(m.id || uid)]; if (!x) return;
        const all = Object.values(users).filter(y => y.app).sort((a, b) => b.rating - a.rating || b.wins - a.wins);
        return send(uid, { t: 'profile', id: x.id, user: { ...publicUser(x), online: online.has(x.id), botWins: x.id === uid ? (x.botWins || 0) : undefined },
          dice: x.dice || {}, diceN: x.diceN | 0,
          hist: (x.hist || []).slice(0, 20), place: all.findIndex(y => y.id === x.id) + 1, total: all.length, refs: (x.refs || []).length, refPaid: x.refPaidN || 0,
          inGame: userGame.has(x.id) && games.has(userGame.get(x.id)) && !games.get(userGame.get(x.id)).over });
      }
      case 'sync': { const g = games.get(userGame.get(uid)); if (g && !g.over) { g.resync = true; send(uid, gameView(g, g.uids.indexOf(uid))); g.resync = false; } return; }
      case 'peek': { // ход ещё идёт: показать сопернику шашки сразу
        const g = games.get(userGame.get(uid)); if (!g || g.over || g.phase !== 'move' || g.uids[g.turn] !== uid || !Array.isArray(m.moves)) return;
        const moves = m.moves.slice(0, 4).map(x => ({ i: x.i | 0, d: x.d | 0 }));
        g.uids.forEach(x => x !== uid && send(x, { t: 'peek', id: g.id, moves }));
        return;
      }
      case 'photo': return sharePhoto(uid, m);
      case 'gbuy': {   // потратить рыжьё
        const p = STARS[m.id]; if (!p) return;
        if (p.pass && ps(u).prem) return err(uid, 'Блатная ходка на этот сезон уже куплена');
        if ((u.gold | 0) < p.gold) return send(uid, { t: 'noGold', need: p.gold - (u.gold | 0) });
        u.gold -= p.gold; giveProd(u, p); u.goldSpent = (u.goldSpent | 0) + p.gold; dayStat('goldSpent', p.gold);
        addLog('рыжьё', `${u.name}: «${p.title}» за ${p.gold} рыжья`);
        save(u); saveMeta(); sendMe(uid); send(uid, { t: 'paid', id: m.id, title: p.title, gold: 1 });
        if (p.spins || p.pass) send(uid, tasksView(u));
        return;
      }
      case 'chifOn': { u.chifOn = !!m.on && (u.chif | 0) > 0; save(u); return sendMe(uid); }
      case 'rematch': return rematch(uid);
      case 'stars': { // купить рыжьё за звёзды: сервер выписывает счёт, Телеграм сам принимает оплату
        const p = GOLD[m.id]; if (!p) return;
        if (!BOT_TOKEN && DEV) { grantStars(uid, m.id, 'dev' + Date.now(), p.stars); return; }
        tg('createInvoiceLink', { title: p.title.slice(0, 32), description: starsDesc(p).slice(0, 255), payload: `${m.id}|${uid}|${Date.now()}`, currency: 'XTR', prices: [{ label: p.title.slice(0, 32), amount: p.stars }] })
          .then(r => r && r.ok ? send(uid, { t: 'invoice', id: m.id, link: r.result }) : err(uid, 'Оплата сейчас недоступна, попробуй позже'))
          .catch(() => err(uid, 'Оплата сейчас недоступна, попробуй позже'));
        return;
      }
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
        const code = newCode(), room = { code, host: uid, variant: m.variant === 'short' ? 'short' : 'long', stake, cap: !!m.cap, created: Date.now() };
        rooms.set(code, room);
        send(uid, { t: 'room', code, variant: room.variant, stake, cap: room.cap });
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
        let g = games.get(userGame.get(uid)), wt = false;
        if (!g) { g = games.get(watching.get(uid)); wt = !!g; }   // зритель тоже может кинуть фразу или стикер
        if (!g || g.over) return;
        const now = Date.now(); if (now - (g.chatAt[uid] || 0) < (wt ? 4000 : 2500)) return; g.chatAt[uid] = now;
        const text = m.text ? clean(String(m.text).slice(0, 60)) : '';
        const img = /^stikery\/[\w-]+\.webp$/.test(String(m.img || '')) ? m.img : '';
        if (!text && !img) return;
        if (wt) { const msg = { t: 'chat', text, img, w: 1, name: u.name }; g.uids.forEach(x => send(x, msg)); g.watchers.forEach(x => x !== uid && send(x, msg)); return; }
        g.uids.forEach(x => x !== uid && send(x, { t: 'chat', text, img }));
        if (g.watchers) { const pi = g.uids.indexOf(uid); g.watchers.forEach(x => send(x, { t: 'chat', text, img, pi })); }
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
    startGame([r.host, uid], r.variant, r.stake, r.cap);
  }
  const REF_GAMES = 3, REF_BONUS = 300;
  // кто кого привёл: новичок + тот, кто позвал. После 3 онлайн-партий новичка — обоим по 300
  function setRef(u, rid) {
    rid = rid && String(rid); if (!rid || u.ref || rid === u.id || !users[rid]) return;
    u.ref = rid; const r = users[rid]; r.refs = (r.refs || []).filter(x => x !== u.id).concat([u.id]); save(u); save(r);
  }
  function refCheck(u) {
    u.onl = (u.onl || 0) + 1;
    if (u.ref && !u.refPaid && u.onl >= REF_GAMES) {
      const r = users[u.ref]; u.refPaid = Date.now(); u.cigs += REF_BONUS; if (r) { r.cigs += REF_BONUS; r.refPaidN = (r.refPaidN || 0) + 1; save(r); send(r.id, { t: 'toast', text: `${u.name} сыграл 3 партии — тебе +${REF_BONUS} сигарет за кореша!` }); sendMe(r.id); }
      send(u.id, { t: 'toast', text: `Бонус новичка: +${REF_BONUS} сигарет!` });
    }
  }
  function addFriends(a, b) {
    const ua = users[a], ub = users[b]; if (!ua || !ub) return;
    ua.friends = [b, ...ua.friends.filter(x => x !== b)].slice(0, 50);
    ub.friends = [a, ...ub.friends.filter(x => x !== a)].slice(0, 50);
  }

  // ---------- реванш одной кнопкой ----------
  const lastG = new Map();
  function rematch(uid) {
    const r = lastG.get(uid); if (!r || Date.now() - r.at > 5 * 60e3) return err(uid, 'Реванш уже не взять: соперник ушёл(ла) из-за стола');
    const o = lastG.get(r.opp), ou = users[r.opp], u = users[uid];
    if (!ou || !online.has(r.opp) || userGame.has(r.opp)) return err(uid, 'Соперник уже не за столом');
    if (r.stake && (u.cigs < r.stake || ou.cigs < r.stake)) return err(uid, 'На реванш не хватает сигарет на ставку');
    r.want = true;
    if (o && o.opp === uid && o.want) { lastG.delete(uid); lastG.delete(r.opp); return startGame([r.opp, uid], r.variant, r.stake, r.cap); }
    send(r.opp, { t: 'rematchAsk', name: u.name, stake: r.stake, variant: r.variant }); send(uid, { t: 'rematchWait' });
  }
  // ---------- смотрящий недели: кто в понедельник первый в рейтинге ----------
  const weekNo = () => Math.floor((dnum(Date.now()) + 3) / 7);   // неделя с понедельника (по Москве)
  function smotrRoll() {
    const wk = weekNo(); if (meta.smotr && meta.smotr.wk === wk) return;
    const top = Object.values(users).filter(x => x.app && !x.banned && x.rating > 0).sort((a, b) => b.rating - a.rating || b.wins - a.wins)[0];
    if (!top) return;
    meta.smotr = { wk, id: top.id, name: top.name }; saveMeta();
    { top.cigs += 2000; top.smotrN = (top.smotrN | 0) + 1; save(top); pushMal(top.id, { fn: 'Администрация', text: '👑 Братва решила: эту неделю ты — Смотрящий. Корона в профиле и рейтинге, +2000 сигарет на общак хаты. Держи масть!', sys: true }); }
  }
  const isSmotr = id => { smotrRoll(); return !!(meta.smotr && meta.smotr.id === id); };

  // ---------- партия ----------
  function startGame(uids, variant, stake, cap) {
    uids.forEach(leaveQueue);
    for (const [c, r] of rooms) if (uids.includes(r.host)) rooms.delete(c);
    const g = {
      id: crypto.randomBytes(6).toString('hex'), uids, variant, stake, s: E.newState(variant), turn: 0, dice: [], shown: [],
      cap: !!cap, phase: 'roll', last: null, seq: 0, away: [0, 0], timeouts: [0, 0], deadline: 0, over: null, opening: null, chatAt: {}, at: Date.now(), moves: 0,
    };
    dayStat('games'); if (stake) dayStat('stakes', stake);
    meta.gamesTotal = (meta.gamesTotal || 0) + 1; if (meta.day !== today()) { meta.day = today(); meta.gamesDay = 0; } meta.gamesDay = (meta.gamesDay || 0) + 1; saveMeta();
    let a, b; do { a = r6(); b = r6(); } while (a === b);
    g.opening = [a, b]; g.turn = a > b ? 0 : 1;
    if (stake) uids.forEach(x => { users[x].cigs -= stake; users[x].hold = { g: g.id, s: stake }; });
    g.chif = uids.map(x => { const v = users[x]; if (v.chifOn && (v.chif | 0) > 0) { v.chif--; if (!v.chif) v.chifOn = false; return 1; } return 0; });
    addFriends(uids[0], uids[1]);
    uids.forEach(x => save(users[x]));
    games.set(g.id, g);
    uids.forEach(x => { unwatch(x); userGame.set(x, g.id); });
    beginPhase(g, 3500);
  }
  function beginPhase(g, delay) {
    g.phase = 'roll'; g.dice = []; g.shown = []; g.last = null;
    g.deadline = Date.now() + TURN_SECONDS * 1000 + (delay || 0);
    sendGame(g);
  }
  // статистика выпадения зар: ключ «меньшее-большее»
  function diceAdd(u, a, b, n) { if (!u) return; const k = Math.min(a, b) + '-' + Math.max(a, b); u.dice = u.dice || {}; u.dice[k] = (u.dice[k] | 0) + (n || 1); u.diceN = (u.diceN | 0) + (n || 1); save(u); }
  function doRoll(g) {
    const a = r6(), b = r6();
    g.shown = [a, b]; diceAdd(users[g.uids[g.turn]], a, b);
    g.dblRow = g.dblRow || [0, 0]; g.dblRow[g.turn] = a === b ? g.dblRow[g.turn] + 1 : 0;
    if (g.dblRow[g.turn] >= 3) { const du = users[g.uids[g.turn]]; if (du && !du.dbl3) { du.dbl3 = 1; save(du); setTimeout(() => achCheck(du), 2500); } }
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
    g.moves = (g.moves | 0) + 1;
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
      watchers: g.watchers ? g.watchers.size : 0,
    };
  }
  const watching = new Map();   // uid зрителя -> id партии
  function sendGame(g) {
    g.uids.forEach((x, i) => send(x, gameView(g, i)));
    if (g.watchers && g.watchers.size) { const v = { ...gameView(g, 0), watch: true }; for (const w of g.watchers) { if (watching.get(w) === g.id) send(w, v); else g.watchers.delete(w); } }
  }
  function unwatch(uid) { const gid = watching.get(uid); if (!gid) return; watching.delete(uid); const g = games.get(gid); if (g && g.watchers) { g.watchers.delete(uid); wcount(g); } }
  function wcount(g) { const n = g.watchers ? g.watchers.size : 0; g.uids.forEach(x => send(x, { t: 'wcount', n })); if (g.watchers) g.watchers.forEach(x => send(x, { t: 'wcount', n })); }
  function endGame(g, w, mult, reason) {
    if (g.over) return;
    const l = 1 - w, res = { winner: w, mult, reason, at: Date.now() };
    const uw = users[g.uids[w]], ul = users[g.uids[l]];
    const bon = Math.round((g.stake + C.ECON.onlineWin * mult) * brigBonus(uw));
    const chb = g.chif && g.chif[w] ? Math.round((g.stake + C.ECON.onlineWin * mult) * CHIF_BONUS) : 0;
    uw.cigs += g.stake * 2 + C.ECON.onlineWin * mult + bon + chb; res.bon = bon; res.chif = chb;
    if (g.cap) { ul.capTill = Date.now() + 24 * 3600e3; res.cap = 1; }
    lastG.set(uw.id, { opp: ul.id, variant: g.variant, stake: g.stake, cap: g.cap, at: Date.now() }); lastG.set(ul.id, { opp: uw.id, variant: g.variant, stake: g.stake, at: Date.now() });
    uw.rating += C.RATING.win[mult];
    ul.rating = Math.max(0, ul.rating + (reason === 'resign' ? C.RATING.resign : C.RATING.loss[mult]));
    uw.wins++; ul.losses++; if (g.stake) uw.stakeWins = (uw.stakeWins | 0) + 1;
    { const bw = brigOf(uw); if (bw) { const pt = 10 * mult; bw.rp = (bw.rp | 0) + pt; bw.rpW = (bw.rpW | 0) + 1; uw.brigPts = (uw.brigPts | 0) + pt; cupRoll(); if (!bw.mp || bw.mp.id !== sid()) bw.mp = { id: sid(), pts: 0 }; bw.mp.pts += pt; const wr = warOf(bw); if (wr) { if (wr.a === bw.id) wr.pa += pt; else wr.pb += pt; } saveMeta(); } }
    if (mult > 1) uw.mars = (uw.mars || 0) + 1;
    uw.streak = (uw.streak || 0) + 1; uw.best = Math.max(uw.best || 0, uw.streak); ul.streak = 0;
    const vk = g.variant === 'short' ? 'shortG' : 'longG'; uw[vk] = (uw[vk] || 0) + 1; ul[vk] = (ul[vk] || 0) + 1;
    delete uw.hold; delete ul.hold;
    const dW = C.RATING.win[mult], dL = reason === 'resign' ? C.RATING.resign : C.RATING.loss[mult];
    seasonRoll(); [[uw, ul, 1, dW], [ul, uw, 0, dL]].forEach(([a, b, win, d]) => { seasonAdd(a, d); psAdd(a, win ? 50 : 20); qEvent(a, 'play'); qEvent(a, g.variant === 'short' ? 'short' : 'long'); if (win) { qEvent(a, 'win'); if (mult > 1) qEvent(a, 'mars'); } setTimeout(() => achCheck(a), 1500); a.hist = [{ at: Date.now(), o: b.id, on: b.name, v: g.variant, s: g.stake, w: win, m: mult, r: reason, d }].concat(a.hist || []).slice(0, 30); refCheck(a); });
    g.over = res; g.phase = 'over'; g.deadline = 0;
    try { susCheck(g, w, reason); } catch (e) { log('sus ' + (e && e.message)); }
    save(uw); save(ul);
    sendGame(g);
    g.uids.forEach(x => { userGame.delete(x); sendMe(x); });
  }

  // ---------- этап 6: подозрительные партии (слив сигарет на другой аккаунт) ----------
  function susCheck(g, w, reason) {
    if (!g.stake) return;
    const uw = users[g.uids[w]], ul = users[g.uids[1 - w]], dur = Date.now() - (g.at || Date.now()), flags = [];
    if (reason !== 'win' && (dur < 90e3 || (g.moves | 0) < 6)) flags.push(`быстро сдался(лась) (${Math.round(dur / 1000)} сек, ходов ${g.moves | 0})`);
    const d = today(); meta.pairs = meta.pairs && meta.pairs.d === d ? meta.pairs : { d, p: {} };
    const key = g.uids.slice().sort().join(':'), pr = meta.pairs.p[key] = meta.pairs.p[key] || { n: 0, w: {}, sum: 0 };
    pr.n++; pr.w[uw.id] = (pr.w[uw.id] | 0) + 1; pr.sum += g.stake;
    if (pr.n >= 4 && pr.w[uw.id] === pr.n) flags.push(`сегодня ${pr.n} партий на ставку подряд, все выиграл(а) ${uw.name} (ушло ${pr.sum})`);
    if (g.stake >= 500 && reason !== 'win') flags.push('крупная ставка без доигрыша');
    if (!flags.length) return;
    const it = { at: Date.now(), w: uw.id, wn: uw.name, l: ul.id, ln: ul.name, stake: g.stake, reason, flags };
    meta.sus = [it].concat(meta.sus || []).slice(0, 200); saveMeta();
    if (BOT_TOKEN && (g.stake >= 250 || pr.n >= 4)) for (const a of meta.admins || []) tg('sendMessage', { chat_id: a, text: `🚨 Подозрительная партия\n${uw.name} (id ${uw.id}) выиграл(а) у ${ul.name} (id ${ul.id}) ${g.stake} сиг.\n• ${flags.join('\n• ')}\n\n/sus — все, /player id — карточка` }).catch(() => { });
  }
  function susText() {
    const l = (meta.sus || []).slice(0, 12);
    return l.length ? '🚨 Подозрительные партии:\n\n' + l.map(x => `${dt(x.at)} ${x.wn} ← ${x.ln}: ставка ${x.stake}\n  ${x.flags.join('; ')}\n  ids: ${x.w} ← ${x.l}`).join('\n\n') + '\n\nЕсли это слив — /give кто -сумма, /ban кто причина' : 'Подозрительных партий нет 👌';
  }

  // ---------- этап 6: промокоды ----------
  function usePromo(uid, code) {
    const u = users[uid]; code = String(code || '').trim().toUpperCase().slice(0, 24);
    const now = Date.now(); u.promoTry = (u.promoTry || []).filter(t => now - t < 60e3);
    if (u.promoTry.length >= 5) return err(uid, 'Слишком часто. Подожди минуту');
    u.promoTry.push(now); save(u);
    const pc = (meta.promos || {})[code];
    if (!code || !pc) return err(uid, 'Нет такого промокода');
    if (pc.until && now > pc.until) return err(uid, 'Промокод уже не действует');
    if (pc.uses && pc.n >= pc.uses) return err(uid, 'Промокод уже закончился');
    if (pc.by[uid]) return err(uid, 'Ты уже вводил этот промокод');
    pc.by[uid] = now; pc.n = (pc.n | 0) + 1; saveMeta();
    u.cigs += pc.amt; delete u.promoTry; save(u); dayStat('promo');
    sendMe(uid); send(uid, { t: 'promoOk', amt: pc.amt, code });
  }
  function promosText() {
    const l = Object.entries(meta.promos || {});
    return l.length ? '🎟 Промокоды:\n\n' + l.map(([c, p]) => `${c} — ${p.amt} сиг., введён ${p.n | 0}${p.uses ? ' из ' + p.uses : ''} раз${p.until ? ', до ' + dt(p.until) : ''}${p.until && Date.now() > p.until ? ' (истёк)' : ''}`).join('\n') + '\n\nУдалить: /promodel КОД' : 'Промокодов нет.\n\nСоздать: /promo КОД СУММА [СКОЛЬКО_РАЗ] [ДНЕЙ]\nНапример: /promo ZONA 500 100 7';
  }

  // ---------- этап 6: графики ----------
  function statsText() {
    const days = []; for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() + 3 * 3600e3 - i * 864e5).toISOString().slice(0, 10));
    const D = meta.days || {};
    const block = (k, name) => {
      const v = days.map(d => (D[d] && D[d][k]) || 0), mx = Math.max(1, ...v);
      return `${name} (за 14 дней: ${v.reduce((a, b) => a + b, 0)})\n` + days.map((d, i) => `${d.slice(8, 10)}.${d.slice(5, 7)} ${'▇'.repeat(Math.round(v[i] / mx * 12)) || '·'} ${v[i]}`).join('\n');
    };
    return '📈 Графики по дням (Москва)\n\n' + [block('dau', '👥 Заходили'), block('new', '🆕 Новые игроки'), block('games', '🎲 Партии онлайн'), block('bot', '🤖 Партии с ботом'), block('stars', '⭐ Звёзды')].join('\n\n');
  }

  // ---------- этап 6: рассылка ----------
  const bcTargets = () => Object.values(users).filter(u => u.bot && !u.banned && !u.botBlocked && !String(u.id).startsWith('dev'));
  async function bcastStep() {
    const b = meta.bc; if (!b || !b.run) return false;
    const part = b.q.splice(0, 25);
    for (const id of part) {
      try {
        const r = await tg('sendMessage', { chat_id: id, text: b.text, reply_markup: { inline_keyboard: [[{ text: '🎲 Открыть нарды', web_app: { url: appUrl() } }]] } });
        if (r && r.ok) b.ok++; else { b.fail++; if (r && r.error_code === 403 && users[id]) { users[id].botBlocked = Date.now(); save(users[id]); } }
      } catch (e) { b.fail++; }
    }
    saveMeta();
    if (b.q.length) return true;
    b.run = false; meta.bcLog = [{ at: b.at, by: b.by, text: b.text.slice(0, 60), ok: b.ok, fail: b.fail }].concat(meta.bcLog || []).slice(0, 20); saveMeta();
    addLog(b.by, `рассылка: доставлено ${b.ok}, не дошло ${b.fail}`);
    tg('sendMessage', { chat_id: b.by, text: `📢 Рассылка закончена.\n✅ Доставлено: ${b.ok}\n❌ Не дошло: ${b.fail} (заблокировали бота)` }).catch(() => { });
    return false;
  }
  function bcastKick() {
    if (cfg.schedule) return cfg.schedule(100);
    const loop = async () => { if (await bcastStep()) setTimeout(loop, 1100); };
    setTimeout(loop, 50);
  }
  function bcastStart(adminId) {
    const b = meta.bcDraft; if (!b) return 'Нечего отправлять. Напиши /broadcast текст';
    if (meta.bc && meta.bc.run) return 'Рассылка уже идёт, подожди';
    const ts = bcTargets();
    meta.bc = { text: b.text, by: adminId, at: Date.now(), q: ts.map(u => u.id), ok: 0, fail: 0, run: true }; delete meta.bcDraft; saveMeta();
    // в игре — системная малява всем, кто открывал игру
    for (const u of Object.values(users)) if (u.app && !u.banned) pushMal(u.id, { fn: 'Администрация', text: b.text.slice(0, 1000), sys: true });
    bcastKick();
    return `📢 Пошла рассылка: ${ts.length} в бота + малява в игре. Пришлю отчёт.`;
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

Общее. Дубль ходится 4 раза. Когда все 15 шашек дома, их можно выводить. Кто первым вывел все — победил(а). Если соперник не вывел ни одной — это марс, награда вдвое.

На ход даётся 90 секунд, иначе за тебя сходит автомат. Три пропуска подряд — поражение.`;
  function menuKeyboard() {
    const share = `https://t.me/share/url?url=${encodeURIComponent('https://t.me/' + botUsername)}&text=${encodeURIComponent('Здорово, братан! Заходи в хату, раскинем нарды на сигареты. Не ссы, зарики честные 🎲')}`;
    return { inline_keyboard: [
      [{ text: '🎲 Играть', web_app: { url: appUrl() } }],
      [{ text: '📜 Правила', callback_data: 'rules' }, { text: '🏆 Рейтинг', callback_data: 'top' }],
      [{ text: '🤝 Позвать кореша', url: share }],
      [{ text: '📩 Поддержка', callback_data: 'sup' }],
    ] };
  }
  function topText() {
    const all = Object.values(users).filter(x => x.app).sort((a, b) => b.rating - a.rating || b.wins - a.wins).slice(0, 10);
    if (!all.length) return '🏆 Доска почёта пока пустая. Сыграй первым!';
    return '🏆 Доска почёта\n\n' + all.map((u, i) => `${i + 1}. ${u.name} — ${u.rating} (${C.rankOf(u.rating)}), побед: ${u.wins}`).join('\n');
  }
  function inviteFriend(u, fid, room) {
    if (online.has(fid) && !userGame.has(fid)) { send(fid, { t: 'invite', code: room.code, from: u.name, variant: room.variant, stake: room.stake }); }   // кореш уже в игре: зовём прямо внутри (и на всякий случай ещё сообщением в боте)
    if (!BOT_TOKEN || !WEBAPP_URL || fid.startsWith('dev')) return;
    tg('sendMessage', {
      chat_id: fid,
      text: `🎲 Малява от ${u.name}:\n\nЗдорово, братан! Заходи в хату, раскинем ${room.variant === 'short' ? 'короткие' : 'длинные'} нарды${room.stake ? ` на ${room.stake} сигарет` : ' без ставки'}. Я уже всё выбрал(а). Не ссы, зарики честные 🎲`,
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
🤖 С ботом сегодня: ${((meta.days || {})[today()] || {}).bot || 0} (побед игроков ${((meta.days || {})[today()] || {}).botW || 0}), всего: ${all.reduce((a, u) => a + (u.botGames | 0), 0)}
⭐ Продажи за звёзды: сегодня ${(meta.sales || []).filter(x => x.at > day).reduce((a, x) => a + x.stars, 0)} ⭐, всего ${(meta.sales || []).reduce((a, x) => a + x.stars, 0)} ⭐ (${(meta.sales || []).length} покупок)

🏆 Топ:
${top}

🆕 Новенькие: ${fresh}

Команды: /help`;
  }
  const adminKb = { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'adm' }, { text: '📬 Обращения', callback_data: 'tickets' }], [{ text: '📈 Графики', callback_data: 'stats' }, { text: '🚨 Подозрительные', callback_data: 'sus' }], [{ text: '🎟 Промокоды', callback_data: 'promos' }, { text: '📢 Рассылка', callback_data: 'bchelp' }], [{ text: '🎲 Играть', web_app: { url: WEBAPP_URL + '/' } }]] };
  const BC_HELP = '📢 Рассылка всем игрокам\n\nНапиши: /broadcast и текст (можно в несколько строк). Я покажу, как это будет выглядеть, и спрошу подтверждение.\n\nСообщение придёт в бота всем, кто его запускал, и малявой в игре.';
  const ADMIN_PASS = String(cfg.ADMIN_PASS || '').trim();
  const isAdmin = id => Array.isArray(meta.admins) && meta.admins.includes(String(id));
  function touchBotUser(from) {
    if (!from || !from.id) return null;
    const u = getUser(String(from.id), [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, 40), from.username);
    if (!u.bot) { u.bot = Date.now(); save(u); }
    return u;
  }
  function ticketsText() {
    const t = (meta.tlist || []).slice(-10).reverse();
    if (!t.length) return '📬 Обращений пока нет.';
    return '📬 Последние обращения:\n\n' + t.map(x => `• ${new Date(x.at + 3 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')} ${x.name}: ${x.text || '(скриншот)'}`).join('\n') + '\n\nЧтобы ответить игроку — ответь (свайп влево) на его пересланное сообщение выше в этом чате.';
  }
  // обращение в поддержку: копия уходит всем админам, ответ админа (reply) — обратно игроку
  async function toSupport(u, msg) {
    meta.tlist = (meta.tlist || []).concat([{ id: u.id, name: u.name, text: String(msg.text || msg.caption || '').slice(0, 120), at: Date.now() }]).slice(-50);
    meta.tickets = meta.tickets || {};
    for (const a of meta.admins || []) {
      try {
        await tg('sendMessage', { chat_id: a, text: `📩 Обращение от ${u.name}${u.username ? ' @' + u.username : ''} (id ${u.id}). Ответь на сообщение ниже — ответ уйдёт игроку.` });
        const r = await tg('copyMessage', { chat_id: a, from_chat_id: msg.chat.id, message_id: msg.message_id });
        if (r.ok) meta.tickets[a + ':' + r.result.message_id] = u.id;
      } catch (e) { }
    }
    const keys = Object.keys(meta.tickets); if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(k => delete meta.tickets[k]);
    saveMeta();
  }
  async function answerTicket(admin, msg, uid) {
    try { await tg('sendMessage', { chat_id: uid, text: '📩 Ответ поддержки:' }); await tg('copyMessage', { chat_id: uid, from_chat_id: msg.chat.id, message_id: msg.message_id }); } catch (e) { }
  }
  const SUPPORT_PROMPT = '📩 Поддержка\n\nОпиши проблему одним сообщением: что случилось и когда. Можно приложить скриншот (с подписью). Ответим тут же, в боте.\n\nПередумал — напиши /cancel';

  // ---------- команды админа ----------
  const ADMIN_HELP = `🛠 Команды админа
/player кто — карточка игрока
/give кто 500 — выдать сигареты (минус — забрать: /give кто -100)
/gold кто 100 — выдать рыжьё (минус — забрать)
/rating кто 1200 — поставить рейтинг
/ban кто причина — закрыть доступ, /unban кто — открыть
/mute кто — запрет маляв на сутки, /reports — жалобы на малявы
/log — журнал выдач и банов

/broadcast текст — рассылка всем игрокам
/promo КОД СУММА [РАЗ] [ДНЕЙ] — промокод, /promos — список, /promodel КОД — удалить
/sus — подозрительные партии
/stats — графики по дням

«кто» — @ник, id или имя игрока; «я» — ты сам.`;
  function findUser(q, me) {
    q = String(q || '').trim(); if (!q) return null;
    if (q === 'я' || q === 'me') return me;
    if (users[q]) return users[q];
    const lq = q.replace(/^@/, '').toLowerCase();
    return Object.values(users).find(u => (u.username || '').toLowerCase() === lq) || Object.values(users).find(u => (u.name || '').toLowerCase() === q.toLowerCase()) || null;
  }
  const dt = t => t ? new Date(t + 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '—';
  function card(u) {
    return `👤 ${u.name}${u.username ? ' @' + u.username : ''}\nid: ${u.id}${u.banned ? '\n⛔ ЗАБАНЕН' + (u.banReason ? ': ' + u.banReason : '') : ''}
🚬 Сигареты: ${u.cigs}
⭐ Рейтинг: ${u.rating} (${C.rankOf(u.rating)})
🎲 Онлайн: побед ${u.wins || 0}, поражений ${u.losses || 0}
🤖 С ботом: сыграно ${u.botGames || 0}, побед ${u.botWins || 0}
🛍 Вещей куплено: ${(u.owned || []).filter(id => ITEMS[id] && ITEMS[id].price).length}
⭐ Потратил звёзд: ${u.stars || 0}
👥 Корешей: ${(u.friends || []).length}
🤝 Привёл: ${(u.refs || []).length} (засчитано ${u.refPaidN || 0})${u.ref ? `\n➡️ Пришёл от: ${users[u.ref] ? users[u.ref].name : u.ref} (id ${u.ref})${u.refPaid ? ', бонус выдан' : ', ещё не 3 партии'}` : ''}
📅 С нами с ${dt(u.created)}, был ${dt(u.seen)}${online.has(u.id) ? ' (сейчас в игре)' : ''}`;
  }
  function adminCmd(me, cmd, text, M) {
    const parts = text.split(/\s+/).slice(1);
    if (cmd === '/help') return M(ADMIN_HELP);
    if (cmd === '/stats') return M(statsText());
    if (cmd === '/sus') return M(susText());
    if (cmd === '/errs') { const l = (meta.jserr || []).slice(-10).reverse(); return M(l.length ? '🐞 Ошибки в приложении (последние):\n\n' + l.map(e => new Date(e.at + 5 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') + ' · ' + e.who + ' · ' + e.scr + '\n' + e.msg + '\n' + e.ua).join('\n\n') : 'Ошибок нет 👍'); }
    if (cmd === '/promos') return M(promosText());
    if (cmd === '/promodel') { const c = String(parts[0] || '').toUpperCase(); if (!meta.promos || !meta.promos[c]) return M('Нет такого промокода'); delete meta.promos[c]; saveMeta(); addLog(me.id, `удалил промокод ${c}`); return M(`🗑 Промокод ${c} удалён`); }
    if (cmd === '/promo') {
      const c = String(parts[0] || '').toUpperCase(), amt = parseInt(parts[1], 10), uses = parseInt(parts[2] || '0', 10) || 0, days = parseInt(parts[3] || '0', 10) || 0;
      if (!/^[A-ZА-ЯЁ0-9_]{3,24}$/.test(c) || !(amt > 0 && amt <= 100000)) return M('Пример: /promo ZONA 500 100 7\n(код ZONA, 500 сигарет, 100 раз, 7 дней). Последние два числа можно не писать — тогда без ограничений.');
      meta.promos = meta.promos || {}; if (meta.promos[c]) return M('Такой код уже есть. Удали: /promodel ' + c);
      meta.promos[c] = { amt, uses, until: days ? Date.now() + days * 864e5 : 0, n: 0, by: {}, at: Date.now(), who: me.id }; saveMeta();
      addLog(me.id, `промокод ${c}: ${amt} сиг.${uses ? ', ' + uses + ' раз' : ''}${days ? ', ' + days + ' дн.' : ''}`);
      return M(`🎟 Промокод ${c} создан: ${amt} сигарет${uses ? `, можно ввести ${uses} раз(а)` : ''}${days ? `, действует ${days} дн.` : ''}\nИгрок вводит его в игре: Задания → внизу «Промокод».`);
    }
    if (cmd === '/broadcast') {
      const body = text.replace(/^\/broadcast(@\w+)?\s*/i, '').trim().slice(0, 3500);
      if (!body) return M(BC_HELP);
      if (meta.bc && meta.bc.run) return M('Рассылка уже идёт, подожди отчёт.');
      meta.bcDraft = { text: body, by: me.id, at: Date.now() }; saveMeta();
      return M(`Так будет выглядеть:\n\n${body}\n\n———\nОтправить ${bcTargets().length} игрокам в бота и малявой всем в игре?`, { inline_keyboard: [[{ text: `✅ Отправить всем (${bcTargets().length})`, callback_data: 'bc_go' }], [{ text: '✖️ Отмена', callback_data: 'bc_no' }]] });
    }
    if (cmd === '/reports') { const l = (meta.reports || []).slice(0, 10); return M(l.length ? '🚨 Последние жалобы:\n\n' + l.map(x => `${dt(x.at)} ${x.bn} → на ${x.an} (id ${x.about}): «${x.text.slice(0, 80)}»`).join('\n\n') + '\n\n/mute id — запрет маляв на сутки' : 'Жалоб нет 👌'); }
    if (cmd === '/log') { const l = (meta.alog || []).slice(-20).reverse(); return M(l.length ? '📒 Журнал:\n\n' + l.map(x => `${dt(x.at)} ${users[x.by] ? users[x.by].name : x.by}: ${x.text}`).join('\n') : '📒 Журнал пуст'); }
    // кто может быть из нескольких слов: число в конце — сумма
    let num = null, who = parts.join(' ');
    if (cmd === '/give' || cmd === '/gold' || cmd === '/rating') { const last = parts[parts.length - 1]; if (!/^[-+]?\d+$/.test(last || '')) return M(cmd === '/give' ? 'Пример: /give @ник 500' : cmd === '/gold' ? 'Пример: /gold @ник 100' : 'Пример: /rating @ник 1200'); num = parseInt(last, 10); who = parts.slice(0, -1).join(' '); }
    let reason = '';
    if (cmd === '/ban') { who = parts[0] || ''; reason = parts.slice(1).join(' ').slice(0, 100); }
    const u = findUser(who, me);
    if (!u) return M('Не нашёл игрока «' + who + '». Можно @ник, id или имя.');
    if (cmd === '/player') return M(card(u));
    if (cmd === '/mute') { u.muted = Date.now() + 864e5; save(u); addLog(me.id, `запрет маляв на сутки: ${u.name}`); return M(`🤐 ${u.name} не сможет писать малявы сутки`); }
    if (cmd === '/give') { u.cigs = Math.max(0, u.cigs + num); save(u); addLog(me.id, `${num >= 0 ? 'выдал' : 'забрал'} ${Math.abs(num)} сиг. → ${u.name} (стало ${u.cigs})`); sendMe(u.id); send(u.id, { t: 'toast', text: num >= 0 ? `🎁 Тебе подогнали ${num} сигарет` : `Списано ${-num} сигарет` }); return M(`✅ ${u.name}: теперь ${u.cigs} сигарет`); }
    if (cmd === '/gold') { u.gold = Math.max(0, (u.gold | 0) + num); save(u); addLog(me.id, `${num >= 0 ? 'выдал' : 'забрал'} ${Math.abs(num)} рыжья → ${u.name} (стало ${u.gold})`); sendMe(u.id); send(u.id, { t: 'toast', text: num >= 0 ? `🪙 Тебе подогнали ${num} рыжья` : `Списано ${-num} рыжья` }); return M(`✅ ${u.name}: теперь ${u.gold} рыжья`); }
    if (cmd === '/rating') { const old = u.rating; u.rating = Math.max(0, num); save(u); addLog(me.id, `рейтинг ${u.name}: ${old} → ${u.rating}`); sendMe(u.id); return M(`✅ ${u.name}: рейтинг ${u.rating} (${C.rankOf(u.rating)})`); }
    if (cmd === '/ban') { if (u.id === me.id) return M('Себя банить не надо 🙂'); u.banned = Date.now(); u.banReason = reason; save(u); addLog(me.id, `бан ${u.name}${reason ? ': ' + reason : ''}`); const sk = online.get(u.id); if (sk) { try { sk.send(JSON.stringify({ t: 'err', text: 'Доступ закрыт администратором', fatal: true })); sk.close(); } catch (e) { } } return M(`⛔ ${u.name} забанен`); }
    if (cmd === '/unban') { u.banned = 0; u.banReason = ''; save(u); addLog(me.id, `разбан ${u.name}`); return M(`✅ ${u.name} разбанен`); }
  }

  // ответ боту отдаётся прямо в ответ на webhook
  function onUpdate(up) {
    if (up.pre_checkout_query) { // Телеграм спрашивает перед списанием звёзд: всё ли в порядке
      const q = up.pre_checkout_query, [id, uid] = String(q.invoice_payload || '').split('|'), p = GOLD[id] || STARS[id], u = users[uid];
      const ok = !!(p && u && !u.banned && q.currency === 'XTR' && q.total_amount === p.stars && String(q.from.id) === uid);
      return ok ? { method: 'answerPreCheckoutQuery', pre_checkout_query_id: q.id, ok: true } : { method: 'answerPreCheckoutQuery', pre_checkout_query_id: q.id, ok: false, error_message: 'Покупка недоступна. Открой игру заново и попробуй ещё раз.' };
    }
    if (up.message && up.message.successful_payment) {
      const sp = up.message.successful_payment, [id, uid] = String(sp.invoice_payload || '').split('|'), p = GOLD[id] || STARS[id];
      const got = grantStars(uid, id, sp.telegram_payment_charge_id, sp.total_amount);
      return { method: 'sendMessage', chat_id: up.message.chat.id, text: p ? (got ? `✅ Оплата прошла: «${p.title}». Всё уже у тебя в игре. Спасибо, что поддерживаешь!` : '✅ Эта покупка уже выдана.') : 'Оплата получена.' };
    }
    if (up.callback_query) {
      const q = up.callback_query;
      tg('answerCallbackQuery', { callback_query_id: q.id }).catch(() => { });
      const chat_id = q.message && q.message.chat.id; if (!chat_id) return null;
      if (q.data === 'rules') return { method: 'sendMessage', chat_id, text: RULES };
      if (q.data === 'adm' && isAdmin(q.from.id)) return { method: 'editMessageText', chat_id, message_id: q.message.message_id, text: adminText(), reply_markup: adminKb };
      if (q.data === 'tickets' && isAdmin(q.from.id)) return { method: 'sendMessage', chat_id, text: ticketsText() };
      if (q.data === 'stats' && isAdmin(q.from.id)) return { method: 'sendMessage', chat_id, text: statsText() };
      if (q.data === 'sus' && isAdmin(q.from.id)) return { method: 'sendMessage', chat_id, text: susText() };
      if (q.data === 'promos' && isAdmin(q.from.id)) return { method: 'sendMessage', chat_id, text: promosText() };
      if (q.data === 'bchelp' && isAdmin(q.from.id)) return { method: 'sendMessage', chat_id, text: BC_HELP };
      if (q.data === 'bc_go' && isAdmin(q.from.id)) return { method: 'editMessageText', chat_id, message_id: q.message.message_id, text: bcastStart(String(q.from.id)) };
      if (q.data === 'bc_no' && isAdmin(q.from.id)) { delete meta.bcDraft; saveMeta(); return { method: 'editMessageText', chat_id, message_id: q.message.message_id, text: 'Рассылка отменена.' }; }
      if (q.data === 'top') return { method: 'sendMessage', chat_id, text: topText() };
      if (q.data === 'sup') { const u = touchBotUser(q.from); if (u) { u.supWait = Date.now(); save(u); } return { method: 'sendMessage', chat_id, text: SUPPORT_PROMPT }; }
      return null;
    }
    const msg = up.message; if (!msg) return null;
    const chat_id = msg.chat.id, M = (text, reply_markup) => ({ method: 'sendMessage', chat_id, text, ...(reply_markup ? { reply_markup } : {}) });
    if (msg.chat.type !== 'private') return null;
    const me = touchBotUser(msg.from);
    const text = String(msg.text || '').trim(), isCmd = text.startsWith('/');
    // админ отвечает игроку
    if (me && isAdmin(me.id) && msg.reply_to_message && meta.tickets) {
      const uid = meta.tickets[me.id + ':' + msg.reply_to_message.message_id];
      if (uid) { answerTicket(me, msg, uid); return M('✅ Ответ отправлен игроку'); }
    }
    // кнопки под полем ввода
    const GREET = 'Заехал(а), значит. Ну, проходи, располагайся. Нары свободные, нарды на столе. Для начала дали тебе пачку сигарет — не профукай.\n\nОдевай своего персонажа, набивай наколки, обставляй хату и играй в нарды с корешами на сигареты.\n\n⚠️ Это тестовая версия: что-то может работать криво.';
    if (text === '📋 Меню') return M(GREET, menuKeyboard());
    // кнопка снизу не может открыть игру со входом (так устроен Телеграм), поэтому даём кнопку в сообщении
    if (text === '🎲 Играть') return M('Садись за доску 👇', { inline_keyboard: [[{ text: '🎲 Открыть нарды', web_app: { url: appUrl() } }]] });
    if (text === '🏆 Рейтинг') return M(topText());
    if (text === '📩 Поддержка') { if (me) { me.supWait = Date.now(); save(me); } return M(SUPPORT_PROMPT); }
    // игрок пишет в поддержку
    if (me && me.supWait && !isCmd && Date.now() - me.supWait < 3600e3) {
      me.supWait = 0; save(me);
      if (!(meta.admins || []).length) return M('Поддержка ещё не подключена, попробуй позже.');
      toSupport(me, msg).catch(() => { });
      return M('✅ Спасибо! Обращение передано. Ответ придёт сюда, в этот чат.', menuKeyboard());
    }
    if (!text) return null;
    const [cmd0, payload] = text.split(/\s+/);
    const cmd = cmd0.split('@')[0].toLowerCase();
    if (!WEBAPP_URL) return M('Игра ещё не настроена: на сервере не задан WEBAPP_URL.');
    if (cmd === '/cancel') { if (me) { me.supWait = 0; save(me); } return M('Ок, отменено.', menuKeyboard()); }
    if (cmd === '/terms' || cmd === '/privacy') return M('📜 Документы игры\n\nПользовательское соглашение: ' + WEBAPP_URL + '/terms.html\nПолитика конфиденциальности: ' + WEBAPP_URL + '/privacy.html\n\nВопросы — /support');
    if (cmd === '/paysupport') { if (me) { me.supWait = Date.now(); save(me); } return M('💳 Вопрос по оплате звёздами\n\nНапиши одним сообщением: что купил(а), когда и что не пришло. Проверим платёж и выдадим покупку или вернём звёзды.\n\nПравила возврата — /terms'); }
    if (cmd === '/support' || (cmd === '/start' && payload === 'support')) { if (me) { me.supWait = Date.now(); save(me); } return M(SUPPORT_PROMPT); }
    if (cmd === '/admin' && me) {
      if (payload) { tg('deleteMessage', { chat_id, message_id: msg.message_id }).catch(() => { }); } // пароль не оставляем в чате
      if (!isAdmin(me.id)) {
        if (!ADMIN_PASS) return M('Админка выключена: в настройках сервера не задан пароль ADMIN_PASS.');
        if (!payload) return M('Напиши: /admin пароль');
        if (payload !== ADMIN_PASS) return M('❌ Неверный пароль');
        meta.admins = (meta.admins || []).concat([me.id]); saveMeta();
        tg('setMyCommands', { scope: { type: 'chat', chat_id }, commands: [
          { command: 'admin', description: 'Админка' }, { command: 'start', description: 'Главное меню' }, { command: 'play', description: 'Играть' },
          { command: 'help', description: 'Команды админа' }, { command: 'player', description: 'Карточка игрока' }, { command: 'give', description: 'Выдать сигареты' }, { command: 'gold', description: 'Выдать рыжьё' }, { command: 'log', description: 'Журнал' }, { command: 'support', description: 'Поддержка' }] }).catch(() => { });
        return M('👑 Пароль верный, ты админ. Дальше просто пиши /admin, без пароля.\n\n' + adminText(), adminKb);
      }
      return M(adminText(), adminKb);
    }
    if (me && isAdmin(me.id) && ['/player', '/give', '/gold', '/rating', '/ban', '/unban', '/log', '/help', '/mute', '/reports', '/stats', '/sus', '/errs', '/promo', '/promos', '/promodel', '/broadcast'].includes(cmd)) return adminCmd(me, cmd, text, M);
    if (cmd === '/unadmin' && me && isAdmin(me.id)) { meta.admins = meta.admins.filter(x => x !== me.id); saveMeta(); return M('Ты больше не админ.'); }
    if (cmd === '/start' && /^fr_/i.test(payload || '') && me) {
      const fid = payload.slice(3), f = users[fid];
      if (f && fid !== me.id) {
        const was = me.friends.includes(fid); if (!me.app) setRef(me, fid); addFriends(me.id, fid); save(me); save(f);
        if (!was) { send(fid, { t: 'toast', text: `${me.name} теперь твой кореш` }); sendMe(fid); if (!online.has(fid)) tg('sendMessage', { chat_id: fid, text: `✅ ${me.name} принял(а) твоё приглашение, теперь вы кореша. Зови за стол — зарики в кружке!` }).catch(() => { }); }
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
    if (cmd === '/start' || !me || me.kbV !== 2) { // поставить постоянные кнопки под полем ввода
      if (me) { me.kbV = 2; save(me); }
      tg('sendMessage', { chat_id, text: 'Кнопки внизу всегда под рукой 👇', reply_markup: { keyboard: [[{ text: '🎲 Играть' }], [{ text: '📋 Меню' }, { text: '🏆 Рейтинг' }, { text: '📩 Поддержка' }]], resize_keyboard: true, is_persistent: true } }).catch(() => { });
    }
    return M(GREET, menuKeyboard());
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
        { command: 'rules', description: 'Правила' }, { command: 'top', description: 'Доска почёта' }, { command: 'invite', description: 'Позвать кореша' }, { command: 'support', description: 'Написать в поддержку' }, { command: 'paysupport', description: 'Вопрос по оплате' }, { command: 'terms', description: 'Соглашение и конфиденциальность' },
      ] });
      if (!WEBAPP_URL) { log('WEBAPP_URL не задан'); return (opts && opts.poll) ? poll() : null; }
      await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Играть', web_app: { url: appUrl() } } });
      const h = await tg('setWebhook', { url: WEBAPP_URL + HOOK_PATH, secret_token: HOOK_SECRET, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] });
      log('Webhook: ' + (h.ok ? 'включён' : h.description));
      return h.ok;
    } catch (e) { log('Сервер не может сам связаться с Телеграмом (' + e.message + ')'); }
  }
  async function poll() {
    await tg('deleteWebhook', {}).catch(() => { });
    let offset = 0;
    for (; ;) {
      try {
        const r = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'] });
        for (const up of r.result || []) { offset = up.update_id + 1; const o = onUpdate(up); if (o) { const { method, ...rest } = o; await tg(method, rest).catch(() => { }); } }
      } catch (e) { await new Promise(r => setTimeout(r, 5000)); }
    }
  }

  function avatarUrl(id) { const u = users[String(id)]; return u && u.photo || null; }
  return { avatarUrl, onMessage, onClose, tick, busy, onUpdate, hookAllowed, botSetup, fetchName, getPhoto, bcastStep, HOOK_PATH, get botUsername() { return botUsername; } };
}

module.exports = { createCore };
