import fs from 'node:fs';
import path from 'node:path';
import { CompactError, EXIT } from '../../errors.mjs';
import { loadApp, readProject, apiBase } from '../../deploy/project.mjs';
import { VaultClient, randomKey } from '../../../templates/runtime/vault.mjs';
import { hex } from '../../../templates/runtime/core.mjs';

const unhex = (h) => Uint8Array.from(h.match(/../g), (b) => parseInt(b, 16));

export default {
  name: 'vault',
  summary: 'End-to-end encrypted storage: init, put, get, list, rm, verify',
  usage: 'compact vault <init|put|get|list|rm|verify> [name] [value] [options]',
  options: {
    endpoint: { type: 'string', description: 'Runner URL (default: from the portal connect.json)' },
    'key-file': { type: 'string', description: 'Vault key file (default: ~/.compact/vault-keys/<app>.key)' },
    app: { type: 'string', description: 'App name or folder' },
    file: { type: 'string', description: 'put: store the contents of a file' },
    out: { type: 'string', description: 'get: write the value to a file' },
    json: { type: 'boolean', description: 'put: parse the value as JSON' },
  },
  examples: ['compact vault init', 'compact vault put notes/1 "hello"', 'compact vault get notes/1', 'compact vault verify'],
  async run({ ctx, ui, values, positionals }) {
    const [sub, name, value] = positionals;
    if (!sub) throw new CompactError('E_USAGE', 'Which action? compact vault <init|put|get|list|rm|verify>', { exitCode: EXIT.USAGE });
    const app = await loadApp(ctx, values.app);
    const { connect } = await readProject(app);
    const keyFile = values['key-file'] ?? path.join(ctx.paths.home, 'vault-keys', `${app.id}.key`);

    if (sub === 'init') {
      if (fs.existsSync(keyFile)) throw new CompactError('E_KEY_EXISTS', `A vault key already exists at ${keyFile}.`, { hint: 'Delete it only if you are sure: its data becomes unreadable without it.', exitCode: EXIT.USAGE });
      fs.mkdirSync(path.dirname(keyFile), { recursive: true, mode: 0o700 });
      fs.writeFileSync(keyFile, `${hex(randomKey())}\n`, { mode: 0o600 });
      ui.success('Vault key created');
      ui.box('BACK THIS UP', [keyFile, 'A random 256-bit key. Without it your data cannot be decrypted;', 'with it, anyone can read your data.'], { tone: 'yellow' });
      return { ok: true, keyFile };
    }

    if (!fs.existsSync(keyFile)) throw new CompactError('E_NO_VAULT_KEY', 'No vault key yet.', { hint: 'Run: compact vault init', exitCode: EXIT.ENV });
    const key = unhex(fs.readFileSync(keyFile, 'utf8').trim());
    const vault = new VaultClient({
      endpoint: apiBase(connect, values.endpoint), appId: app.id, key, fetchImpl: ctx.fetch,
      near: connect.near?.registryAccount ? { rpcUrls: ctx.config.rpcUrls, registryAccount: connect.near.registryAccount } : undefined,
    });
    const need = (what) => { if (!what) throw new CompactError('E_USAGE', 'Missing argument.', { hint: `compact vault ${sub} <name>${sub === 'put' ? ' <value>' : ''}`, exitCode: EXIT.USAGE }); };

    if (sub === 'put') {
      need(name);
      let data = value;
      if (values.file) data = new Uint8Array(fs.readFileSync(values.file));
      else if (values.json) data = JSON.parse(value);
      else need(value);
      const r = await ui.task(`Encrypting and storing ${name}`, () => vault.put(name, data));
      return { ok: true, ...r };
    }
    if (sub === 'get') {
      need(name);
      const v = await vault.get(name);
      if (v === undefined) throw new CompactError('E_NOT_FOUND', `No entry named "${name}".`, { hint: 'List entries with: compact vault list' });
      if (values.out) { fs.writeFileSync(values.out, v instanceof Uint8Array ? v : JSON.stringify(v)); ui.success(`Wrote ${values.out}`); }
      else if (!ctx.ui.json_) process.stdout.write(`${typeof v === 'string' ? v : v instanceof Uint8Array ? `<${v.length} bytes, use --out>` : JSON.stringify(v)}\n`);
      return { ok: true, value: v instanceof Uint8Array ? undefined : v, silent: !ctx.ui.json_ };
    }
    if (sub === 'list') {
      const names = await vault.list();
      ui.heading(`Vault (${names.length})`);
      names.forEach((n) => ui.line(`  ${n}`));
      return { ok: true, names };
    }
    if (sub === 'rm') {
      need(name);
      const removed = await vault.remove(name);
      removed ? ui.success(`Removed ${name}`) : ui.warn(`No entry named "${name}"`);
      return { ok: true, removed };
    }
    if (sub === 'verify') {
      const v = await ui.task('Checking the host against the on-chain anchor', () => vault.verify());
      const bad = ['rollback', 'proof-invalid'].includes(v.status);
      ui.heading('Verification');
      ui.kv([['Status', bad ? ui.c.red(v.status) : v.status === 'ok' ? ui.c.green('ok') : ui.c.yellow(v.status)], ['Your version', v.version], ['Anchored version', v.anchoredVersion], ['Anchor', v.anchor ? `${v.anchor.root.slice(0, 16)}… (${v.anchor.count} vaults, ${v.anchor.ts})` : undefined], ['Note', v.note]]);
      return { ok: !bad, ...v, exitCode: bad ? 1 : 0 };
    }
    throw new CompactError('E_USAGE', `Unknown action "${sub}".`, { hint: 'Use: init, put, get, list, rm, verify', exitCode: EXIT.USAGE });
  },
};
