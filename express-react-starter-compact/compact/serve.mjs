#!/usr/bin/env node
// Convenience wrapper: `node compact/serve.mjs [flags]` runs `compact serve` for this project.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('compact', ['serve', root, ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.error) { console.error('Could not run "compact". Install it first: npm i -g @compact/cli'); process.exit(1); }
process.exit(r.status ?? 1);
