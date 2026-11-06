import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CompactError } from '../errors.mjs';

export const toPosix = (p) => p.split(path.sep).join('/');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', '.vercel', '.turbo', '.cache', 'coverage', '.svelte-kit', '.nuxt',
]);

export async function ensureDir(dir, mode = 0o755) {
  await fsp.mkdir(dir, { recursive: true, mode });
}

/** Write to a temp file, fsync, then rename. A crash never leaves a half-written file. */
export async function atomicWrite(file, data, { mode = 0o644 } = {}) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fsp.open(tmp, 'w', mode);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

/** Read JSON. Missing file -> fallback. Corrupt file -> moved aside, fallback returned. */
export async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { value: fallback, missing: true, recovered: false };
    throw e;
  }
  try {
    return { value: JSON.parse(raw), missing: false, recovered: false };
  } catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    await fsp.rename(file, backup).catch(() => {});
    return { value: fallback, missing: false, recovered: true, backup };
  }
}

export const writeJson = (file, value, opts) => atomicWrite(file, JSON.stringify(value, null, 2) + '\n', opts);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** Cross-process mutex using an exclusive lock file. Recovers from dead holders. */
export async function withLock(lockFile, fn, { timeoutMs = 10_000, staleMs = 60_000 } = {}) {
  await ensureDir(path.dirname(lockFile));
  const start = Date.now();
  for (;;) {
    try {
      const fd = await fsp.open(lockFile, 'wx');
      await fd.writeFile(String(process.pid));
      await fd.close();
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = await fsp.stat(lockFile);
        const pid = Number(await fsp.readFile(lockFile, 'utf8').catch(() => '0'));
        if (Date.now() - st.mtimeMs > staleMs || (pid && !isAlive(pid))) {
          await fsp.rm(lockFile, { force: true });
          continue;
        }
      } catch { /* lock vanished: retry */ }
      if (Date.now() - start > timeoutMs) {
        throw new CompactError('E_LOCK_TIMEOUT', 'Another Compact process is holding the state lock.', {
          hint: `If no other compact command is running, delete ${lockFile}.`,
        });
      }
      await sleep(60 + Math.random() * 60);
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lockFile, { force: true });
  }
}

/** List files under root (relative posix paths). Symlinks are never followed. */
export async function walk(root, { ignoreDirs = DEFAULT_IGNORE_DIRS, ignoreFile = () => false, maxFiles = 20_000 } = {}) {
  const out = [];
  async function rec(dir) {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of ents) {
      const full = path.join(dir, e.name);
      const rel = toPosix(path.relative(root, full));
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (ignoreDirs.has(e.name)) continue;
        await rec(full);
      } else if (e.isFile()) {
        if (ignoreFile(rel)) continue;
        out.push(rel);
        if (out.length > maxFiles) {
          throw new CompactError('E_TOO_MANY_FILES', `More than ${maxFiles} files under ${root}.`, {
            hint: 'Point Compact at the app root, not a monorepo parent.',
          });
        }
      }
    }
  }
  await rec(root);
  return out;
}

export const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Deterministic hash of a set of {path, sha256}: independent of order and of timestamps. */
export function treeHash(entries) {
  const lines = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1)).map((e) => `${e.path}\0${e.sha256}\n`);
  return sha256Hex(Buffer.from(lines.join('')));
}

export async function hashFiles(root, relPaths) {
  const out = [];
  for (const rel of relPaths) {
    const buf = await fsp.readFile(path.join(root, rel));
    out.push({ path: rel, sha256: sha256Hex(buf), size: buf.length });
  }
  return out;
}

export async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isEmptyDir(p) {
  try {
    return (await fsp.readdir(p)).length === 0;
  } catch (e) {
    if (e.code === 'ENOENT') return true;
    throw e;
  }
}

/** Replace `dest` atomically with the freshly built `staging` directory. */
export async function swapDir(staging, dest) {
  const old = `${dest}.old-${Date.now()}`;
  const had = await exists(dest);
  if (had) await fsp.rename(dest, old);
  try {
    await fsp.rename(staging, dest);
  } catch (e) {
    if (had) await fsp.rename(old, dest).catch(() => {});
    throw e;
  }
  if (had) await fsp.rm(old, { recursive: true, force: true });
}
