import path from 'node:path';
import fsp from 'node:fs/promises';
import { CompactError, EXIT } from '../errors.mjs';
import { ensureDir, exists, atomicWrite } from '../util/fs.mjs';
import { DEFAULT_IGNORE_DIRS } from '../util/fs.mjs';

const MAX_FILE = 25 * 1024 * 1024;
const MAX_TOTAL = 150 * 1024 * 1024;

/** Accepts https URLs (incl. /tree/<branch>/<subdir>), git@ URLs and owner/repo. */
export function parseGithubRef(input) {
  const s = String(input).trim();
  let m = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/tree\/([^/\s]+)(?:\/(.+?))?)?\/?(?:[#?].*)?$/.exec(s);
  if (!m) m = /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(s);
  if (!m) m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  if (!m) return null;
  return { owner: m[1], repo: m[2], ref: m[3] ?? null, subdir: (m[4] ?? '').replace(/\/$/, '') || null };
}

const ignoredPath = (p) => p.split('/').some((seg) => DEFAULT_IGNORE_DIRS.has(seg));

/**
 * Download a repository snapshot through the Git Data API (no git binary needed).
 * Cached by commit SHA, so a second run is instant and offline-safe.
 */
export async function fetchRepo(ctx, ref, { onProgress } = {}) {
  const gh = await ctx.github({ required: false }) ?? new (await import('./client.mjs')).GitHub({ fetchImpl: ctx.fetch, logger: ctx.logger });
  const repo = await gh.getRepo(ref.owner, ref.repo);
  if (!repo) throw new CompactError('E_REPO_NOT_FOUND', `Repository ${ref.owner}/${ref.repo} was not found.`, { hint: 'For private repositories, run `compact setup` to add a GitHub token.' });
  const branch = ref.ref ?? repo.default_branch;
  const head = await gh.getHead(ref.owner, ref.repo, branch);
  if (!head) throw new CompactError('E_REPO_EMPTY', `Branch "${branch}" has no commits.`);
  const dest = path.join(ctx.paths.cache, `${ref.owner}__${ref.repo}__${head.slice(0, 12)}${ref.subdir ? `__${ref.subdir.replace(/\W+/g, '_')}` : ''}`);
  const marker = path.join(dest, '.compact-complete');
  if (await exists(marker)) return { dir: dest, sha: head, branch, name: ref.repo, cached: true, private: repo.private };

  const commit = await gh.getCommit(ref.owner, ref.repo, head);
  const tree = await gh.getTree(ref.owner, ref.repo, commit.tree.sha);
  if (tree.truncated) throw new CompactError('E_REPO_TOO_BIG', 'The repository is too large to download through the API.', { hint: 'Clone it with git and pass the local folder instead.' });
  const prefix = ref.subdir ? `${ref.subdir}/` : '';
  const blobs = tree.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix) && !ignoredPath(e.path));
  if (!blobs.length) throw new CompactError('E_REPO_EMPTY', ref.subdir ? `No files under "${ref.subdir}".` : 'The repository has no files.');
  const total = blobs.reduce((n, b) => n + (b.size ?? 0), 0);
  if (total > MAX_TOTAL) throw new CompactError('E_REPO_TOO_BIG', `Repository content is ${(total / 1e6).toFixed(0)} MB (limit ${MAX_TOTAL / 1e6} MB).`, { hint: 'Point Compact at a subfolder: github.com/owner/repo/tree/main/app' });

  const staging = `${dest}.part-${process.pid}`;
  await fsp.rm(staging, { recursive: true, force: true });
  await ensureDir(staging);
  let done = 0;
  const queue = [...blobs];
  const skipped = [];
  const worker = async () => {
    for (let b; (b = queue.shift());) {
      if ((b.size ?? 0) > MAX_FILE) { skipped.push(b.path); continue; }
      const blob = await gh.getBlob(ref.owner, ref.repo, b.sha);
      const out = path.join(staging, b.path.slice(prefix.length));
      await ensureDir(path.dirname(out));
      await fsp.writeFile(out, Buffer.from(blob.content, 'base64'), { mode: b.mode === '100755' ? 0o755 : 0o644 });
      onProgress?.(++done, blobs.length);
    }
  };
  try {
    await Promise.all(Array.from({ length: 6 }, worker));
    await atomicWrite(path.join(staging, '.compact-complete'), `${head}\n`);
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(staging, dest);
  } catch (e) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw e;
  }
  return { dir: dest, sha: head, branch, name: ref.repo, cached: false, skipped, private: repo.private };
}
