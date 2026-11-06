import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJson, withLock } from '../util/fs.mjs';
import { CompactError, EXIT } from '../errors.mjs';

const EMPTY = () => ({ schema: 1, apps: {} });

export function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'app';
}

/** Stable app id from a name and where it came from. */
export function makeAppId(name, sourceKey) {
  return `${slugify(name)}-${crypto.createHash('sha256').update(String(sourceKey)).digest('hex').slice(0, 6)}`;
}

/**
 * Remembers every app Compact has transformed/deployed. Contains no secrets:
 * only paths, hashes, receipts and URLs. All writes are atomic and locked.
 */
export class StateStore {
  constructor(paths) { this.file = paths.state; this.lock = paths.stateLock; }

  async #load() {
    const { value, recovered, backup } = await readJson(this.file, EMPTY());
    if (recovered) throw new CompactError('E_STATE_CORRUPT', `State file was unreadable; moved to ${backup}.`, {
      hint: 'Your projects are untouched. Re-run `compact transform` or `compact apps --rescan` to re-register them.', exitCode: EXIT.ENV,
    });
    if (!value.apps) value.apps = {};
    return value;
  }

  async list() { return Object.values((await this.#load()).apps).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)); }

  async get(id) { return (await this.#load()).apps[id] ?? null; }

  /** Resolve by id, name, output directory, or (if ref omitted) the app containing `cwd`. */
  async resolve(ref, cwd = process.cwd()) {
    const apps = await this.list();
    if (ref) {
      const abs = path.resolve(cwd, ref);
      const hit = apps.find((a) => a.id === ref || a.name === ref || a.outDir === abs);
      if (hit) return hit;
      throw new CompactError('E_UNKNOWN_APP', `No remembered app matches "${ref}".`, { hint: 'List them with: compact apps', exitCode: EXIT.USAGE });
    }
    const inside = apps.filter((a) => cwd === a.outDir || cwd.startsWith(a.outDir + path.sep)).sort((a, b) => b.outDir.length - a.outDir.length)[0];
    if (inside) return inside;
    if (apps.length === 1) return apps[0];
    throw new CompactError('E_APP_REQUIRED', 'Which app? Run this inside an app folder or pass its name.', {
      hint: apps.length ? 'See: compact apps' : 'Create one with: compact transform <path-or-github-url>', exitCode: EXIT.USAGE,
    });
  }

  /** Read-modify-write under a lock. `patch` is an object (shallow merge) or a function(app) -> app. */
  async upsert(id, patch) {
    return withLock(this.lock, async () => {
      const st = await this.#load();
      const prev = st.apps[id] ?? { id, createdAt: new Date().toISOString(), deployments: [], pushes: [] };
      const next = typeof patch === 'function' ? patch(structuredClone(prev)) : { ...prev, ...patch };
      next.id = id;
      next.updatedAt = new Date().toISOString();
      st.apps[id] = next;
      await writeJson(this.file, st, { mode: 0o600 });
      return next;
    });
  }

  async remove(id) {
    return withLock(this.lock, async () => {
      const st = await this.#load();
      const existed = !!st.apps[id];
      delete st.apps[id];
      await writeJson(this.file, st, { mode: 0o600 });
      return existed;
    });
  }
}
