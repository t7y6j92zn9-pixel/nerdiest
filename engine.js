// Движок нард: длинные (long) и короткие (short). Общий для сервера и приложения.
(function (root) {
  // Доска: 24 пункта (0..23). b[a] > 0 — шашки игрока 0 (белые), b[a] < 0 — игрока 1 (чёрные).
  // У каждого игрока свой путь 0..23 от старта до дома (дом — пункты пути 18..23).
  // i = -1 означает «с бара» (только короткие нарды).
  function absOf(v, p, i) {
    if (v === 'long') return (i + (p === 0 ? 0 : 12)) % 24;
    return p === 0 ? i : 23 - i;
  }
  function idxOf(v, p, a) {
    if (v === 'long') return (a - (p === 0 ? 0 : 12) + 24) % 24;
    return p === 0 ? a : 23 - a;
  }
  function own(s, p, a) { const x = s.b[a]; return p === 0 ? (x > 0 ? x : 0) : (x < 0 ? -x : 0); }

  function newState(v) {
    const b = new Array(24).fill(0);
    if (v === 'long') { b[0] = 15; b[12] = -15; }
    else {
      // по пути игрока: 2 шашки в начале, 5 на 12-м пункте пути, 3 на 17-м, 5 в доме
      [[0, 2], [11, 5], [16, 3], [18, 5]].forEach(([i, n]) => { b[absOf(v, 0, i)] += n; b[absOf(v, 1, i)] -= n; });
    }
    return { v, b, off: [0, 0], bar: [0, 0], first: [true, true], headMoves: 0, headLimit: 1 };
  }
  function clone(s) {
    return { v: s.v, b: s.b.slice(), off: s.off.slice(), bar: s.bar.slice(), first: s.first.slice(), headMoves: s.headMoves, headLimit: s.headLimit };
  }
  function removeOne(arr, d) { const r = arr.slice(); r.splice(r.indexOf(d), 1); return r; }
  function allHome(s, p) {
    if (s.bar[p]) return false;
    for (let i = 0; i < 18; i++) if (own(s, p, absOf(s.v, p, i))) return false;
    return true;
  }
  function pip(s, p) {
    let t = s.bar[p] * 25;
    for (let a = 0; a < 24; a++) { const c = own(s, p, a); if (c) t += c * (24 - idxOf(s.v, p, a)); }
    return t;
  }

  // длинные нарды: нельзя строить 6 подряд, если впереди нет ни одной шашки соперника
  function blockOk(s, p) {
    const q = 1 - p; let run = 0;
    for (let i = 0; i < 24; i++) {
      if (own(s, p, absOf(s.v, p, i))) {
        run++;
        if (run >= 6) {
          let mx = -1;
          for (let k = i - 5; k <= i; k++) mx = Math.max(mx, idxOf(s.v, q, absOf(s.v, p, k)));
          let passed = false;
          for (let a = 0; a < 24; a++) if (own(s, q, a) && idxOf(s.v, q, a) > mx) { passed = true; break; }
          if (!passed) return false;
        }
      } else run = 0;
    }
    return true;
  }

  // начало хода: сбросить счётчики, выставить лимит снятия с головы
  function beginTurn(s, p, d1, d2) {
    s.headMoves = 0;
    s.headLimit = (s.v === 'long' && s.first[p] && d1 === d2 && (d1 === 3 || d1 === 4 || d1 === 6)) ? 2 : 1;
    return d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
  }

  function step(s, p, i, d) {
    const v = s.v, sg = p === 0 ? 1 : -1, q = 1 - p;
    if (v === 'short' && s.bar[p] && i !== -1) return null; // сначала ввести шашки с бара
    if (i === -1) {
      if (v !== 'short' || !s.bar[p]) return null;
    } else {
      if (i < 0 || i > 23) return null;
      if (!own(s, p, absOf(v, p, i))) return null;
      if (v === 'long' && i === 0 && s.headMoves >= s.headLimit) return null;
    }
    const t = i + d, n = clone(s);
    if (t < 24) {
      const ta = absOf(v, p, t), opp = own(s, q, ta);
      if (v === 'long' && opp) return null;
      if (v === 'short' && opp >= 2) return null;
      if (i === -1) n.bar[p]--; else n.b[absOf(v, p, i)] -= sg;
      if (v === 'short' && opp === 1) { n.b[ta] = 0; n.bar[q]++; }
      n.b[ta] += sg;
    } else {
      if (i === -1 || !allHome(s, p)) return null;
      if (t > 24) for (let k = 18; k < i; k++) if (own(s, p, absOf(v, p, k))) return null;
      n.b[absOf(v, p, i)] -= sg; n.off[p]++;
    }
    if (v === 'long' && i === 0) n.headMoves++;
    if (v === 'long' && t < 24 && !blockOk(n, p)) return null;
    return n;
  }

  function key(s, dice) {
    return s.b.join(',') + '|' + s.off + '|' + s.bar + '|' + s.headMoves + '|' + dice.join('');
  }
  function maxUse(s, p, dice, memo) {
    if (!dice.length) return 0;
    const k = key(s, dice); if (memo.has(k)) return memo.get(k);
    let best = 0;
    outer: for (const d of new Set(dice)) {
      const rest = removeOne(dice, d);
      for (let i = -1; i < 24; i++) {
        const n = step(s, p, i, d);
        if (n) { const val = 1 + maxUse(n, p, rest, memo); if (val > best) best = val; if (best === dice.length) break outer; }
      }
    }
    memo.set(k, best); return best;
  }
  // все разрешённые сейчас шаги {i, d, n}
  function legalSteps(s, p, dice, memo, full) {
    memo = memo || new Map();
    if (!dice.length) return [];
    const m = maxUse(s, p, dice, memo); if (!m) return [];
    let res = [];
    for (const d of new Set(dice)) {
      const rest = removeOne(dice, d);
      for (let i = -1; i < 24; i++) {
        const n = step(s, p, i, d);
        if (n && 1 + maxUse(n, p, rest, memo) === m) res.push({ i, d, n });
      }
    }
    // если можно сыграть только один кубик из двух разных — играть больший
    if (m === 1 && dice.length === 2 && dice[0] !== dice[1]) {
      const hi = Math.max(dice[0], dice[1]);
      if (res.some(r => r.d === hi)) res = res.filter(r => r.d === hi);
    }
    return res;
  }

  // ---- бот ----
  function evaluate(s, p) {
    const v = s.v, q = 1 - p;
    let sc = (pip(s, q) - pip(s, p)) + s.off[p] * 3;
    let oppRear = 24;
    if (s.bar[q]) oppRear = -1;
    else for (let a = 0; a < 24; a++) if (own(s, q, a)) oppRear = Math.min(oppRear, idxOf(v, q, a));
    let run = 0, bestRun = 0, points = 0;
    for (let j = 0; j < 24; j++) {
      const a = absOf(v, q, j), c = own(s, p, a);
      if (c >= (v === 'short' ? 2 : 1) && j > oppRear) { run++; bestRun = Math.max(bestRun, run); sc += 1.2; } else run = 0;
    }
    sc += bestRun * bestRun * 0.7;
    for (let a = 0; a < 24; a++) {
      const c = own(s, p, a);
      if (!c) continue;
      points++;
      const i = idxOf(v, p, a);
      if (!(v === 'long' && i === 0) && c > 3) sc -= (c - 3) * 0.9;
      if (v === 'short' && c === 1) {
        // одиночная шашка под ударом: сколько вражеских шашек может её достать
        let danger = 0;
        for (let b = 0; b < 24; b++) {
          const oc = own(s, q, b); if (!oc) continue;
          const dist = idxOf(v, q, a) - idxOf(v, q, b);
          if (dist > 0 && dist <= 12) danger += dist <= 6 ? 2 : 1;
        }
        if (s.bar[q]) danger += 2;
        sc -= Math.min(danger, 6) * (0.8 + i / 24);
      }
    }
    sc += points * 0.6 + s.bar[q] * 6;
    return sc + Math.random() * 0.4;
  }
  function botPlan(s, p, dice) {
    const memo = new Map(), seen = new Set(); let best = null, count = 0;
    (function rec(st, dc, path) {
      const steps = dc.length ? legalSteps(st, p, dc, memo) : [];
      if (!steps.length || count > 4000) { const val = evaluate(st, p); if (!best || val > best.v) best = { v: val, path }; return; }
      for (const sp of steps) {
        const rest = removeOne(dc, sp.d), k = key(sp.n, rest);
        if (seen.has(k)) continue; seen.add(k); count++;
        rec(sp.n, rest, path.concat([{ i: sp.i, d: sp.d }]));
      }
    })(s, dice, []);
    return best ? best.path : [];
  }

  // проверка целого хода, присланного игроком. Возвращает новое состояние или null
  function applyTurn(s, p, dice, moves) {
    let st = s, dc = dice.slice();
    const memo = new Map();
    for (const m of moves) {
      const ok = legalSteps(st, p, dc, memo).find(x => x.i === m.i && x.d === m.d);
      if (!ok) return null;
      st = ok.n; dc = removeOne(dc, m.d);
      if (st.off[p] === 15) return st;
    }
    if (legalSteps(st, p, dc, memo).length) return null; // ход не доигран
    return st;
  }

  // множитель победы: 1 — обычная, 2 — марс, 3 — кокс (коротк. нарды: у проигравшего шашка на баре или в доме победителя)
  function winMult(s, w) {
    const l = 1 - w;
    if (s.off[l] > 0) return 1;
    if (s.v === 'short') {
      if (s.bar[l]) return 3;
      for (let i = 18; i < 24; i++) if (own(s, l, absOf(s.v, w, i))) return 3;
    }
    return 2;
  }

  const api = { absOf, idxOf, own, newState, clone, removeOne, allHome, pip, step, beginTurn, legalSteps, botPlan, applyTurn, winMult };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Engine = api;
})(this);
