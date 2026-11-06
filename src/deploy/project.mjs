import fsp from 'node:fs/promises';
import path from 'node:path';
import { CompactError, EXIT } from '../errors.mjs';
import { walk, hashFiles, treeHash, readJson, writeJson, atomicWrite, exists } from '../util/fs.mjs';
import * as core from '../../templates/runtime/core.mjs';
import { loadPQ } from '../transform/transform.mjs';

export const dirs = (app) => ({
  root: app.outDir, portal: path.join(app.outDir, 'portal'), critical: path.join(app.outDir, 'critical'), compact: path.join(app.outDir, 'compact'),
  connectFile: path.join(app.outDir, 'portal/src/compact/connect.json'),
});

export async function loadApp(ctx, ref) {
  const app = await ctx.state.resolve(ref, ctx.cwd);
  if (!(await exists(path.join(app.outDir, 'compact/manifest.json')))) {
    throw new CompactError('E_PROJECT_MISSING', `The project folder for "${app.name}" is missing or incomplete (${app.outDir}).`, {
      hint: 'Run `compact transform` again, or `compact forget` to drop it from the list.', exitCode: EXIT.ENV,
    });
  }
  return app;
}

export async function readProject(app) {
  const d = dirs(app);
  const manifest = JSON.parse(await fsp.readFile(path.join(d.compact, 'manifest.json'), 'utf8'));
  const { value: connect } = await readJson(d.connectFile, {});
  return { d, manifest, connect };
}

export const runnerKeyHash = async (manifest) => core.hex(await core.sha256(core.concat(core.b64.dec(manifest.runner.kemPublic), core.b64.dec(manifest.runner.dsaPublic))));

/**
 * If critical/ changed since the manifest was built, rebuild the hashes and re-sign.
 * The runner keys stay the same, so already-deployed runners keep working until redeployed.
 */
export async function refreshManifest(ctx, app) {
  const { d, manifest, connect } = await readProject(app);
  const files = await hashFiles(d.critical, await walk(d.critical, { ignoreFile: (r) => /(^|\/)\.env/.test(r) }));
  const tree = treeHash(files);
  if (tree === manifest.critical.treeHash) return { changed: false, manifest, connect };

  const keyFile = path.join(d.compact, 'keys/runner.secret.json');
  const { value: keys, missing } = await readJson(keyFile, null);
  if (missing || !keys) throw new CompactError('E_KEYS_MISSING', 'critical/ changed but the signing key (compact/keys/runner.secret.json) is missing.', { hint: 'Restore the key file, or run `compact transform --force` to start a new project (new keys).' });
  const pq = await loadPQ(ctx);
  const next = { ...manifest, critical: { ...manifest.critical, treeHash: tree, files } };
  const sig = core.b64.enc(pq.dsa.sign(core.b64.dec(keys.dsa.secret), core.utf8.enc(core.canonicalJson(next))));
  const hash = core.hex(await core.manifestHash(next));
  await writeJson(path.join(d.compact, 'manifest.json'), next);
  await atomicWrite(path.join(d.compact, 'manifest.sig'), `${sig}\n`);
  await writeJson(path.join(d.portal, 'src/compact/manifest.json'), next);
  const nextConnect = { ...connect, manifestSha256: hash };
  await writeJson(d.connectFile, nextConnect);
  await ctx.state.upsert(app.id, { manifestSha256: hash });
  return { changed: true, manifest: next, connect: nextConnect };
}
