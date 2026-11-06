import fsp from 'node:fs/promises';
import path from 'node:path';
import { CompactError } from '../errors.mjs';
import { walk } from '../util/fs.mjs';

const SECRET_PATTERNS = [
  ['private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['NEAR secret key', /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b|github_pat_[A-Za-z0-9_]{30,}/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['Compact runner key file', /"secret"\s*:\s*"[A-Za-z0-9+/=]{200,}"/],
];
const isBinary = (buf) => buf.subarray(0, 4000).includes(0);

/** Read every file under dir that should be published (never node_modules, dist or real .env files). */
export async function collectPublishFiles(dir) {
  const rels = await walk(dir, { ignoreFile: (r) => /(^|\/)\.env(\..+)?$/.test(r) && !/\.(example|sample)$/.test(r) });
  const files = [];
  for (const rel of rels) {
    const st = await fsp.stat(path.join(dir, rel));
    files.push({ path: rel, content: await fsp.readFile(path.join(dir, rel)), mode: st.mode & 0o111 ? '100755' : '100644' });
  }
  return files;
}

/** Block the push if anything that looks like a secret would be published. */
export function scanForSecrets(files) {
  const findings = [];
  for (const f of files) {
    if (isBinary(f.content) || f.content.length > 2_000_000) continue;
    const text = f.content.toString('utf8');
    for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) findings.push({ file: f.path, label });
  }
  return findings;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i; (i = next++) < items.length;) results[i] = await fn(items[i], i);
  }));
  return results;
}

/**
 * Publish `files` as the exact contents of a branch (replacing whatever was there).
 * Creates the repository when it does not exist. Safe to re-run: a no-op push creates no commit.
 */
export async function pushFiles(gh, { owner, repo, branch = 'main', files, message, create = true, isPrivate = true, onProgress }) {
  const me = await gh.user();
  owner ||= me.login;
  let info = await gh.getRepo(owner, repo);
  let created = false;
  if (!info) {
    if (!create) throw new CompactError('E_REPO_NOT_FOUND', `Repository ${owner}/${repo} does not exist.`);
    info = await gh.createRepo({ name: repo, isPrivate, org: owner === me.login ? undefined : owner, description: 'Portal published by Compact' });
    created = true;
  }
  branch = created ? info.default_branch ?? branch : branch;

  let head = await gh.getHead(owner, repo, branch);
  if (!head) {
    const fallback = info.default_branch && info.default_branch !== branch ? await gh.getHead(owner, repo, info.default_branch) : null;
    if (fallback) head = fallback; // new branch off the default branch
    else { await gh.initEmptyRepo(owner, repo, branch).catch(() => {}); head = await gh.getHead(owner, repo, branch); } // empty repository
  }

  let done = 0;
  const entries = await mapLimit(files, 4, async (f) => {
    const blob = await gh.createBlob(owner, repo, f.content);
    onProgress?.(++done, files.length);
    return { path: f.path, mode: f.mode, type: 'blob', sha: blob.sha };
  });
  const tree = await gh.createTree(owner, repo, entries);

  if (head) {
    const cur = await gh.getCommit(owner, repo, head);
    if (cur.tree.sha === tree.sha) return { owner, repo, branch, commitSha: head, url: info.html_url, created, unchanged: true };
  }
  const commit = await gh.createCommit(owner, repo, { message, tree: tree.sha, parents: head ? [head] : [] });
  const existing = await gh.getHead(owner, repo, branch);
  if (existing) await gh.updateRef(owner, repo, branch, commit.sha);
  else await gh.createRef(owner, repo, branch, commit.sha);
  return { owner, repo, branch, commitSha: commit.sha, url: info.html_url, created, unchanged: false, private: info.private };
}
