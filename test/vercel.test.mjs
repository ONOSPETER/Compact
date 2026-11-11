import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createContext } from '../src/context.mjs';
import { transformProject } from '../src/transform/transform.mjs';
import { pushProject, exportProject, assembleVercel } from '../src/deploy/vercel.mjs';
import { commitProject } from '../src/deploy/commit.mjs';
import { CompactClient } from '../templates/runtime/client-core.mjs';
import { VaultClient, randomKey } from '../templates/runtime/vault.mjs';
import { MemStore } from '../templates/runtime/store.mjs';
import * as core from '../templates/runtime/core.mjs';
import { mockPQ, mockNear, mockGithub } from './helpers.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compact-vc-'));
const APP = {
  'package.json': JSON.stringify({ name: 'wallet', dependencies: { react: '^18', jose: '^5' }, devDependencies: { vite: '^5' }, scripts: { dev: 'vite', build: 'vite build' } }),
  'index.html': '<!doctype html><html><head></head><body><script type="module" src="/src/main.jsx"></script></body></html>',
  'src/main.jsx': "import { login } from './lib/auth.js'; import React from 'react'; document.title = 'x'; login('a');",
  'src/lib/auth.js': "// @compact-critical\nexport async function login(u){ return { user: u, via: 'critical' } }\nexport async function admin(){}\n",
  '.env': 'JWT_SECRET=abc123\nVITE_PUBLIC=ok\n',
};
function write(dir, files) { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } }

async function setup() {
  const near = mockNear(); const gh = mockGithub();
  const ctx = await createContext({ home: tmp(), cwd: tmp(), pq: mockPQ, fetchImpl: (u, i) => (String(u).startsWith('http://127.0.0.1') ? fetch(u, i) : String(u).includes('github') ? gh.fetch(u, i) : near.fetch(u, i)) });
  const src = tmp(); write(src, APP);
  const r = await transformProject(ctx, src, { out: path.join(tmp(), 'wallet-compact'), name: 'wallet' });
  await ctx.credentials.saveGithub({ token: 'ghp_test', user: 'ann' });
  return { ctx, r, near, gh };
}
const listFiles = (dir) => fs.readdirSync(dir, { recursive: true }).filter((f) => fs.statSync(path.join(dir, f)).isFile()).map((f) => f.split(path.sep).join('/'));

test('export builds ONE Vercel-ready repo: Vite app at the root, critical + runtime under compact/, one function, no secrets', async () => {
  const { ctx, r } = await setup();
  const out = await exportProject(ctx, 'wallet', { out: path.join(tmp(), 'site') });
  const files = listFiles(out.dest);
  for (const f of ['index.html', 'src/main.jsx', 'src/lib/auth.js', 'src/compact/client.mjs', 'src/compact/vault.mjs', 'src/compact/connect.json', 'api/compact/[...path].mjs', 'vercel.json', 'package.json', '.env.example', 'README.vercel.md', 'compact/manifest.json', 'compact/manifest.sig', 'compact/runtime/serverless.mjs', 'compact/runtime/kv.mjs', 'compact/critical/src/lib/auth.js', 'compact/critical/package.json']) assert.ok(files.includes(f), `missing ${f}`);
  assert.ok(!files.some((f) => /keys|receipts|\.env$|deploy\/|runner\.mjs/.test(f)), 'no keys, receipts, .env, docker files or the stateful runner');
  assert.ok(fs.readFileSync(path.join(out.dest, 'src/lib/auth.js'), 'utf8').includes('compact.call')); // portal has only the stub
  assert.ok(!fs.readFileSync(path.join(out.dest, 'src/lib/auth.js'), 'utf8').includes('via'));
  assert.ok(fs.readFileSync(path.join(out.dest, 'compact/critical/src/lib/auth.js'), 'utf8').includes("via: 'critical'"));
  const pkg = JSON.parse(fs.readFileSync(path.join(out.dest, 'package.json'), 'utf8'));
  assert.ok(pkg.dependencies.react && pkg.dependencies.jose && pkg.dependencies['@noble/post-quantum'] && pkg.scripts.build);
  const vj = JSON.parse(fs.readFileSync(path.join(out.dest, 'vercel.json'), 'utf8'));
  assert.equal(vj.functions['api/compact/**/*.mjs'].includeFiles, 'compact/**');
  const connect = JSON.parse(fs.readFileSync(path.join(out.dest, 'src/compact/connect.json'), 'utf8'));
  assert.equal(connect.layout, 'vercel'); assert.equal(connect.endpoint, 'auto');
  for (const f of files) assert.ok(!/abc123|runner\.secret/.test(fs.readFileSync(path.join(out.dest, f), 'utf8')), `secret leaked into ${f}`);
  assert.deepEqual(out.env.app, ['JWT_SECRET']); assert.match(fs.readFileSync(path.join(out.dest, '.env.example'), 'utf8'), /JWT_SECRET=\n/);
  await assert.rejects(() => exportProject(ctx, 'wallet', { out: out.dest }), (e) => e.code === 'E_OUT_EXISTS');
  void r;
});

async function runFunctionFrom(dest, store, projectDir) {
  const mod = await import(pathToFileURL(path.join(dest, 'compact/runtime/serverless.mjs')).href + `?t=${Math.random()}`);
  const k = JSON.parse(fs.readFileSync(path.join(projectDir, 'compact/keys/runner.secret.json'), 'utf8'));
  const handler = mod.createServerlessHandler({ pq: mockPQ, store, keys: { kemSecret: core.b64.dec(k.kem.secret), dsaSecret: core.b64.dec(k.dsa.secret) } }); // manifest + critical code come from the exported tree
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

test('the exported tree really runs: its function loads the manifest and critical code from the generated layout', async () => {
  const { ctx, r } = await setup();
  const { dest } = await exportProject(ctx, 'wallet', { out: path.join(tmp(), 'site') });
  const fn = await runFunctionFrom(dest, new MemStore(), r.outDir);
  try {
    const health = await (await fetch(`${fn.url}/api/compact/health`)).json();
    assert.equal(health.integrity.ok, true, `integrity: ${JSON.stringify(health.integrity)}`); // critical files match the signed manifest
    const connect = { ...JSON.parse(fs.readFileSync(path.join(dest, 'src/compact/connect.json'), 'utf8')), endpoint: fn.url, verify: 'off' };
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'src/compact/manifest.json'), 'utf8'));
    const client = new CompactClient({ connect, manifest, pq: mockPQ, fetchImpl: (...a) => fetch(...a) });
    assert.deepEqual(await client.call('src/lib/auth.js', 'login', ['ann']), { user: 'ann', via: 'critical' });
    await assert.rejects(() => client.call('src/lib/auth.js', 'admin', []), /not exposed/);
    const v = new VaultClient({ endpoint: `${fn.url}/api/compact`, appId: r.app.id, key: randomKey() });
    await v.put('n', 'secret note'); assert.equal(await v.get('n'), 'secret note');
  } finally { await fn.close(); }
});

test('push: ONE private repo with the whole app, idempotent; secrets block it; dry-run lists the tree; local layout is remembered', async () => {
  const { ctx, r } = await setup();
  const dry = await pushProject(ctx, 'wallet', { dryRun: true });
  assert.ok(dry.files.includes('api/compact/[...path].mjs') && dry.files.includes('compact/critical/src/lib/auth.js') && !dry.files.some((f) => f.includes('keys')));
  const a = await pushProject(ctx, 'wallet');
  assert.equal(a.repo, 'wallet'); assert.equal(a.private, true); assert.equal(a.layout, 'vercel'); assert.equal(a.created, true);
  assert.deepEqual(a.env.required, ['COMPACT_KEYS_B64']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r.outDir, 'portal/src/compact/connect.json'), 'utf8')).layout, 'vercel');
  const b = await pushProject(ctx, 'wallet');
  assert.equal(b.unchanged, true); assert.equal(b.commitSha, a.commitSha);
  fs.writeFileSync(path.join(r.outDir, 'critical/src/leak.js'), 'const k = "ed25519:' + '1'.repeat(88) + '";');
  await assert.rejects(() => pushProject(ctx, 'wallet'), (e) => e.code === 'E_SECRETS_IN_REPO' && /leak\.js/.test(e.details[0]));
  fs.rmSync(path.join(r.outDir, 'critical/src/leak.js'));
  assert.equal((await ctx.state.get(r.app.id)).github.layout, 'vercel');
});

test('vault + commit work against the Vercel layout (/api/compact): anchored root verifies, rollback is caught', async () => {
  const { ctx, r, near } = await setup();
  const { dest } = await exportProject(ctx, 'wallet', { out: path.join(tmp(), 'site') });
  const store = new MemStore();
  const fn = await runFunctionFrom(dest, store, r.outDir);
  try {
    const dep = await ctx.keystore.add({}); near.fund(dep.accountId);
    const cf = path.join(r.outDir, 'portal/src/compact/connect.json');
    fs.writeFileSync(cf, JSON.stringify({ ...JSON.parse(fs.readFileSync(cf, 'utf8')), layout: 'vercel', endpoint: fn.url, near: { network: 'testnet', rpcUrls: ['https://rpc.test'], registryAccount: dep.accountId } }));
    const base = `${fn.url}/api/compact`;
    const nearCfg = { rpcUrls: ['https://rpc.test'], registryAccount: dep.accountId };
    const router = (u, i) => (String(u).startsWith('http://127.0.0.1') ? fetch(u, i) : near.fetch(u, i));
    const v = new VaultClient({ endpoint: base, appId: r.app.id, key: randomKey(), fetchImpl: router, near: nearCfg });
    await v.put('one', '1'); const h1 = await v.head();
    await new VaultClient({ endpoint: base, appId: r.app.id, key: randomKey() }).put('z', 'z');
    for (let i = 0; i < 4; i++) await v.put(`k${i}`, 'x');
    const done = await commitProject(ctx, 'wallet', { force: true });
    assert.equal(done.skipped, false); assert.equal(near.txs.size, 2);
    assert.equal((await v.verify()).status, 'ok');
    store.heads.set(await v.kid(), { n: h1.n, id: h1.id });
    assert.equal((await v.verify()).status, 'rollback');
  } finally { await fn.close(); }
});

test('assembleVercel is deterministic', async () => {
  const { r } = await setup();
  const app = { id: r.app.id, name: 'wallet', outDir: r.outDir };
  const a = (await assembleVercel(app)).files.map((f) => `${f.path}:${f.content.length}`).sort();
  const b = (await assembleVercel(app)).files.map((f) => `${f.path}:${f.content.length}`).sort();
  assert.deepEqual(a, b);
});
