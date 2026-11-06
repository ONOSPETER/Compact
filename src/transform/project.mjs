import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CompactError, EXIT } from '../errors.mjs';
import { walk, readJson } from '../util/fs.mjs';
import { buildPlan } from '../analyze/plan.mjs';
import { parseGithubRef, fetchRepo } from '../github/repo.mjs';

export async function loadProjectConfig(dir, overrides = {}) {
  const { value } = await readJson(path.join(dir, 'compact.config.json'), {});
  const clean = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined && !(Array.isArray(v) && v.length === 0)));
  return { ...value, ...clean };
}

/** Turn "path or GitHub URL" into a local directory (downloading and caching if needed). */
export async function resolveSource(ctx, input, { onProgress } = {}) {
  const local = path.resolve(ctx.cwd, input);
  if (fs.existsSync(local)) {
    if (!fs.statSync(local).isDirectory()) throw new CompactError('E_SOURCE_NOT_DIR', `${input} is not a directory.`, { exitCode: EXIT.USAGE });
    return { dir: local, name: path.basename(local), source: { type: 'local', path: local } };
  }
  const ref = parseGithubRef(input);
  if (!ref) {
    throw new CompactError('E_SOURCE_NOT_FOUND', `"${input}" is neither a folder nor a GitHub repository.`, {
      hint: 'Use a path (./my-app) or a URL like https://github.com/owner/repo', exitCode: EXIT.USAGE,
    });
  }
  const r = await fetchRepo(ctx, ref, { onProgress });
  return {
    dir: r.dir, name: ref.subdir ? path.basename(ref.subdir) : ref.repo,
    source: { type: 'github', owner: ref.owner, repo: ref.repo, branch: r.branch, sha: r.sha, subdir: ref.subdir, url: `https://github.com/${ref.owner}/${ref.repo}` },
    skipped: r.skipped,
  };
}

/** Read a project and produce its split plan. Never writes to the project. */
export async function analyzeDirectory(dir, config = {}) {
  let pkg = null;
  try { pkg = JSON.parse(await fsp.readFile(path.join(dir, 'package.json'), 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') throw new CompactError('E_BAD_PACKAGE_JSON', 'package.json is not valid JSON.', { cause: e });
  }
  if (!pkg) throw new CompactError('E_NO_PACKAGE_JSON', 'No package.json found: is this the app root?', { hint: 'Point Compact at the folder that contains package.json.', exitCode: EXIT.USAGE });
  const files = await walk(dir, { ignoreFile: (r) => r === '.compact-complete' || r === 'compact.config.json' });
  const plan = buildPlan({ files, read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'), pkg, config });
  if (!plan.isVite) plan.warnings.push({ level: 'warning', code: 'W_NOT_VITE', file: null, message: 'This does not look like a Vite app.', hint: 'The portal will still be generated, but its build setup is yours to check.' });
  return { plan, pkg, files, dir };
}
