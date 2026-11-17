// Сильный серверный ход для рейтинговых ботов: перебор всех ходов + взгляд на ответ соперника (все 21 бросок).
const E = require('./engine.js');

// все различные итоговые позиции хода: [{ st, path }]
function finals(s, p, dice, cap) {
  const memo = new Map(), seen = new Set(), out = [];
  (function rec(st, dc, path) {
    const steps = dc.length ? E.legalSteps(st, p, dc, memo) : [];
    if (!steps.length || out.length >= cap) { const k = E.key(st, []); if (!seen.has('F' + k)) { seen.add('F' + k); out.push({ st, path }); } return; }
    for (const sp of steps) {
      const rest = E.removeOne(dc, sp.d), k = E.key(sp.n, rest);
      if (seen.has(k)) continue; seen.add(k);
      rec(sp.n, rest, path.concat([{ i: sp.i, d: sp.d }]));
      if (out.length >= cap) return;
    }
  })(s, dice, []);
  return out;
}
const ROLLS = []; for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) ROLLS.push([a, b, a === b ? 1 : 2]);

// насколько хороша позиция для p, если дальше ходит соперник (средний лучший ответ)
function replyScore(st, p) {
  const q = 1 - p; let sum = 0, w = 0;
  if (st.off[p] === 15) return 1e6;
  for (const [a, b, n] of ROLLS) {
    const s2 = E.clone(st); const dice = E.beginTurn(s2, q, a, b);
    const fs = finals(s2, q, dice, 250);
    let best = -Infinity;
    for (const f of fs) { const v = f.st.off[q] === 15 ? 1e6 : E.evaluate(f.st, q) - E.evaluate(f.st, p); if (v > best) best = v; }
    if (best === -Infinity) best = E.evaluate(s2, q) - E.evaluate(s2, p);
    sum -= best * n; w += n;
  }
  return sum / w;
}

// mistakes: 0 — всегда лучший ход; 0.1 — иногда второй/третий по силе
function plan(s, p, dice, mistakes) {
  const fs = finals(s, p, dice, 3000);
  if (!fs.length) return [];
  for (const f of fs) { if (f.st.off[p] === 15) return f.path; f.v = E.evaluate(f.st, p) - E.evaluate(f.st, 1 - p); }
  fs.sort((a, b) => b.v - a.v);
  const top = fs.slice(0, fs.length > 1 ? 5 : 1);
  if (top.length > 1) for (const f of top) f.r = replyScore(f.st, p);
  top.sort((a, b) => (b.r || 0) - (a.r || 0));
  let i = 0;
  if (mistakes > 0 && top.length > 1 && Math.random() < mistakes) i = 1 + Math.floor(Math.random() * Math.min(2, top.length - 1));
  return top[i].path;
}
module.exports = { plan };
