import { readJson, writeJson, withLock } from '../util/fs.mjs';
import { DEFAULT_TESTNET_RPCS } from '../near/rpc.mjs';

export const DEFAULT_CONFIG = Object.freeze({
  schema: 1,
  network: 'testnet', // v1 is testnet-only on purpose
  rpcUrls: DEFAULT_TESTNET_RPCS,
  explorer: 'https://testnet.nearblocks.io',
  setupComplete: false,
  github: { visibility: 'private' },
});

export class ConfigStore {
  constructor(paths) { this.file = paths.config; this.lock = `${paths.config}.lock`; }

  /** File values + environment overrides. Overrides are never written back to disk. */
  async load(env = process.env) {
    const { value, recovered, backup } = await readJson(this.file, {});
    const merged = { ...DEFAULT_CONFIG, ...value, github: { ...DEFAULT_CONFIG.github, ...(value.github || {}) } };
    if (env.COMPACT_RPC_URLS) merged.rpcUrls = env.COMPACT_RPC_URLS.split(',').map((s) => s.trim()).filter(Boolean);
    return Object.assign(merged, { _recovered: recovered ? backup : undefined });
  }

  async save(patch) {
    return withLock(this.lock, async () => {
      const { value } = await readJson(this.file, {});
      const next = { ...value, ...patch, github: { ...(value.github || {}), ...(patch.github || {}) }, schema: 1 };
      await writeJson(this.file, next, { mode: 0o600 });
      return next;
    });
  }
}
