import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as core from '../templates/runtime/core.mjs';
import { buildTree, proofFor, verifyProof, leafHash } from '../templates/runtime/merkle.mjs';
import { pad, unpad, encryptRecord, decryptRecord, keyFromPassphrase, randomKey, VaultClient, BUCKETS } from '../templates/runtime/vault.mjs';
import { MemStore, FsStore } from '../templates/runtime/store.mjs';
import { createRunner } from '../templates/runtime/runner.mjs';
import { createContext } from '../src/context.mjs';
import { transformProject } from '../src/transform/transform.mjs';
import { commitProject, onChainShare } from '../src/deploy/commit.mjs';
import { upgradeProject } from '../src/deploy/upgrade.mjs';
import { mockPQ, mockNear } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compact-vt-'));
const rejectsWith = (p, code) => assert.rejects(p, (e) => e.code === code);

test('merkle: every leaf of every tree size proves; wrong leaf/index/root fails', async () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = Array.from({ length: n }, (_, i) => core.utf8.enc(`leaf-${i}`)).map((b) => new Uint8Array([...b, ...new Array(32 - b.length).fill(0)]));
    const { levels, root } = await buildTree(leaves);
    const rootHex = core.hex(root);
    for (let i = 0; i < n; i++) assert.ok(await verifyProof(leaves[i], i, proofFor(levels, i), rootHex), `n=${n} i=${i}`);
    if (n > 1) {
      assert.equal(await verifyProof(leaves[0], 1, proofFor(levels, 0), rootHex), false);
      assert.equal(await verifyProof(leaves[1], 0, proofFor(levels, 0), rootHex), false);
    }
    assert.equal(await verifyProof(leaves[0], 0, proofFor(levels, 0), '00'.repeat(32)), false);
  }
  assert.equal(core.hex((await buildTree([])).root), '00'.repeat(32));
});

test('vault crypto: round trip, padding hides length, wrong key/context/tamper all fail, nonces are fresh', async () => {
  const key = randomKey();
  for (const len of [0, 1, 100, 4000]) {
    const data = crypto.getRandomValues(new Uint8Array(len));
    const blob = await encryptRecord(key, 'rec', data);
    assert.equal(blob.length, 1 + 12 + 16 + BUCKETS[0], 'all small records look identical in size');
    assert.deepEqual(await decryptRecord(key, 'rec', blob), data);
  }
  const big = await encryptRecord(key, 'rec', new Uint8Array(5000));
  assert.equal(big.length, 1 + 12 + 16 + BUCKETS[1]);
  const blob = await encryptRecord(key, 'rec', core.utf8.enc('secret'));
  assert.notDeepEqual(await encryptRecord(key, 'rec', core.utf8.enc('secret')), blob);
  await rejectsWith(decryptRecord(randomKey(), 'rec', blob), 'DECRYPT');
  await rejectsWith(decryptRecord(key, 'index', blob), 'DECRYPT'); // a record cannot be replayed as an index
  const bad = blob.slice(); bad[40] ^= 1;
  await rejectsWith(decryptRecord(key, 'rec', bad), 'DECRYPT');
  assert.throws(() => pad(new Uint8Array(1_000_000)), (e) => e.code === 'TOO_LARGE');
  assert.deepEqual(unpad(pad(core.utf8.enc('x'))), core.utf8.enc('x'));
  const salt = new Uint8Array(16);
  assert.deepEqual(await keyFromPassphrase('pw', salt, 1000), await keyFromPassphrase('pw', salt, 1000));
  assert.notDeepEqual(await keyFromPassphrase('pw', salt, 1000), await keyFromPassphrase('pw2', salt, 1000));
});

test('store: heads move strictly forward, unknown blobs refused, quota enforced, FsStore persists', () => {
  const s = new MemStore({ maxBytes: 100 });
  assert.deepEqual(s.putBlob('a'.repeat(64), Buffer.alloc(60)), { id: 'a'.repeat(64) });
  assert.ok(s.putBlob('b'.repeat(64), Buffer.alloc(60)).error);
  const kid = 'c'.repeat(32);
  assert.equal(s.setHead(kid, 1, 'a'.repeat(64)).ok, true);
  assert.deepEqual(s.setHead(kid, 1, 'a'.repeat(64)), { ok: false, n: 1 });
  assert.equal(s.setHead(kid, 3, 'a'.repeat(64)).ok, false);
  assert.equal(s.setHead(kid, 2, 'f'.repeat(64)).error, 'unknown blob');
  const dir = tmp();
  const f = new FsStore(dir);
  f.putBlob('a'.repeat(64), Buffer.from('hello'));
  f.setHead(kid, 1, 'a'.repeat(64));
  const again = new FsStore(dir);
  assert.deepEqual(again.getHead(kid), { n: 1, id: 'a'.repeat(64) });
  assert.equal(again.getBlob('a'.repeat(64)).toString(), 'hello');
  assert.equal(again.stats().writes, 1);
});

async function boot(store = new MemStore()) {
  const kem = mockPQ.kem.keygen(); const dsa = mockPQ.dsa.keygen();
  const manifest = { v: 1, mode: 'rpc', critical: { rpc: { allow: {} } }, runner: { kemPublic: core.b64.enc(kem.publicKey), dsaPublic: core.b64.enc(dsa.publicKey) } };
  const runner = createRunner({ manifest, manifestSig: 'x', keys: { kemSecret: kem.secretKey, dsaSecret: dsa.secretKey }, pq: mockPQ, criticalDir: tmp(), log: () => {}, spawnApp: false, store });
  const port = await runner.listen(0, '127.0.0.1');
  return { runner, store, url: `http://127.0.0.1:${port}` };
}
const router = (near) => (url, init) => (String(url).startsWith('http://127.0.0.1') ? fetch(url, init) : near.fetch(url, init));

test('vault end to end: put/get/list/remove; host sees only fixed-size ciphertext; concurrent writers do not lose data', async () => {
  const { runner, store, url } = await boot();
  try {
    const key = randomKey();
    const v = new VaultClient({ endpoint: url, appId: 'app', key });
    assert.equal(await v.get('missing'), undefined);
    await v.put('note/1', 'top secret text');
    await v.put('cfg', { a: [1, 2, 3] });
    await v.put('bin', new Uint8Array([9, 8, 7]));
    assert.equal(await v.get('note/1'), 'top secret text');
    assert.deepEqual(await v.get('cfg'), { a: [1, 2, 3] });
    assert.deepEqual(await v.get('bin'), new Uint8Array([9, 8, 7]));
    assert.deepEqual(await v.list(), ['bin', 'cfg', 'note/1']);
    for (const id of [...store.blobs.keys()]) {
      const b = store.blobs.get(id);
      assert.equal(b.length, 1 + 12 + 16 + 4096);
      assert.ok(!b.includes(Buffer.from('top secret')), 'plaintext must never reach the host');
    }
    assert.ok(await v.remove('cfg')); assert.equal(await v.get('cfg'), undefined); assert.equal(await v.remove('cfg'), false);
    // two devices writing at the same time: both writes survive (optimistic concurrency + retry)
    const other = new VaultClient({ endpoint: url, appId: 'app', key });
    await Promise.all([v.put('d1', 'one'), other.put('d2', 'two')]);
    assert.deepEqual(await v.list(), ['bin', 'd1', 'd2', 'note/1']);
    // a different key is a different, empty vault
    assert.deepEqual(await new VaultClient({ endpoint: url, appId: 'app', key: randomKey() }).list(), []);
  } finally { await runner.close(); }
});

test('vault integrity: tampered, swapped or withheld blobs are detected', async () => {
  const { runner, store, url } = await boot();
  try {
    const v = new VaultClient({ endpoint: url, appId: 'app', key: randomKey() });
    await v.put('a', 'alpha'); await v.put('b', 'beta');
    const [ida, idb] = Object.values(JSON.parse(core.utf8.dec(await decryptRecord(v.key, 'index', store.getBlob((await v.head()).id))))).flatMap((m) => Object.values(m).map((x) => x.id));
    const orig = store.blobs.get(ida);
    const t = Buffer.from(orig); t[50] ^= 1; store.blobs.set(ida, t);
    await rejectsWith(v.get('a'), 'TAMPERED'); // content no longer matches its hash
    store.blobs.set(ida, store.blobs.get(idb)); // swap in another valid blob under the same id
    await rejectsWith(v.get('a'), 'TAMPERED');
    store.blobs.delete(ida);
    await rejectsWith(v.get('a'), 'MISSING');
    assert.equal(await v.get('b'), 'beta');
  } finally { await runner.close(); }
});

const APP = {
  'package.json': JSON.stringify({ name: 'notes', dependencies: { express: '^4', react: '^18' }, devDependencies: { vite: '^5' } }),
  'index.html': '<script type="module" src="/src/main.jsx"></script>',
  'src/main.jsx': "import React from 'react'; document.title='x'; fetch('/api/n');",
  'server/index.js': "import express from 'express'; express().listen(4000);",
};
async function project(near, url) {
  const ctx = await createContext({ home: tmp(), cwd: tmp(), pq: mockPQ, fetchImpl: router(near) });
  const src = tmp();
  for (const [f, c] of Object.entries(APP)) { fs.mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); fs.writeFileSync(path.join(src, f), c); }
  const r = await transformProject(ctx, src, { out: path.join(tmp(), 'notes-compact'), name: 'notes' });
  const dep = await ctx.keystore.add({}); near.fund(dep.accountId);
  return { ctx, r, dep, near: { rpcUrls: ['https://rpc.test'], registryAccount: dep.accountId } };
}

test('commit policy + rollback detection: one transaction covers many writes; the host cannot rewind unnoticed', async () => {
  const near = mockNear();
  const { runner, store, url } = await boot();
  try {
    const { ctx, r, near: nearCfg } = await project(near, url);
    const key = randomKey();
    const v = new VaultClient({ endpoint: url, appId: r.app.id, key, fetchImpl: router(near), near: nearCfg });
    assert.equal((await v.verify()).status, 'unanchored');

    await v.put('k0', 'v0');
    const h1 = await v.head(); // keep the very first head to replay later
    for (let i = 1; i < 3; i++) await v.put(`k${i}`, `v${i}`);
    const skipped = await commitProject(ctx, 'notes', { endpoint: url });
    assert.equal(skipped.skipped, true); assert.equal(skipped.reason, 'below-threshold'); // 3 < 10 writes: no transaction
    assert.equal(near.txs.size, 0);

    for (let i = 3; i < 12; i++) await v.put(`k${i}`, `v${i}`);
    await new VaultClient({ endpoint: url, appId: r.app.id, key: randomKey() }).put('z', 'z'); // a second vault, so proofs have a non-empty path
    const done = await commitProject(ctx, 'notes', { endpoint: url });
    assert.equal(done.skipped, false);
    assert.deepEqual(done.receipts.map((x) => x.name), ['deploy-registry', 'anchor-root']);
    assert.equal(near.txs.size, 2);
    assert.equal((await commitProject(ctx, 'notes', { endpoint: url })).reason, 'unchanged'); // idempotent, no new tx
    assert.equal(near.txs.size, 2);

    assert.equal((await v.verify()).status, 'ok');
    await v.put('after', 'x'); // newer than the anchor is fine
    assert.equal((await v.verify()).status, 'ok');
    assert.equal((await new VaultClient({ endpoint: url, appId: r.app.id, key: randomKey(), fetchImpl: router(near), near: nearCfg }).verify()).status, 'ok'); // empty vault

    // the host rewinds the vault to an older version
    const kid = await v.kid();
    const current = store.getHead(kid);
    store.heads.set(kid, { n: h1.n, id: h1.id });
    const rolled = await v.verify();
    assert.equal(rolled.status, 'rollback'); assert.match(rolled.note, /anchored on-chain/);
    store.heads.set(kid, current);
    assert.equal((await v.verify()).status, 'ok');

    // a lying proof is rejected
    const lying = new VaultClient({ endpoint: url, appId: r.app.id, key, near: nearCfg, fetchImpl: async (u, i) => {
      const res = await router(near)(u, i);
      if (!String(u).includes('/v1/proof/')) return res;
      const p = await res.json(); p.path = p.path.map((x) => '00'.repeat(32));
      return { ok: true, status: 200, json: async () => p };
    } });
    assert.equal((await lying.verify()).status, 'proof-invalid');

    // on-chain share: 2 transactions vs 13 writes so far; after 100 more writes it is well under 10%
    for (let i = 0; i < 100; i++) await v.put(`m${i % 7}`, `v${i}`);
    const again = await commitProject(ctx, 'notes', { endpoint: url });
    assert.equal(again.skipped, false);
    assert.ok(again.share < 0.1, `share was ${again.share}`);
    assert.equal(onChainShare(await ctx.state.get(r.app.id)).txs, 3);
  } finally { await runner.close(); }
});

test('commit refuses a deployer that does not own the registry, and explains how to proceed', async () => {
  const near = mockNear();
  const { runner, url } = await boot();
  try {
    const { ctx, r } = await project(near, url);
    const dir = r.outDir; const f = path.join(dir, 'portal/src/compact/connect.json');
    const c = JSON.parse(fs.readFileSync(f, 'utf8')); c.near.registryAccount = 'someone-else.testnet'; fs.writeFileSync(f, JSON.stringify(c));
    const v = new VaultClient({ endpoint: url, appId: r.app.id, key: randomKey() });
    for (let i = 0; i < 2; i++) await v.put(`k${i}`, 'x');
    await assert.rejects(() => commitProject(ctx, 'notes', { endpoint: url, force: true }), (e) => e.code === 'E_REGISTRY_MISMATCH' && /--account/.test(e.hint));
  } finally { await runner.close(); }
});

test('commit explains an unreachable runner', async () => {
  const near = mockNear();
  const { ctx } = await project(near, 'x');
  await assert.rejects(() => commitProject(ctx, 'notes', { endpoint: 'http://127.0.0.1:1' }), (e) => e.code === 'E_RUNNER_UNREACHABLE' && /compact serve/.test(e.hint));
});

test('upgrade refreshes runtime files only; keys, manifest and your code are untouched; second run is a no-op', async () => {
  const near = mockNear();
  const { ctx, r } = await project(near, 'x');
  const read = (p) => fs.readFileSync(path.join(r.outDir, p), 'utf8');
  const before = { keys: read('compact/keys/runner.secret.json'), manifest: read('compact/manifest.json'), server: read('critical/server/index.js') };
  fs.rmSync(path.join(r.outDir, 'compact/runtime/store.mjs'));
  fs.writeFileSync(path.join(r.outDir, 'compact/runtime/runner.mjs'), '// old runner');
  fs.rmSync(path.join(r.outDir, 'portal/src/compact/vault.mjs'));
  const out = await upgradeProject(ctx, 'notes');
  assert.ok(out.changed.includes('compact/runtime/store.mjs') && out.changed.includes('compact/runtime/runner.mjs') && out.changed.includes('portal/src/compact/vault.mjs'));
  assert.equal(read('compact/keys/runner.secret.json'), before.keys);
  assert.equal(read('compact/manifest.json'), before.manifest);
  assert.equal(read('critical/server/index.js'), before.server);
  assert.deepEqual((await upgradeProject(ctx, 'notes')).changed, []);
});
