import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../templates/runtime/core.mjs';
import { createServerlessHandler } from '../templates/runtime/serverless.mjs';
import { CompactClient } from '../templates/runtime/client-core.mjs';
import { VaultClient, randomKey } from '../templates/runtime/vault.mjs';
import { MemStore } from '../templates/runtime/store.mjs';
import { UpstashStore, SET_HEAD_LUA } from '../templates/runtime/kv.mjs';
import { mockPQ } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compact-sl-'));
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

/** Stand-in for Upstash's REST API: just the commands UpstashStore uses. */
function mockUpstash(token = 'tok') {
  const kv = new Map(); const hashes = new Map();
  const hash = (k) => hashes.get(k) ?? hashes.set(k, new Map()).get(k);
  const run = ([cmd, ...a]) => {
    switch (cmd.toUpperCase()) {
      case 'SET': { const [k, v, ...o] = a; if (o.includes('NX') && kv.has(k)) return null; kv.set(k, String(v)); return 'OK'; }
      case 'GET': return kv.get(a[0]) ?? null;
      case 'EXISTS': return kv.has(a[0]) ? 1 : 0;
      case 'INCR': case 'INCRBY': { const v = Number(kv.get(a[0]) ?? 0) + Number(a[1] ?? 1); kv.set(a[0], String(v)); return v; }
      case 'HGET': return hash(a[0]).get(a[1]) ?? null;
      case 'HLEN': return hash(a[0]).size;
      case 'HGETALL': return [...hash(a[0])].flat();
      case 'EVAL': { // our one Lua script, re-implemented in JS
        const [script, nk, ...rest] = a;
        if (script !== SET_HEAD_LUA) throw new Error('unexpected script');
        const [heads, blob, writes] = rest.slice(0, Number(nk)); const [kid, n, id] = rest.slice(Number(nk));
        const cur = Number((hash(heads).get(kid) ?? '0:').split(':')[0]);
        if (cur + 1 !== Number(n)) return [0, cur];
        if (!kv.has(blob)) return [2, cur];
        hash(heads).set(kid, `${n}:${id}`); kv.set(writes, String(Number(kv.get(writes) ?? 0) + 1));
        return [1, cur];
      }
      default: throw new Error(`unsupported ${cmd}`);
    }
  };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; return res.end(JSON.stringify({ error: 'unauthorized' })); }
    try { res.end(JSON.stringify(req.url === '/pipeline' ? body.map((c) => ({ result: run(c) })) : { result: run(body) })); } catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
  });
  return { server, kv, hashes };
}

const CRITICAL = { 'lib/auth.js': 'export async function login(u,p){ return {user:u, ok:p==="pw"} }\nexport function secret(){ return 1 }' };
function fixture(extra = {}) {
  const dir = tmp();
  for (const [f, c] of Object.entries({ ...CRITICAL, ...extra })) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  return dir;
}
const st = async (url, init) => { const r = await fetch(url, init); await r.arrayBuffer(); return r.status; };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** N function instances sharing keys+store, behind one HTTP server; optionally emulating Vercel's pre-parsed req.body. */
async function boot({ store = new MemStore(), instances = 3, vercelBody = false, mode = 'rpc', manifestExtra = {}, criticalDir = fixture(), files } = {}) {
  const kem = mockPQ.kem.keygen(); const dsa = mockPQ.dsa.keygen();
  const manifest = {
    v: 1, mode, app: { id: 'demo' },
    critical: { treeHash: 'x', files: files ?? Object.keys(CRITICAL).map((p) => ({ path: p, sha256: sha(CRITICAL[p]) })), rpc: { allow: { 'lib/auth.js': ['login'] } }, ...manifestExtra },
    runner: { kemPublic: core.b64.enc(kem.publicKey), dsaPublic: core.b64.enc(dsa.publicKey) },
  };
  const sig = core.b64.enc(mockPQ.dsa.sign(dsa.secretKey, core.utf8.enc(core.canonicalJson(manifest))));
  const opts = { manifest, manifestSig: sig, keys: { kemSecret: kem.secretKey, dsaSecret: dsa.secretKey }, pq: mockPQ, store, criticalDir, ticketKey: crypto.randomBytes(32) };
  const handlers = Array.from({ length: instances }, () => createServerlessHandler(opts)); // separate instances: no shared memory
  let i = 0; const seen = new Map();
  const server = http.createServer(async (req, res) => {
    const h = handlers[i++ % handlers.length];
    seen.set(h, (seen.get(h) ?? 0) + 1);
    if (vercelBody && req.method !== 'GET') {
      const chunks = []; for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks); const ct = req.headers['content-type'] ?? '';
      req.body = ct.includes('json') ? JSON.parse(raw.toString() || '{}') : raw; // what Vercel does
    }
    return h(req, res);
  });
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  const client = (over = {}) => new CompactClient({ connect: { appId: 'demo', endpoint: url, layout: 'vercel', verify: 'off', ...over }, manifest, pq: mockPQ, fetchImpl: (...a) => fetch(...a) });
  return { server, url, manifest, opts, client, seen, store, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

test('serverless channel: sessions survive being served by different instances (tickets), rpc rules still apply', async () => {
  for (const vercelBody of [false, true]) {
    const t = await boot({ vercelBody });
    try {
      const c = t.client();
      assert.deepEqual(await c.call('lib/auth.js', 'login', ['ann', 'pw']), { user: 'ann', ok: true });
      for (let k = 0; k < 6; k++) assert.equal((await c.call('lib/auth.js', 'login', ['x', 'pw'])).ok, true);
      assert.ok([...t.seen.values()].every((n) => n >= 2), 'every instance served requests');
      await assert.rejects(() => c.call('lib/auth.js', 'secret', []), /not exposed/);
      await assert.rejects(() => c.call('../../etc/passwd', 'x', []), /not exposed/);
      const health = await (await fetch(`${t.url}/api/compact/health`)).json();
      assert.equal(health.ok, true); assert.equal(health.integrity.ok, true);
    } finally { await t.close(); }
  }
});

test('serverless channel: replay, tampered/expired tickets, wrong paths and missing storage are rejected', async () => {
  const t = await boot();
  try {
    const recorded = [];
    const c = t.client();
    c.fetchImpl = async (u, init) => { if (String(u).endsWith('/msg')) recorded.push({ u, init }); return fetch(u, init); };
    await c.call('lib/auth.js', 'login', ['a', 'pw']);
    assert.equal(await st(recorded[0].u, recorded[0].init), 409);
    const bad = { ...recorded[0].init, headers: { ...recorded[0].init.headers, 'x-compact-ticket': 'AAAA' + recorded[0].init.headers['x-compact-ticket'].slice(4) } };
    assert.equal(await st(recorded[0].u, bad), 401);
    const expired = await core.sealTicket(t.opts.ticketKey, { sid: 'x', exp: Date.now() - 1000, raw: new Uint8Array(64) });
    assert.equal(await st(recorded[0].u, { ...recorded[0].init, headers: { ...recorded[0].init.headers, 'x-compact-ticket': expired } }), 401);
    assert.equal(await st(`${t.url}/nope`), 404);
    assert.equal(await st(`${t.url}/api/compact/nope`), 404);
    // an expired session is renewed transparently by the client
    const c2 = t.client(); await c2.call('lib/auth.js', 'login', ['a', 'pw']);
    c2.session.ticket = expired;
    assert.equal((await c2.call('lib/auth.js', 'login', ['a', 'pw'])).ok, true);
  } finally { await t.close(); }
  const noStore = await boot({ store: null });
  try {
    await assert.rejects(() => noStore.client().call('lib/auth.js', 'login', ['a', 'pw']), /Request failed \(503\)/);
  } finally { await noStore.close(); }
});

test('serverless integrity check flags critical code that differs from the manifest', async () => {
  const dir = fixture();
  const t = await boot({ criticalDir: dir });
  fs.appendFileSync(path.join(dir, 'lib/auth.js'), '\n// changed after the manifest was signed\n');
  const t2 = await boot({ criticalDir: dir });
  try {
    assert.equal((await (await fetch(`${t2.url}/api/compact/health`)).json()).integrity.ok, false);
    assert.deepEqual((await (await fetch(`${t2.url}/api/compact/health`)).json()).integrity.changed, ['lib/auth.js']);
  } finally { await t.close(); await t2.close(); }
});

test('serverless vault on MemStore: encrypted put/get through several instances; heads stay consistent', async () => {
  const t = await boot({ vercelBody: true });
  try {
    const v = new VaultClient({ endpoint: `${t.url}/api/compact`, appId: 'demo', key: randomKey() });
    await v.put('a', 'alpha'); await v.put('b', { n: 2 });
    assert.equal(await v.get('a'), 'alpha'); assert.deepEqual(await v.get('b'), { n: 2 });
    assert.deepEqual(await v.list(), ['a', 'b']);
    for (const b of t.store.blobs.values()) assert.ok(!b.includes(Buffer.from('alpha')));
  } finally { await t.close(); }
});

test('UpstashStore + serverless vault over the (mock) Redis REST API: blobs, optimistic heads, proofs, replay claims', async () => {
  const up = mockUpstash(); const port = await listen(up.server);
  const store = new UpstashStore({ url: `http://127.0.0.1:${port}`, token: 'tok' });
  try {
    assert.deepEqual(await store.putBlob('a'.repeat(64), Buffer.from('hello blob')), { id: 'a'.repeat(64) });
    await store.putBlob('a'.repeat(64), Buffer.from('hello blob')); // idempotent
    assert.equal((await store.getBlob('a'.repeat(64))).toString(), 'hello blob');
    assert.equal(await store.getBlob('b'.repeat(64)), null);
    assert.equal((await store.stats()).bytes, 10);
    const kid = 'c'.repeat(32);
    assert.equal(await store.getHead(kid), null);
    assert.deepEqual(await store.setHead(kid, 1, 'a'.repeat(64)), { ok: true });
    assert.deepEqual(await store.setHead(kid, 1, 'a'.repeat(64)), { ok: false, n: 1 });
    assert.deepEqual(await store.setHead(kid, 5, 'a'.repeat(64)), { ok: false, n: 1 });
    assert.deepEqual(await store.setHead(kid, 2, 'f'.repeat(64)), { ok: false, error: 'unknown blob', n: 1 });
    assert.deepEqual(await store.getHead(kid), { n: 1, id: 'a'.repeat(64) });
    assert.deepEqual(await store.leaves(), [{ kid, n: 1, id: 'a'.repeat(64) }]);
    assert.equal((await store.stats()).writes, 1);
    assert.equal(await store.claim('x:1'), true); assert.equal(await store.claim('x:1'), false);
    await assert.rejects(() => new UpstashStore({ url: `http://127.0.0.1:${port}`, token: 'wrong' }).cmd('GET', 'x'), /401/);
    assert.equal(UpstashStore.fromEnv({}), null);
    assert.equal(UpstashStore.fromEnv({ KV_REST_API_URL: 'https://x', KV_REST_API_TOKEN: 't' }).url, 'https://x');

    const t = await boot({ store: new UpstashStore({ url: `http://127.0.0.1:${port}`, token: 'tok', prefix: 'app2:' }), vercelBody: true });
    try {
      const v = new VaultClient({ endpoint: `${t.url}/api/compact`, appId: 'demo', key: randomKey() });
      const other = new VaultClient({ endpoint: `${t.url}/api/compact`, appId: 'demo', key: randomKey() });
      await v.put('k', 'v'); await other.put('z', 'z');
      await Promise.all([v.put('p', '1'), new VaultClient({ endpoint: `${t.url}/api/compact`, appId: 'demo', key: v.key }).put('q', '2')]);
      assert.deepEqual(await v.list(), ['k', 'p', 'q']);
      const root = await (await fetch(`${t.url}/api/compact/v1/root`)).json();
      assert.equal(root.count, 2); assert.equal(root.writes, 4); // four head updates: k, z, p, q
      assert.equal((await t.client().call('lib/auth.js', 'login', ['a', 'pw'])).ok, true); // replay claims in Redis
    } finally { await t.close(); }
  } finally { up.server.closeAllConnections?.(); up.server.close(); }
});

test('serverless http mode: the critical app starts once inside the function and is reached over the channel', async () => {
  const probe = http.createServer(); const port = await listen(probe); await new Promise((r) => probe.close(r));
  const app = `import http from 'node:http'; let starts = (globalThis.__starts ??= 0); globalThis.__starts++;\nhttp.createServer((req,res)=>{ let b=''; req.on('data',c=>b+=c); req.on('end',()=>{ res.setHeader('x-app','yes'); res.end(JSON.stringify({url:req.url,body:b,port:process.env.PORT,starts:globalThis.__starts})); }); }).listen(process.env.PORT).unref();`;
  const dir = fixture({ 'server.mjs': app });
  const t = await boot({ mode: 'http', criticalDir: dir, manifestExtra: { entry: 'server.mjs', http: { prefixes: ['/api'], port }, rpc: undefined }, files: [] });
  try {
    const c = t.client();
    const r1 = await c.http({ method: 'POST', path: '/api/notes?x=1', headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('hi') });
    const j1 = JSON.parse(new TextDecoder().decode(r1.body));
    assert.equal(r1.status, 200); assert.equal(j1.url, '/api/notes?x=1'); assert.equal(j1.body, 'hi'); assert.equal(j1.port, String(port)); assert.equal(r1.headers['x-app'], 'yes');
    const j2 = JSON.parse(new TextDecoder().decode((await c.http({ method: 'GET', path: '/api/x' })).body));
    assert.equal(j2.starts, 1, 'imported once, reused by later requests');
    await assert.rejects(() => c.http({ method: 'GET', path: '/admin' }), /not exposed/);
  } finally { await t.close(); }
});
