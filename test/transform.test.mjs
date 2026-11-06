import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createContext } from '../src/context.mjs';
import { transformProject, analyzeProject } from '../src/transform/transform.mjs';
import { splitEnv, patchIndexHtml, stubSource } from '../src/transform/build.mjs';
import { mockPQ } from './helpers.mjs';
import * as core from '../templates/runtime/core.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'compact-tf-'));
function write(dir, files) { for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), c); } }

const EXPRESS = {
  'package.json': JSON.stringify({ name: 'notes', type: 'module', scripts: { dev: 'vite', start: 'node server/index.js', build: 'vite build' }, dependencies: { express: '^4', react: '^18', 'better-sqlite3': '^9' }, devDependencies: { vite: '^5' } }),
  'index.html': '<html><head></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>',
  'src/main.jsx': "import React from 'react'; document.getElementById('root'); fetch('/api/notes');",
  'server/index.js': "import express from 'express'; import { db } from './db.js'; express().listen(process.env.PORT || 4000);",
  'server/db.js': "import D from 'better-sqlite3'; export const db = new D('x.db');",
  '.env': 'DB_URL=secret\nVITE_PUBLIC=ok\n',
  'package-lock.json': '{}',
};

async function ctxFor(cwd) { return createContext({ home: tmp(), cwd, pq: mockPQ }); }

test('helpers: env split, index.html patch, stub source', () => {
  assert.deepEqual(splitEnv('A=1\n# c\nVITE_B=2\nexport C=3'), { pub: 'VITE_B=2\n', secret: 'A=1\nexport C=3\n' });
  assert.match(patchIndexHtml('<head></head><script type="module" src="/a.js"></script>'), /install\.mjs"><\/script>\n\s+<script type="module" src="\/a\.js"/);
  assert.equal(patchIndexHtml('<p>no head</p>'), null);
  assert.equal(patchIndexHtml(patchIndexHtml('<script type="module" src="a"></script>')).match(/install\.mjs/g).length, 1); // idempotent
  assert.match(stubSource('src/lib/auth.js', 'src/lib/auth.js', ['login', 'default']), /from '\.\/\.\.\/compact\/client\.mjs'|from '\.\.\/compact\/client\.mjs'/);
});

test('transform (http mode): layout, secrets stay out of portal, manifest verifies, state remembered', async () => {
  const src = tmp(); write(src, EXPRESS);
  const ctx = await ctxFor(tmp());
  const r = await transformProject(ctx, src, { out: path.join(tmp(), 'notes-compact'), name: 'notes' });
  const out = r.outDir;
  for (const p of ['portal/index.html', 'portal/src/main.jsx', 'critical/server/index.js', 'critical/server/db.js', 'compact/manifest.json', 'compact/manifest.sig', 'compact/runtime/runner.mjs', 'compact/deploy/Dockerfile', 'compact/keys/runner.secret.json', 'portal/src/compact/install.mjs', 'portal/src/compact/connect.json', 'README.compact.md']) {
    assert.ok(fs.existsSync(path.join(out, p)), `missing ${p}`);
  }
  assert.ok(!fs.existsSync(path.join(out, 'portal/server')), 'server code must not be in portal');
  assert.ok(!fs.existsSync(path.join(out, 'portal/package-lock.json')));
  assert.match(fs.readFileSync(path.join(out, 'portal/index.html'), 'utf8'), /install\.mjs/);
  assert.equal(fs.readFileSync(path.join(out, 'portal/.env'), 'utf8'), 'VITE_PUBLIC=ok\n');
  assert.equal(fs.readFileSync(path.join(out, 'critical/.env'), 'utf8'), 'DB_URL=secret\n');
  const pp = JSON.parse(fs.readFileSync(path.join(out, 'portal/package.json'), 'utf8'));
  assert.ok(!pp.dependencies.express && !pp.dependencies['better-sqlite3'] && pp.dependencies.react && pp.dependencies['@noble/post-quantum']);
  assert.ok(!pp.scripts.start && pp.scripts.dev && pp.scripts.build);
  const cp = JSON.parse(fs.readFileSync(path.join(out, 'critical/package.json'), 'utf8'));
  assert.equal(cp.type, 'module'); assert.equal(cp.scripts.start, 'node server/index.js'); assert.deepEqual(Object.keys(cp.dependencies).sort(), ['better-sqlite3', 'express']);
  // nothing secret anywhere in the portal tree
  for (const f of fs.readdirSync(path.join(out, 'portal'), { recursive: true })) {
    const full = path.join(out, 'portal', f);
    if (fs.statSync(full).isFile()) assert.ok(!/DB_URL|runner\.secret|"secret"/.test(fs.readFileSync(full, 'utf8')), `secret leaked into ${f}`);
  }
  // signature and connect file are consistent
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'compact/manifest.json'), 'utf8'));
  const sig = fs.readFileSync(path.join(out, 'compact/manifest.sig'), 'utf8').trim();
  assert.ok(mockPQ.dsa.verify(core.b64.dec(manifest.runner.dsaPublic), core.utf8.enc(core.canonicalJson(manifest)), core.b64.dec(sig)));
  const connect = JSON.parse(fs.readFileSync(path.join(out, 'portal/src/compact/connect.json'), 'utf8'));
  assert.equal(connect.manifestSha256, core.hex(await core.manifestHash(manifest)));
  assert.equal(manifest.mode, 'http'); assert.deepEqual(manifest.critical.http.prefixes, ['/api']);
  assert.equal((fs.statSync(path.join(out, 'compact/keys/runner.secret.json')).mode & 0o777), 0o600);
  assert.equal((await ctx.state.resolve('notes')).outDir, out);
  assert.ok(src && fs.existsSync(path.join(src, 'server/index.js')), 'source must be untouched');
});

test('transform (rpc mode): stubs replace critical modules at the same path; only imported functions are exposed', async () => {
  const src = tmp();
  write(src, {
    'package.json': JSON.stringify({ name: 'wallet', dependencies: { react: '^18', jose: '^5' }, devDependencies: { vite: '^5' } }),
    'index.html': '<script type="module" src="/src/main.jsx"></script>',
    'src/main.jsx': "import { login } from './lib/auth.js'; import React from 'react'; document.title = 'x'; login('a');",
    'src/lib/auth.js': "// @compact-critical\nimport { sign } from 'jose';\nexport async function login(u){ return sign(u) }\nexport async function admin(){}\n",
  });
  const ctx = await ctxFor(tmp());
  const r = await transformProject(ctx, src, { out: path.join(tmp(), 'w'), name: 'wallet' });
  const stub = fs.readFileSync(path.join(r.outDir, 'portal/src/lib/auth.js'), 'utf8');
  assert.match(stub, /export const login = \(\.\.\.args\) => compact\.call\("src\/lib\/auth\.js", "login", args\)/);
  assert.ok(!/admin|jose/.test(stub));
  assert.ok(fs.readFileSync(path.join(r.outDir, 'critical/src/lib/auth.js'), 'utf8').includes('export async function admin'));
  assert.deepEqual(r.manifest.critical.rpc.allow, { 'src/lib/auth.js': ['login'] });
  assert.ok(!fs.existsSync(path.join(r.outDir, 'portal/src/compact/install.mjs')));
});

test('transform refuses: invalid plan, existing output without --force; --force replaces atomically', async () => {
  const bad = tmp(); write(bad, { 'package.json': '{}', 'src/a.js': 'export const x = 1;' });
  const ctx = await ctxFor(tmp());
  await assert.rejects(() => transformProject(ctx, bad, { out: path.join(tmp(), 'o') }), (e) => e.code === 'E_PLAN_INVALID' && /@compact-critical/.test(e.hint));
  await assert.rejects(() => analyzeProject(ctx, path.join(tmp(), 'nope')), (e) => e.code === 'E_SOURCE_NOT_FOUND');
  const src = tmp(); write(src, EXPRESS);
  const out = path.join(tmp(), 'o');
  await transformProject(ctx, src, { out });
  await assert.rejects(() => transformProject(ctx, src, { out }), (e) => e.code === 'E_OUT_EXISTS');
  const before = fs.readFileSync(path.join(out, 'compact/keys/runner.secret.json'), 'utf8');
  await transformProject(ctx, src, { out, force: true });
  assert.notEqual(fs.readFileSync(path.join(out, 'compact/keys/runner.secret.json'), 'utf8'), before); // new keys
  assert.deepEqual(fs.readdirSync(path.dirname(out)).filter((f) => f.includes('staging') || f.includes('.old-')), []); // no debris
});
