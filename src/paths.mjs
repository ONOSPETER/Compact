import os from 'node:os';
import path from 'node:path';

/** Where Compact keeps its global state. Override with COMPACT_HOME. */
export function compactHome(env = process.env) {
  return env.COMPACT_HOME ? path.resolve(env.COMPACT_HOME) : path.join(os.homedir(), '.compact');
}

export function homePaths(home) {
  return {
    home,
    config: path.join(home, 'config.json'),
    keystore: path.join(home, 'keystore.json'),
    credentials: path.join(home, 'credentials.json'),
    state: path.join(home, 'state.json'),
    stateLock: path.join(home, 'state.lock'),
    logs: path.join(home, 'logs'),
    cache: path.join(home, 'cache'),
  };
}
