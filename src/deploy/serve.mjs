import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CompactError, EXIT } from '../errors.mjs';
import { loadApp, dirs } from './project.mjs';

function npmInstall(cwd, ui) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('error', (e) => reject(new CompactError('E_NPM', 'Could not run npm.', { cause: e, hint: 'Install Node.js/npm, or install dependencies manually.', exitCode: EXIT.ENV })));
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new CompactError('E_NPM_INSTALL', `npm install failed in ${cwd}.`, { exitCode: EXIT.ENV }))));
  });
}

/** Run the runner locally (development). Blocks until it exits. */
export async function serveProject(ctx, ref, { port = 8787, install = true, origins } = {}) {
  const app = await loadApp(ctx, ref);
  const d = dirs(app);
  const need = [[path.join(d.compact, 'runtime'), '@noble'], [d.critical, null]];
  for (const [dir, probe] of need) {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const hasDeps = Object.keys(pkg.dependencies ?? {}).length > 0;
    const installed = fs.existsSync(path.join(dir, 'node_modules')) && (!probe || fs.existsSync(path.join(dir, 'node_modules', probe)));
    if (hasDeps && !installed) {
      if (!install) throw new CompactError('E_DEPS_MISSING', `Dependencies are not installed in ${dir}.`, { hint: 'Run npm install there, or drop --no-install.' });
      await ctx.ui.task(`Installing dependencies in ${path.relative(d.root, dir) || '.'}`, () => npmInstall(dir, ctx.ui));
    }
  }
  ctx.ui.success(`Runner starting on http://localhost:${port}  (Ctrl+C to stop)`);
  const child = spawn(process.execPath, [path.join(d.compact, 'runtime/runner.mjs')], {
    cwd: d.root, stdio: 'inherit',
    env: { ...process.env, PORT: String(port), COMPACT_DIR: d.compact, COMPACT_CRITICAL_DIR: d.critical, ...(origins ? { COMPACT_ALLOWED_ORIGINS: origins } : {}) },
  });
  const forward = (sig) => () => child.kill(sig);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  return new Promise((resolve) => child.on('exit', (code) => resolve({ exitCode: code ?? 0 })));
}
