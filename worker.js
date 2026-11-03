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
    });
  }
  getCore(origin) {
    if (this.core) return this.core;
    const env = this.env;
    this.core = createCore({
      BOT_TOKEN: env.BOT_TOKEN, WEBAPP_URL: env.WEBAPP_URL || origin, BOT_USERNAME: env.BOT_USERNAME, DEV: env.DEV === '1',
      users: this.users, saveUser: u => this.ctx.storage.put('u:' + u.id, u),
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
    if (url.pathname === '/ws' || url.pathname === '/tg-hook' || url.pathname === '/setup') return env.LOBBY.get(env.LOBBY.idFromName('main')).fetch(req);
    return env.ASSETS.fetch(req);
  },
};
