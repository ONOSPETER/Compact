import { readJson, writeJson, withLock } from '../util/fs.mjs';

/** GitHub token resolution: explicit flag > environment > ~/.compact/credentials.json (0600). */
export class Credentials {
  constructor(paths) { this.file = paths.credentials; this.lock = `${paths.credentials}.lock`; }

  async githubToken(env = process.env, explicit) {
    if (explicit) return { token: explicit, source: 'flag' };
    for (const k of ['COMPACT_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) if (env[k]) return { token: env[k], source: `env:${k}` };
    const { value } = await readJson(this.file, {});
    return value.github?.token ? { token: value.github.token, source: 'file', user: value.github.user } : null;
  }

  async saveGithub({ token, user }) {
    return withLock(this.lock, async () => {
      const { value } = await readJson(this.file, {});
      await writeJson(this.file, { ...value, github: { token, user, savedAt: new Date().toISOString() } }, { mode: 0o600 });
    });
  }

  async clearGithub() {
    return withLock(this.lock, async () => {
      const { value } = await readJson(this.file, {});
      delete value.github;
      await writeJson(this.file, value, { mode: 0o600 });
    });
  }
}
