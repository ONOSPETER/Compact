// Compact runner: hosts the critical half of an app behind a post-quantum channel.
// Run it inside a TEE (see compact/deploy/) or locally with `compact serve`.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as core from './core.mjs';
import { MemStore, FsStore, isId, isKid } from './store.mjs';
import { leafHash, buildTree, proofFor } from './merkle.mjs';

const MAX_BODY = 2 * 1024 * 1024;
const MAX_BLOB = 1_048_576 + 64;
const SESSION_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 5000;
const REPLAY_WINDOW = 256;
const CALL_TIMEOUT_MS = 30_000;
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out`)), ms); })]).finally(() => clearTimeout(t));
};

export function loadEnvFile(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#') || m[1] in env) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

/**
 * @param {{manifest: object, manifestSig: string, keys: {kemSecret: Uint8Array, dsaSecret: Uint8Array},
 *          pq: object, criticalDir: string, port?: number, appPort?: number, allowedOrigins?: string[], log?: Function, spawnApp?: boolean}} o
 */
export function createRunner(o) {
  const log = o.log ?? ((...a) => console.log('[compact]', ...a));
  const allowed = o.allowedOrigins ?? ['*'];
  const sessions = new Map();
  const hits = new Map();
  const moduleCache = new Map();
  let mHashPromise;
  const mHash = () => (mHashPromise ??= core.manifestHash(o.manifest));
  let child = null;
  let stopping = false;

  // ---- vault: opaque encrypted blobs + one head pointer per vault (the host never holds keys) ----
  const store = o.store ?? new MemStore();
  const vhits = new Map();
  let treeCache = { writes: -1 };
  async function treeOf(entries) {
    const withLeaf = await Promise.all(entries.map(async (e) => ({ ...e, leaf: await leafHash(e.kid, e.n, e.id) })));
    withLeaf.sort((a, b) => (core.hex(a.leaf) < core.hex(b.leaf) ? -1 : 1));
    const { levels, root } = await buildTree(withLeaf.map((e) => e.leaf));
    return { entries: withLeaf, levels, root: core.hex(root) };
  }
  async function currentTree() {
    const w = store.stats().writes;
    if (treeCache.writes !== w) treeCache = { writes: w, ...(await treeOf(store.leaves())) };
    return treeCache;
  }
  const vlimited = (ip) => {
    const now = Date.now();
    const h = (vhits.get(ip) ?? []).filter((t) => now - t < 60_000);
    h.push(now); vhits.set(ip, h);
    return h.length > 600;
  };
  const readRaw = (req, limit) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
  async function onVault(req, res, url) {
    if (vlimited(req.socket.remoteAddress ?? '?')) return send(res, 429, { error: 'rate limited' });
    const [, kind, arg = ''] = url.pathname.split('/').filter(Boolean);
    if (kind === 'blob' && req.method === 'PUT' && !arg) {
      const body = await readRaw(req, MAX_BLOB);
      if (body.length < 30) return send(res, 400, { error: 'blob too small' });
      const id = crypto.createHash('sha256').update(body).digest('hex');
      const r = store.putBlob(id, body);
      return r.error ? send(res, 507, { error: r.error }) : send(res, 200, { id, size: body.length });
    }
    if (kind === 'blob' && req.method === 'GET' && isId(arg)) {
      const b = store.getBlob(arg);
      if (!b) return send(res, 404, { error: 'not found' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=31536000, immutable' });
      return res.end(b);
    }
    if (kind === 'head' && isKid(arg)) {
      if (req.method === 'GET') { const h = store.getHead(arg); return h ? send(res, 200, h) : send(res, 404, { error: 'no head' }); }
      if (req.method === 'PUT') {
        const b = await readJson(req);
        if (!Number.isSafeInteger(b.n) || b.n < 1 || !isId(String(b.id))) return send(res, 400, { error: 'bad head' });
        const r = store.setHead(arg, b.n, b.id);
        return r.ok ? send(res, 200, { ok: true }) : send(res, r.error ? 400 : 409, { error: r.error ?? 'conflict', n: r.n });
      }
    }
    if (kind === 'root' && req.method === 'GET') {
      const t = await currentTree();
      return send(res, 200, { root: t.root, count: t.entries.length, writes: store.stats().writes, ts: new Date().toISOString() });
    }
    if (kind === 'stats' && req.method === 'GET') return send(res, 200, store.stats());
    if (kind === 'snapshot' && req.method === 'POST') {
      const b = await readJson(req);
      const t = await currentTree();
      if (b.root !== t.root) return send(res, 409, { error: 'root changed', root: t.root });
      store.saveSnapshot(t.root, t.entries.map(({ kid, n, id }) => ({ kid, n, id })));
      return send(res, 200, { ok: true, root: t.root });
    }
    if (kind === 'proof' && req.method === 'GET' && isKid(arg)) {
      const wanted = url.searchParams.get('root');
      let t = await currentTree();
      if (wanted && wanted !== t.root) {
        const snap = store.getSnapshot(wanted);
        if (!snap) return send(res, 404, { error: 'unknown root' });
        t = await treeOf(snap);
      }
      const i = t.entries.findIndex((e) => e.kid === arg);
      if (i < 0) return send(res, 404, { error: 'no leaf' });
      return send(res, 200, { n: t.entries[i].n, id: t.entries[i].id, index: i, path: proofFor(t.levels, i), root: t.root, count: t.entries.length });
    }
    return send(res, 404, { error: 'not found' });
  }

  // ---- app supervisor (http mode) ----
  async function waitForPort(port, timeoutMs = 25_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
      if (ok) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`critical app did not open port ${port} in time`);
  }
  let restarts = [];
  function startApp() {
    const { entry } = o.manifest.critical;
    log(`starting critical app: node ${entry} (port ${o.appPort})`);
    child = spawn(process.execPath, [entry], { cwd: o.criticalDir, env: { ...process.env, PORT: String(o.appPort), NODE_ENV: process.env.NODE_ENV || 'production' }, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('exit', (code, sig) => {
      if (stopping) return;
      const now = Date.now();
      restarts = restarts.filter((t) => now - t < 60_000);
      restarts.push(now);
      log(`critical app exited (${sig ?? code}); restart ${restarts.length}/5`);
      if (restarts.length > 5) { log('too many restarts, giving up'); return; }
      setTimeout(startApp, Math.min(10_000, 500 * 2 ** restarts.length));
    });
  }

  // ---- dispatch ----
  async function loadModule(mod) {
    const allow = o.manifest.critical.rpc?.allow ?? {};
    if (!Object.hasOwn(allow, mod)) throw new Error('module not exposed');
    if (!moduleCache.has(mod)) moduleCache.set(mod, import(pathToFileURL(path.join(o.criticalDir, mod)).href));
    return moduleCache.get(mod);
  }
  async function dispatch(msg) {
    if (msg.t === 'rpc') {
      const allow = o.manifest.critical.rpc?.allow ?? {};
      if (typeof msg.module !== 'string' || typeof msg.fn !== 'string' || !Array.isArray(msg.args)) throw new Error('bad rpc message');
      if (!Object.hasOwn(allow, msg.module) || !allow[msg.module].includes(msg.fn)) throw new Error('function not exposed');
      const m = await loadModule(msg.module);
      const fn = msg.fn === 'default' ? m.default : (m[msg.fn] ?? m.default?.[msg.fn]);
      if (typeof fn !== 'function') throw new Error('export is not a function');
      const result = await withTimeout(Promise.resolve(fn(...msg.args)), CALL_TIMEOUT_MS, 'call');
      JSON.stringify(result); // must be serialisable
      return { ok: true, result: result === undefined ? null : result };
    }
    if (msg.t === 'http') {
      const prefixes = o.manifest.critical.http?.prefixes ?? [];
      const p = String(msg.path ?? '');
      if (!p.startsWith('/') || p.startsWith('//') || p.includes('..') || /[\r\n]/.test(p)) throw new Error('bad path');
      if (!prefixes.some((x) => p === x || p.startsWith(`${x}/`) || p.startsWith(`${x}?`))) throw new Error('path not exposed');
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(msg.method)) throw new Error('bad method');
      const headers = {};
      for (const [k, v] of Object.entries(msg.headers ?? {})) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = String(v);
      const body = msg.body && !['GET', 'HEAD'].includes(msg.method) ? Buffer.from(msg.body, 'base64') : undefined;
      const r = await fetch(`http://127.0.0.1:${o.appPort}${p}`, { method: msg.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      const rh = {};
      r.headers.forEach((v, k) => { if (!HOP_BY_HOP.has(k) && k !== 'set-cookie') rh[k] = v; });
      return { ok: true, status: r.status, headers: rh, body: Buffer.from(await r.arrayBuffer()).toString('base64') };
    }
    throw new Error('unknown message type');
  }

  // ---- HTTP plumbing ----
  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origin && (allowed.includes('*') || allowed.includes(origin))) {
      res.setHeader('access-control-allow-origin', allowed.includes('*') ? '*' : origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'content-type, x-compact-sid');
      res.setHeader('access-control-allow-methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
  };
  const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readJson = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); } });
    req.on('error', reject);
  });
  const rateLimited = (ip) => {
    const now = Date.now();
    const h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    h.push(now); hits.set(ip, h);
    return h.length > 60;
  };

  async function onHello(req, res) {
    if (rateLimited(req.socket.remoteAddress ?? '?')) return send(res, 429, { error: 'rate limited' });
    if (sessions.size >= MAX_SESSIONS) return send(res, 503, { error: 'busy' });
    const hello = await readJson(req);
    const sid = crypto.randomBytes(16).toString('hex');
    const { reply, keys } = await core.serverHello(o.pq, o.keys, hello, await mHash(), sid);
    sessions.set(sid, { keys, max: 0, seen: new Set(), last: Date.now() });
    send(res, 200, reply);
  }

  async function onMsg(req, res) {
    const sid = String(req.headers['x-compact-sid'] ?? '');
    const s = sessions.get(sid);
    if (!s || Date.now() - s.last > SESSION_TTL_MS) { sessions.delete(sid); return send(res, 401, { error: 'unknown session' }); }
    const body = await readJson(req);
    const seq = Number(body.seq);
    if (!Number.isSafeInteger(seq) || seq < 1 || seq <= s.max - REPLAY_WINDOW || s.seen.has(seq)) return send(res, 409, { error: 'replay or bad sequence' });
    let msg;
    try { msg = await core.openMessage(s.keys, 'c2s', sid, seq, body.ct); } catch { return send(res, 400, { error: 'decryption failed' }); }
    s.seen.add(seq); s.max = Math.max(s.max, seq); s.last = Date.now();
    for (const x of s.seen) if (x <= s.max - REPLAY_WINDOW) s.seen.delete(x);
    let reply;
    try { reply = await dispatch(msg); } catch (e) { reply = { ok: false, error: { message: String(e?.message ?? e).slice(0, 300) } }; }
    send(res, 200, { seq, ct: await core.sealMessage(s.keys, 's2c', sid, seq, reply) });
  }

  const server = http.createServer(async (req, res) => {
    cors(req, res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/.compact/health') return send(res, 200, { ok: true, mode: o.manifest.mode, sessions: sessions.size });
      if (req.method === 'GET' && url.pathname === '/.compact/bundle') return send(res, 200, { manifest: o.manifest, sig: o.manifestSig });
      if (req.method === 'POST' && url.pathname === '/.compact/hello') return await onHello(req, res);
      if (req.method === 'POST' && url.pathname === '/.compact/msg') return await onMsg(req, res);
      if (url.pathname.startsWith('/v1/')) return await onVault(req, res, url);
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) send(res, e.status ?? 500, { error: e.status ? e.message : 'internal error' });
      if (!e.status) log('request error:', e?.stack ?? e);
    }
  });

  const gc = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (now - s.last > SESSION_TTL_MS) sessions.delete(id);
    for (const [ip, h] of hits) if (!h.some((t) => now - t < 60_000)) hits.delete(ip);
  }, 60_000);
  gc.unref();

  return {
    server,
    sessions,
    async listen(port = o.port ?? 8787, host = '0.0.0.0') {
      if (o.manifest.mode === 'http' && o.spawnApp !== false) { startApp(); await waitForPort(o.appPort); }
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      log(`listening on :${server.address().port} (${o.manifest.mode} mode)`);
      return server.address().port;
    },
    async close() {
      stopping = true; clearInterval(gc);
      child?.kill('SIGTERM');
      await new Promise((r) => server.close(r));
    },
  };
}

// ---- entrypoint: `node compact/runtime/runner.mjs` ----
async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const compactDir = process.env.COMPACT_DIR ?? path.resolve(here, '..');
  const criticalDir = process.env.COMPACT_CRITICAL_DIR ?? path.resolve(compactDir, '..', 'critical');
  const manifest = JSON.parse(fs.readFileSync(path.join(compactDir, 'manifest.json'), 'utf8'));
  const manifestSig = fs.readFileSync(path.join(compactDir, 'manifest.sig'), 'utf8').trim();

  // Secret key material: sealed env var in a TEE, or a local file for development.
  let raw = process.env.COMPACT_KEYS_B64 ? Buffer.from(process.env.COMPACT_KEYS_B64, 'base64').toString('utf8') : null;
  if (!raw) {
    const f = path.join(compactDir, 'keys', 'runner.secret.json');
    if (!fs.existsSync(f)) throw new Error('No runner keys: set COMPACT_KEYS_B64 or provide compact/keys/runner.secret.json');
    raw = fs.readFileSync(f, 'utf8');
  }
  const k = JSON.parse(raw);
  const keys = { kemSecret: core.b64.dec(k.kem.secret), dsaSecret: core.b64.dec(k.dsa.secret) };
  if (k.kem.public !== manifest.runner.kemPublic || k.dsa.public !== manifest.runner.dsaPublic) {
    throw new Error('Runner keys do not match the manifest: refusing to start');
  }
  const { createPQ } = await import('./pq.mjs');
  loadEnvFile(path.join(criticalDir, '.env'));
  const runner = createRunner({
    manifest, manifestSig, keys, pq: createPQ(), criticalDir,
    store: new FsStore(process.env.COMPACT_DATA_DIR ?? path.join(compactDir, 'data')),
    appPort: Number(process.env.COMPACT_APP_PORT ?? 0) || manifest.critical.http?.port || 0,
    allowedOrigins: (process.env.COMPACT_ALLOWED_ORIGINS ?? '*').split(',').map((s) => s.trim()),
  });
  await runner.listen(Number(process.env.PORT ?? 8787));
  const stop = () => runner.close().then(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('[compact] fatal:', e.message); process.exit(1); });
}
