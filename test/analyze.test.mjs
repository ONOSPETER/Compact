import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSource, stripComments } from '../src/analyze/scan.mjs';
import { buildPlan } from '../src/analyze/plan.mjs';

const mk = (obj) => ({ files: Object.keys(obj), read: (f) => obj[f] });

test('parseSource: imports, exports, env, comments with URLs', () => {
  const p = parseSource(`
    import React, { useState as s, type X } from 'react'; // https://example.com/not-a-comment
    import * as ns from './a.js';
    import './side.css';
    import type { T } from './types';
    const { a, b } = require('./cjs');
    export async function login(u) {}
    export const hash = (x) => x;
    export const LIMIT = 5;
    export default async function main() {}
    export { helper as aliased };
    function helper() {}
    /* import fake from 'nope' */
    const k = process.env.JWT_SECRET + import.meta.env.VITE_X;
  `);
  const specs = p.imports.map((i) => i.spec);
  assert.deepEqual(specs.sort(), ['./a.js', './cjs', './side.css', 'react']);
  const react = p.imports.find((i) => i.spec === 'react');
  assert.deepEqual(react.names, ['useState']);
  assert.ok(react.hasDefault);
  const byName = Object.fromEntries(p.exports.map((e) => [e.name, e.kind]));
  assert.deepEqual(byName, { login: 'function', hash: 'function', LIMIT: 'value', default: 'function', aliased: 'function' });
  assert.deepEqual(p.envRefs.sort(), ['JWT_SECRET', 'VITE_X']);
  assert.equal(stripComments("const u = 'http://x.y'; // gone").includes('gone'), false);
});

const EXPRESS_APP = mk({
  'package.json': '{}',
  'index.html': '<script type="module" src="/src/main.jsx"></script>',
  'src/main.jsx': "import React from 'react'; import App from './App.jsx'; document.getElementById('root');",
  'src/App.jsx': "import React from 'react'; export default function App(){ fetch('/api/notes'); return <div/>; }",
  'server/index.js': "import express from 'express'; import { db } from './db.js'; const app = express(); app.listen(process.env.PORT || 4000);",
  'server/db.js': "import Database from 'better-sqlite3'; export const db = new Database('x.db');",
  'server/schema.sql': 'create table t(x);',
  'shared/util.js': "export const slug = (s) => s.toLowerCase();",
  'src/useSlug.js': "import { slug } from '../shared/util.js'; export const a = slug;",
  '.env': 'DB_URL=x\nVITE_API=y',
});

test('plan: express + vite app splits into portal/critical in http mode', () => {
  const plan = buildPlan({ ...EXPRESS_APP, pkg: { scripts: { start: 'node server/index.js' }, dependencies: { express: '^4', react: '^18', 'better-sqlite3': '^9' }, devDependencies: { vite: '^5' } } });
  assert.equal(plan.mode, 'http');
  assert.equal(plan.entry, 'server/index.js');
  assert.equal(plan.port, 4000);
  assert.equal(plan.files['server/index.js'].side, 'critical');
  assert.equal(plan.files['server/db.js'].side, 'critical');
  assert.equal(plan.files['src/App.jsx'].side, 'portal');
  assert.equal(plan.sideOf['server/schema.sql'], 'critical');
  assert.equal(plan.sideOf['.env'], 'env');
  assert.deepEqual(plan.proxyPrefixes, ['/api']);
  assert.deepEqual(Object.keys(plan.deps.critical).sort(), ['better-sqlite3', 'express']);
  assert.deepEqual(plan.deps.portalRemove.sort(), ['better-sqlite3', 'express']);
  assert.equal(plan.errors.length, 0);
  assert.ok(plan.isVite);
});

test('plan: client-only app with marked critical module uses rpc mode and least-privilege allowlist', () => {
  const plan = buildPlan({
    ...mk({
      'src/main.jsx': "import { login } from './lib/auth.js'; import React from 'react'; document.title='x'; login();",
      'src/lib/auth.js': "// @compact-critical\nexport async function login(u){ return sign(u) }\nexport async function logout(){}\nexport const LIMIT = 1;\nimport { sign } from './sign.js';",
      'src/lib/sign.js': "import jose from 'jose'; export const sign = (u) => u;",
    }),
    pkg: { dependencies: { jose: '^5', react: '^18' } },
  });
  assert.equal(plan.mode, 'rpc');
  assert.equal(plan.files['src/lib/auth.js'].side, 'critical');
  assert.equal(plan.files['src/lib/sign.js'].side, 'critical'); // only used by critical
  assert.deepEqual(plan.rpc.allow['src/lib/auth.js'], ['login']); // logout is NOT exposed
  assert.equal(plan.errors.length, 0);
});

test('plan: boundary violations are errors; conflicts are reported, not guessed', () => {
  const plan = buildPlan({
    ...mk({
      'src/main.jsx': "// @compact-portal\nimport { LIMIT } from './lib/auth.js'; document.title = process.env.API_SECRET;",
      'src/lib/auth.js': "// @compact-critical\nexport const LIMIT = 1;",
      'src/both.js': "import fs from 'fs'; document.body;",
    }),
    pkg: {},
  });
  const codes = plan.errors.map((e) => e.code).sort();
  assert.ok(codes.includes('E_NON_FUNCTION_EXPORT'));
  assert.ok(codes.includes('E_CONFLICT'));
  assert.ok(codes.includes('E_SECRET_IN_PORTAL'));
});

test('plan: nothing critical is an explicit error with a hint', () => {
  const plan = buildPlan({ ...mk({ 'src/main.jsx': "import React from 'react'; document.title='x';" }), pkg: {} });
  assert.equal(plan.mode, 'none');
  assert.equal(plan.errors[0].code, 'E_NOTHING_CRITICAL');
  assert.match(plan.errors[0].hint, /@compact-critical/);
});

test('plan: config globs override signals', () => {
  const plan = buildPlan({ ...mk({ 'src/a.js': 'export const f = () => 1;', 'src/b.js': "import { f } from './a.js'; document.x;" }), pkg: {}, config: { critical: ['src/a.js'] } });
  assert.equal(plan.files['src/a.js'].side, 'critical');
  assert.equal(plan.mode, 'rpc');
});
