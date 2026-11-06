import { compactHome, homePaths } from './paths.mjs';
import { createLogger, nullLogger } from './util/log.mjs';
import { ConfigStore } from './store/config.mjs';
import { Keystore } from './store/keystore.mjs';
import { StateStore } from './store/state.mjs';
import { Credentials } from './store/credentials.mjs';
import { NearRpc } from './near/rpc.mjs';
import { GitHub } from './github/client.mjs';
import { CompactError, EXIT } from './errors.mjs';
import { silentUI } from './ui/ui.mjs';

/**
 * Everything a command needs, in one object. The CLI builds it from flags/env; a backend
 * (the future web app) builds it with its own `home`, `ui` and `askPassphrase`.
 */
export async function createContext({
  env = process.env, cwd = process.cwd(), home, ui = silentUI(), debug = false, fetchImpl = globalThis.fetch,
  askPassphrase, pq, signal, interactive = false,
} = {}) {
  const paths = homePaths(home ?? compactHome(env));
  const logger = (() => { try { return createLogger(paths.logs, { debug }); } catch { return nullLogger; } })();
  const configStore = new ConfigStore(paths);
  const config = await configStore.load(env);
  if (config._recovered) ui.warn(`Config was unreadable and was moved to ${config._recovered}; defaults are in use.`);
  const keystore = new Keystore(paths);
  const credentials = new Credentials(paths);
  const state = new StateStore(paths);
  let rpc;

  return {
    env, cwd, paths, ui, logger, config, configStore, keystore, credentials, state, fetch: fetchImpl, signal, interactive, pq,
    get rpc() { return (rpc ??= new NearRpc({ urls: config.rpcUrls, fetchImpl, logger })); },
    /** Passphrase for an encrypted deployer key: env var, injected callback, or (CLI) prompt. */
    async passphrase() {
      if (env.COMPACT_PASSPHRASE) return env.COMPACT_PASSPHRASE;
      if (askPassphrase) return askPassphrase();
      return undefined;
    },
    async github({ token, required = true } = {}) {
      const found = await credentials.githubToken(env, token);
      if (!found) {
        if (!required) return null;
        throw new CompactError('E_GITHUB_TOKEN_MISSING', 'No GitHub token available.', {
          hint: 'Run `compact setup`, or set GITHUB_TOKEN (needs repo scope / Contents + Administration write).', exitCode: EXIT.ENV,
        });
      }
      return new GitHub({ token: found.token, fetchImpl, logger });
    },
  };
}
