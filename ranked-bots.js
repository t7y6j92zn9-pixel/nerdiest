// Six persistent opponents (strong: mist = how often a bot picks 2nd/3rd best move). Ratings and results are earned through actual matches.
const PROFILES = [
  { id: 'rankbot_1', name: 'Саня Часовщик', mist: 0.05, outfit: 'o_15_velour', hat: 'h_0', neck: 'n_8', beads: 'b_8', level: 'l_12', board: 'd_2' },
  { id: 'rankbot_2', name: 'Миша Тихий', mist: 0.08, outfit: 'o_07_rubashka', hat: 'h_3', neck: 'n_9', beads: 'b_9', level: 'l_4', board: 'd_1' },
  { id: 'rankbot_3', name: 'Рустам', mist: 0, outfit: 'o_05_sportivka', hat: 'h_2', neck: 'n_1', beads: 'b_2', level: 'l_8', board: 'd_3' },
  { id: 'rankbot_4', name: 'Дядя Витя', mist: 0.1, outfit: 'o_11_kletchataya', hat: 'h_4', neck: 'n_2', beads: 'b_1', level: 'l_2', board: 'd_0' },
  { id: 'rankbot_5', name: 'Лёха Север', mist: 0.03, outfit: 'o_06_kozhanka', hat: 'h_7', neck: 'n_3', beads: 'b_4', level: 'l_6', board: 'd_4' },
  { id: 'rankbot_6', name: 'Гриша Рыжий', mist: 0.06, outfit: 'o_09_telnyashka', hat: 'h_0', neck: 'n_0', beads: 'b_9', level: 'l_3', board: 'd_2' },
];
function seedBots(users, save, meta) {
  for (const p of PROFILES) {
    let u = users[p.id];
    if (!u) {
      meta.seq = (meta.seq | 0) + 1;
      u = users[p.id] = { id: p.id, name: p.name, ai: true, no: meta.seq, cigs: 100000, rating: 0, wins: 0, losses: 0,
        friends: [], created: Date.now(), app: Date.now(), owned: [], eco: Date.now(), story: true };
      u.eq = { outfit: p.outfit, hat: p.hat, neck: p.neck, beads: p.beads, level: p.level, board: p.board,
        ring: 'r_0', watch: 'w_0', mug: 'm_1', ash: 'a_0', pack: 'c_0', dice: 'k_0', checkers: 's_0', tats: {} };
      u.owned = Object.values(u.eq).filter(x => typeof x === 'string');
      u.lvl = +p.level.slice(2);
    }
    u.ai = true;
    u.aiMist = p.mist; delete u.aiSkill;
    u.avatar = '/a/avatars/' + p.id + '.webp';
    save(u);
  }
}
module.exports = { PROFILES, seedBots, WAIT_MS: 3500 };
