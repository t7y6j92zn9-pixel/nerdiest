// «Нарды от Кондрата» — запуск на Cloudflare Workers (бесплатно, без карты).
// Вся онлайн-игра живёт в одном Durable Object «Lobby»; картинки и страница — статические файлы из app/.
import { DurableObject } from 'cloudflare:workers';
import coreLib from './core.js';
const { createCore } = coreLib;

export class Lobby extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.users = null;
    ctx.blockConcurrencyWhile(async () => {
      const users = {};
      for (const [, v] of await ctx.storage.list({ prefix: 'u:' })) if (v && v.id) users[v.id] = v;
      this.users = users;
      this.meta = (await ctx.storage.get('meta')) || {};
    });
  }
  getCore(origin) {
    if (this.core) return this.core;
    const env = this.env;
    this.core = createCore({
      BOT_TOKEN: env.BOT_TOKEN, WEBAPP_URL: env.WEBAPP_URL || origin, BOT_USERNAME: env.BOT_USERNAME, ADMIN_PASS: env.ADMIN_PASS, DEV: env.DEV === '1',
      users: this.users, saveUser: u => this.ctx.storage.put('u:' + u.id, u),
      meta: this.meta, saveMeta: m => this.ctx.storage.put('meta', m),
      putPhoto: async (id, buf) => {
        await this.ctx.storage.put('p:' + id, { t: Date.now(), b: new Uint8Array(buf) });
        const old = []; for (const [k, v] of await this.ctx.storage.list({ prefix: 'p:' })) if (Date.now() - v.t > 3 * 864e5) old.push(k);
        if (old.length) await this.ctx.storage.delete(old.slice(0, 128));
      },
      getPhoto: async id => { const v = await this.ctx.storage.get('p:' + id); return v ? v.b : null; },
    });
    this.ctx.waitUntil(this.core.fetchName());
    return this.core;
  }
  ensureTick() {
    if (this.iv) return;
    this.iv = setInterval(() => { this.core.tick(); if (!this.core.busy()) { clearInterval(this.iv); this.iv = null; } }, 1000);
  }
  async fetch(req) {
    const url = new URL(req.url), core = this.getCore(url.origin);
    if (url.pathname === core.HOOK_PATH) {
      if (!core.hookAllowed(req.headers.get('x-telegram-bot-api-secret-token'))) return new Response('', { status: 403 });
      let out = null; try { out = core.onUpdate(await req.json()); } catch (e) { console.log('bot', e.message); }
      return Response.json(out || {});
    }
    const ph = url.pathname.match(/^\/photo\/([0-9a-f]{16})\.jpg$/);
    if (ph) { const b = await core.getPhoto(ph[1]); return b ? new Response(b, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' } }) : new Response('', { status: 404 }); }
    if (url.pathname === '/setup') {
      const logs = []; const ok = await createCore({ BOT_TOKEN: this.env.BOT_TOKEN, WEBAPP_URL: this.env.WEBAPP_URL || url.origin, log: t => logs.push(t) }).botSetup();
      return new Response((ok ? '✅ Готово! Напиши боту /start\n\n' : '❌ Не получилось\n\n') + logs.join('\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Ожидался websocket', { status: 426 });
    const pair = new WebSocketPair(); const [client, server] = Object.values(pair);
    server.accept();
    const sock = { send: s => { try { server.send(s); } catch (e) { } }, close: () => { try { server.close(); } catch (e) { } }, uid: null };
    server.addEventListener('message', e => core.onMessage(sock, typeof e.data === 'string' ? e.data : ''));
    server.addEventListener('close', () => core.onClose(sock));
    server.addEventListener('error', () => core.onClose(sock));
    this.ensureTick();
    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/ws' || url.pathname === '/tg-hook' || url.pathname === '/setup' || url.pathname.startsWith('/photo/')) return env.LOBBY.get(env.LOBBY.idFromName('main')).fetch(req);
    return env.ASSETS.fetch(req);
  },
};
