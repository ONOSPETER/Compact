import fsp from 'node:fs/promises';
import path from 'node:path';
import { RUNNER_RUNTIME, portalRuntimeFiles, readTemplate } from '../transform/build.mjs';
import { ensureDir } from '../util/fs.mjs';
import { loadApp, readProject, dirs } from './project.mjs';

async function sync(dest, name, content) {
  const file = path.join(dest, name);
  const before = await fsp.readFile(file, 'utf8').catch(() => null);
  if (before === content) return false;
  await ensureDir(dest);
  await fsp.writeFile(file, content);
  return true;
}

/**
 * Refresh the generated runtime files of an existing project (runner, crypto, vault client)
 * without touching your code, keys, manifest, receipts or anything under critical/.
 */
export async function upgradeProject(ctx, ref) {
  const app = await loadApp(ctx, ref);
  const d = dirs(app);
  const { manifest } = await readProject(app);
  const changed = [];
  for (const t of RUNNER_RUNTIME) if (await sync(path.join(d.compact, 'runtime'), t, await readTemplate(t))) changed.push(`compact/runtime/${t}`);
  for (const t of portalRuntimeFiles(manifest.mode)) if (await sync(path.join(d.portal, 'src/compact'), t, await readTemplate(t))) changed.push(`portal/src/compact/${t}`);
  const gi = path.join(d.root, '.gitignore');
  const text = await fsp.readFile(gi, 'utf8').catch(() => '');
  if (!text.includes('compact/data/')) { await fsp.writeFile(gi, `${text.trimEnd()}\ncompact/data/\n`); changed.push('.gitignore'); }
  return { app, changed };
}
