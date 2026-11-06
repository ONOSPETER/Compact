import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../templates/runtime/core.mjs';
import { createRunner } from '../templates/runtime/runner.mjs';
import { CompactClient } from '../templates/runtime/client-core.mjs';

import { mockPQ } from './helpers.mjs';

test('handshake: both sides derive working keys; tampering and wrong server key are rejected', async () => {
  const kem = mockPQ.kem.keygen(); const dsa = mockPQ.dsa.keygen();
  const mHash = await core.manifestHash({ a: 1 });
  const { hello, state } = await core.clientHello(mockPQ, kem.publicKey);
  const { reply, keys: sKeys } = await core.serverHello(mockPQ, { kemSecret: kem.secretKey, dsaSecret: dsa.secretKey }, hello, mHash, 'sid1');
  const cKeys = await core.clientFinish(mockPQ, state, hello, reply, dsa.publicKey, mHash);
  const ct = await core.sealMessage(cKeys, 'c2s', 'sid1', 1, { hi: 'there' });
  assert.deepEqual(await core.openMessage(sKeys, 'c2s', 'sid1', 1, ct), { hi: 'there' });
  await assert.rejects(() => core.openMessage(sKeys, 'c2s', 'sid1', 2, ct)); // wrong sequence -> wrong nonce/aad
  await assert.rejects(() => core.openMessage(sKeys, 'c2s', 'other', 1, ct)); // wrong session id
  await assert.rejects(() => core.openMessage(sKeys, 's2c', 'sid1', 1, ct)); // wrong direction
  const evil = mockPQ.dsa.keygen();
  await assert.rejects(() => core.clientFinish(mockPQ, state, hello, reply, evil.publicKey, mHash), /signature invalid/);
  const otherHash = await core.manifestHash({ a: 2 });
  await assert.rejects(() => core.clientFinish(mockPQ, state, hello, reply, dsa.publicKey, otherHash), /signature invalid/);
});

test('canonicalJson is order independent', async () => {
  assert.equal(core.canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), core.canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
});

async function bootRunner({ mode, files, allow, prefixes }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-rt-'));
  for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); }
  const kem = mockPQ.kem.keygen(); const dsa = mockPQ.dsa.keygen();
  const manifest = {
    v: 1, mode, app: { id: 'demo' },
    critical: { rpc: { allow }, http: { prefixes, port: 4000 }, entry: 'server.js' },
    runner: { kemPublic: core.b64.enc(kem.publicKey), dsaPublic: core.b64.enc(dsa.publicKey) },
  };
  const sig = core.b64.enc(mockPQ.dsa.sign(dsa.secretKey, core.utf8.enc(core.canonicalJson(manifest))));
  const runner = createRunner({ manifest, manifestSig: sig, keys: { kemSecret: kem.secretKey, dsaSecret: dsa.secretKey }, pq: mockPQ, criticalDir: dir, appPort: 0, log: () => {}, spawnApp: false });
  const port = await runner.listen(0, '127.0.0.1');
  const client = new CompactClient({
    connect: { appId: 'demo', endpoint: `http://127.0.0.1:${port}`, verify: 'off' }, manifest, pq: mockPQ,
    fetchImpl: (...a) => fetch(...a),
  });
  return { runner, client, port, manifest };
}

test('end to end rpc: allowed call works; unexposed module/function and bad args are refused', async () => {
  const { runner, client } = await bootRunner({
    mode: 'rpc', allow: { 'lib/auth.js': ['login', 'boom'] }, prefixes: [],
    files: { 'lib/auth.js': 'export async function login(u,p){ return {user:u, ok:p==="pw"} }\nexport function boom(){ throw new Error("nope") }\nexport function secret(){ return 1 }', 'lib/other.js': 'export const f=()=>1' },
  });
  try {
    assert.deepEqual(await client.call('lib/auth.js', 'login', ['ann', 'pw']), { user: 'ann', ok: true });
    await assert.rejects(() => client.call('lib/auth.js', 'secret', []), /not exposed/);
    await assert.rejects(() => client.call('lib/other.js', 'f', []), /not exposed/);
    await assert.rejects(() => client.call('lib/auth.js', 'boom', []), /nope/);
    await assert.rejects(() => client.call('../../etc/passwd', 'x', []), /not exposed/);
  } finally { await runner.close(); }
});

test('server restart: client transparently re-handshakes (401 -> new session)', async () => {
  const { runner, client } = await bootRunner({ mode: 'rpc', allow: { 'a.js': ['f'] }, prefixes: [], files: { 'a.js': 'export const f = () => 7' } });
  try {
    assert.equal(await client.call('a.js', 'f', []), 7);
    runner.sessions.clear(); // simulate restart
    assert.equal(await client.call('a.js', 'f', []), 7);
  } finally { await runner.close(); }
});

test('replay of an encrypted message is rejected; garbage is rejected without crashing', async () => {
  const { runner, client, port } = await bootRunner({ mode: 'rpc', allow: { 'a.js': ['f'] }, prefixes: [], files: { 'a.js': 'export const f = () => 1' } });
  try {
    await client.ready();
    const { sid, keys } = client.session;
    const ct = await core.sealMessage(keys, 'c2s', sid, 1, { t: 'rpc', module: 'a.js', fn: 'f', args: [] });
    const post = (body, s = sid) => fetch(`http://127.0.0.1:${port}/.compact/msg`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-compact-sid': s }, body: JSON.stringify(body) });
    assert.equal((await post({ seq: 1, ct })).status, 200);
    assert.equal((await post({ seq: 1, ct })).status, 409); // replay
    assert.equal((await post({ seq: 5, ct })).status, 400); // wrong sequence for this ciphertext
    assert.equal((await post({ nonsense: true })).status, 409);
    assert.equal((await post({ seq: 2, ct }, 'nosuch')).status, 401);
    const bad = await fetch(`http://127.0.0.1:${port}/.compact/hello`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`http://127.0.0.1:${port}/.compact/health`)).status, 200);
  } finally { await runner.close(); }
});

test('http mode: requests are proxied to the critical app only under exposed prefixes', async () => {
  const http = await import('node:http');
  const app = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { res.setHeader('x-hello', 'yes'); res.end(JSON.stringify({ path: req.url, method: req.method, body: b })); }); });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const appPort = app.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-http-'));
  const kem = mockPQ.kem.keygen(); const dsa = mockPQ.dsa.keygen();
  const manifest = { v: 1, mode: 'http', critical: { http: { prefixes: ['/api'] }, entry: 'x.js' }, runner: { kemPublic: core.b64.enc(kem.publicKey), dsaPublic: core.b64.enc(dsa.publicKey) } };
  const sig = core.b64.enc(mockPQ.dsa.sign(dsa.secretKey, core.utf8.enc(core.canonicalJson(manifest))));
  const runner = createRunner({ manifest, manifestSig: sig, keys: { kemSecret: kem.secretKey, dsaSecret: dsa.secretKey }, pq: mockPQ, criticalDir: dir, appPort, log: () => {}, spawnApp: false });
  const port = await runner.listen(0, '127.0.0.1');
  const client = new CompactClient({ connect: { appId: 'x', endpoint: `http://127.0.0.1:${port}`, verify: 'off' }, manifest, pq: mockPQ, fetchImpl: (...a) => fetch(...a) });
  try {
    const r = await client.http({ method: 'POST', path: '/api/notes?x=1', headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('hello') });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(r.body)), { path: '/api/notes?x=1', method: 'POST', body: 'hello' });
    assert.equal(r.headers['x-hello'], 'yes');
    await assert.rejects(() => client.http({ method: 'GET', path: '/admin' }), /not exposed/);
    await assert.rejects(() => client.http({ method: 'GET', path: '/api/../admin' }), /bad path/);
    await assert.rejects(() => client.http({ method: 'GET', path: '//evil.com/api' }), /bad path/);
  } finally { await runner.close(); app.close(); }
});

test('client refuses a server that serves a different manifest', async () => {
  const { runner, client, manifest } = await bootRunner({ mode: 'rpc', allow: { 'a.js': ['f'] }, prefixes: [], files: { 'a.js': 'export const f = () => 1' } });
  try {
    client.manifest = { ...manifest, app: { id: 'tampered' } };
    await assert.rejects(() => client.call('a.js', 'f', []), /different manifest/);
  } finally { await runner.close(); }
});
