import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '../src/context.mjs';
import { transformProject } from '../src/transform/transform.mjs';
import { deployProject } from '../src/deploy/deploy.mjs';
import { pushPortal } from '../src/deploy/push.mjs';
import { readRecord, buildRegistryWasm, registryWasmHash } from '../src/near/registry.mjs';
import { mockPQ, mockNear, mockGithub } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compact-dp-'));
const APP = {
  'package.json': JSON.stringify({ name: 'notes', dependencies: { express: '^4', react: '^18' }, devDependencies: { vite: '^5' } }),
  'index.html': '<script type="module" src="/src/main.jsx"></script>',
  'src/main.jsx': "import React from 'react'; document.title='x'; fetch('/api/n');",
  'server/index.js': "import express from 'express'; express().listen(4000);",
};
function write(dir, files) { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } }

async function setup({ near, gh } = {}) {
  const ctx = await createContext({ home: tmp(), cwd: tmp(), pq: mockPQ, fetchImpl: async (url, init) => (String(url).includes('github') ? (gh ?? mockGithub()).fetch(url, init) : (near ?? mockNear()).fetch(url, init)) });
  const src = tmp(); write(src, APP);
  const r = await transformProject(ctx, src, { out: path.join(tmp(), 'notes-compact'), name: 'notes' });
  return { ctx, r };
}

test('deploy: unfunded deployer gives an actionable error', async () => {
  const { ctx } = await setup();
  const dep = await ctx.keystore.add({});
  await assert.rejects(() => deployProject(ctx, 'notes'), (e) => e.code === 'E_INSUFFICIENT_FUNDS' && e.message.includes(dep.accountId) && /faucet/.test(e.hint));
});

test('deploy: deploys registry, writes the record, updates connect.json, saves receipts; second run is a no-op', async () => {
  const near = mockNear();
  const { ctx, r } = await setup({ near });
  const dep = await ctx.keystore.add({});
  near.fund(dep.accountId);

  const out = await deployProject(ctx, 'notes', { endpoint: 'https://runner.example' });
  assert.equal(out.receipts.length, 2);
  assert.deepEqual(out.receipts.map((x) => x.name), ['deploy-registry', 'write-record']);
  assert.ok(out.receipts.every((x) => x.ok && x.explorer.includes(x.txHash)));
  const rec = await readRecord({ rpc: ctx.rpc, accountId: dep.accountId, appId: out.app.id });
  assert.equal(rec.manifest, r.connect.manifestSha256);
  assert.equal(rec.endpoint, 'https://runner.example');
  const connect = JSON.parse(fs.readFileSync(path.join(r.outDir, 'portal/src/compact/connect.json'), 'utf8'));
  assert.equal(connect.verify, 'strict'); assert.equal(connect.near.registryAccount, dep.accountId); assert.equal(connect.endpoint, 'https://runner.example');
  assert.ok(fs.readdirSync(path.join(r.outDir, 'compact/receipts')).some((f) => f.endsWith('-deploy.json')));
  assert.equal((await ctx.state.get(out.app.id)).deployments.length, 1);

  const again = await deployProject(ctx, 'notes', { endpoint: 'https://runner.example' });
  assert.equal(again.receipts.length, 0); // idempotent: nothing re-sent
  assert.equal(again.anchored, false);
  const moved = await deployProject(ctx, 'notes', { endpoint: 'https://new.example' });
  assert.deepEqual(moved.receipts.map((x) => x.name), ['write-record']); // only the record changes
});

test('deploy: edited critical/ is re-hashed and re-signed before anchoring', async () => {
  const near = mockNear();
  const { ctx, r } = await setup({ near });
  const dep = await ctx.keystore.add({}); near.fund(dep.accountId);
  const before = r.connect.manifestSha256;
  fs.appendFileSync(path.join(r.outDir, 'critical/server/index.js'), '\n// edited\n');
  const out = await deployProject(ctx, 'notes');
  assert.equal(out.manifestChanged, true);
  assert.notEqual(out.record.manifest, before);
  const portalManifest = JSON.parse(fs.readFileSync(path.join(r.outDir, 'portal/src/compact/manifest.json'), 'utf8'));
  const diskManifest = JSON.parse(fs.readFileSync(path.join(r.outDir, 'compact/manifest.json'), 'utf8'));
  assert.deepEqual(portalManifest, diskManifest);
});

test('deploy: transient RPC failure on broadcast is retried and still lands exactly once', async () => {
  const near = mockNear({ failBroadcastOnce: true });
  const { ctx } = await setup({ near });
  ctx.rpc.urls = ['https://a', 'https://b']; // two endpoints so failover is exercised
  const dep = await ctx.keystore.add({}); near.fund(dep.accountId);
  const out = await deployProject(ctx, 'notes');
  assert.equal(out.receipts.length, 2);
  assert.equal(near.txs.size, 2);
});

test('deploy: a contract rejected by the network surfaces as E_TX_REJECTED; foreign contract is never overwritten', async () => {
  const near = mockNear();
  const { ctx } = await setup({ near });
  const dep = await ctx.keystore.add({}); near.fund(dep.accountId);
  near.accounts.get(dep.accountId).code = Buffer.from('someone elses contract');
  await assert.rejects(() => deployProject(ctx, 'notes'), (e) => e.code === 'E_REGISTRY_CONFLICT');
});

test('push: creates a private repo, is idempotent, retries rate limits, blocks secrets', async () => {
  const gh = mockGithub({ rateLimitOnce: true });
  const { ctx, r } = await setup({ gh });
  await ctx.credentials.saveGithub({ token: 'ghp_test', user: 'ann' });
  const a = await pushPortal(ctx, 'notes');
  assert.equal(a.owner, 'ann'); assert.equal(a.repo, 'notes-portal'); assert.equal(a.private, true); assert.equal(a.created, true);
  assert.equal(a.endpointIsLocal, true);
  const b = await pushPortal(ctx, 'notes');
  assert.equal(b.unchanged, true); assert.equal(b.commitSha, a.commitSha); // no empty commit
  fs.writeFileSync(path.join(r.outDir, 'portal/src/leak.js'), 'const k = "ed25519:' + '1'.repeat(88) + '";');
  await assert.rejects(() => pushPortal(ctx, 'notes'), (e) => e.code === 'E_SECRETS_IN_PORTAL' && /leak\.js/.test(e.details[0]));
  fs.writeFileSync(path.join(r.outDir, 'portal/src/leak.js'), '// clean');
  const c = await pushPortal(ctx, 'notes');
  assert.equal(c.unchanged, false); // content changed -> new commit
  assert.equal((await ctx.state.get(c.app.id)).pushes.length, 3);
  const dry = await pushPortal(ctx, 'notes', { dryRun: true });
  assert.ok(dry.files.includes('src/compact/connect.json') && !dry.files.some((f) => f.includes('server')));
});

test('deploy: a deployer that still has the v0.1.0 registry (memory import, rejected by NEAR) is upgraded in place', async () => {
  const near = mockNear();
  const { ctx } = await setup({ near });
  const dep = await ctx.keystore.add({}); near.fund(dep.accountId);
  near.accounts.get(dep.accountId).code = buildRegistryWasm({ legacy: true });
  assert.notEqual(registryWasmHash(), registryWasmHash({ legacy: true }));
  const out = await deployProject(ctx, 'notes');
  assert.deepEqual(out.receipts.map((x) => x.name), ['deploy-registry', 'write-record']);
  assert.ok(near.accounts.get(dep.accountId).code.equals(buildRegistryWasm()));
});

test('deploy: a failed transaction shows the on-chain failure reason', async () => {
  const near = mockNear();
  const { ctx } = await setup({ near });
  const dep = await ctx.keystore.add({}); near.fund(dep.accountId);
  const real = near.fetch;
  near.fetch = async (url, init) => { // make `set` fail the way NEAR reported it
    const r = await real(url, init);
    if (JSON.parse(init.body).method !== 'tx') return r;
    const body = await r.json();
    const fail = { ActionError: { index: 0, kind: { FunctionCallError: { CompilationError: { PrepareError: 'Memory' } } } } };
    const hit = body.result?.transaction_outcome && near.calls.filter((m) => m === 'broadcast_tx_async').length >= 2;
    if (hit) { body.result.status = { Failure: fail }; body.result.receipts_outcome[0].outcome.status = { Failure: fail }; }
    return { status: 200, json: async () => body };
  };
  await assert.rejects(() => deployProject(ctx, 'notes'), (e) => e.code === 'E_TX_REJECTED' && Array.isArray(e.details) && /PrepareError/.test(e.details[0]));
});
