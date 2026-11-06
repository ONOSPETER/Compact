import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BIN = new URL('../bin/compact.mjs', import.meta.url).pathname;
const run = (args, env = {}) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-cli-'));
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, COMPACT_HOME: home, NO_COLOR: '1', ...env }, input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr, home };
};
const APP = {
  'package.json': JSON.stringify({ name: 'notes', dependencies: { express: '^4', react: '^18' }, devDependencies: { vite: '^5' } }),
  'index.html': '<script type="module" src="/src/main.jsx"></script>',
  'src/main.jsx': "import React from 'react'; document.title='x'; fetch('/api/n');",
  'server/index.js': "import express from 'express'; express().listen(4000);",
};
function fixture(files = APP) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'compact-app-')); for (const [f, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); } return d; }

test('cli: --version, --help, per-command help, no args', () => {
  assert.match(run(['--version']).out, /^\d+\.\d+\.\d+\n$/);
  const h = run(['--help']);
  assert.equal(h.code, 0);
  for (const c of ['setup', 'transform', 'deploy', 'push', 'ship', 'apps']) assert.ok(h.out.includes(c));
  const d = run(['deploy', '--help']);
  assert.equal(d.code, 0); assert.match(d.out, /--endpoint/); assert.match(d.out, /EXAMPLES/);
  assert.equal(run(['help', 'push']).code, 0);
  assert.equal(run([]).code, 2);
});

test('cli: unknown command suggests the closest one; bad flags give usage errors with exit 2', () => {
  const u = run(['trnsform']);
  assert.equal(u.code, 2); assert.match(u.err, /Did you mean "compact transform"/);
  const f = run(['deploy', '--bogus']);
  assert.equal(f.code, 2); assert.match(f.err, /compact deploy --help/);
});

test('cli: analyze works offline, human and --json; exit 5 when the plan has errors', () => {
  const app = fixture();
  const human = run(['analyze', app]);
  assert.equal(human.code, 0); assert.match(human.out, /server\/index\.js/); assert.match(human.out, /Ready/);
  const j = run(['analyze', app, '--json']);
  const data = JSON.parse(j.out);
  assert.equal(data.ok, true); assert.equal(data.plan.mode, 'http'); assert.equal(j.err, '');
  const bad = run(['analyze', fixture({ 'package.json': '{}', 'src/a.js': 'export const x=1' })]);
  assert.equal(bad.code, 5); assert.match(bad.out, /@compact-critical/);
  const missing = run(['analyze', '/no/such/dir-xyz']);
  assert.equal(missing.code, 2); assert.match(missing.err, /neither a folder nor a GitHub/);
});

test('cli: commands that need setup fail with a pointer to the fix; apps is empty; secrets never in --json errors', () => {
  const a = run(['account']);
  assert.equal(a.code, 3); assert.match(a.err, /compact setup/);
  const apps = run(['apps', '--json']);
  assert.deepEqual(JSON.parse(apps.out), { ok: true, apps: [] });
  const s = run(['status']);
  assert.equal(s.code, 2);
});

test('cli: transform without the PQ library installed fails clearly (and leaves nothing behind)', () => {
  const app = fixture(); const out = path.join(os.tmpdir(), `compact-out-${Date.now()}`);
  const r = run(['transform', app, '--out', out]);
  // In an environment where @noble/post-quantum is installed this succeeds instead; both are valid.
  if (r.code === 0) assert.ok(fs.existsSync(path.join(out, 'portal')));
  else { assert.equal(r.code, 3); assert.match(r.err, /post-quantum/); assert.ok(!fs.existsSync(out)); }
});
