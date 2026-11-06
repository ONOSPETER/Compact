import fs from 'node:fs';
import path from 'node:path';
import { CompactError, EXIT } from '../../errors.mjs';
import { confirm } from '../../ui/prompt.mjs';
import { loadApp, readProject, runnerKeyHash, dirs } from '../../deploy/project.mjs';
import { printReceipts } from '../render.mjs';

export const appsCmd = {
  name: 'apps',
  aliases: ['ls'],
  summary: 'List the apps Compact remembers',
  usage: 'compact apps',
  options: {},
  examples: ['compact apps', 'compact apps --json'],
  async run({ ctx, ui }) {
    const apps = await ctx.state.list();
    ui.heading('Apps');
    if (!apps.length) { ui.line('  Nothing yet. Start with: compact transform <path-or-github-url>'); return { ok: true, apps: [] }; }
    ui.table(['Name', 'Mode', 'Anchored', 'Pushed', 'Folder'], apps.map((a) => [
      a.name, a.mode ?? '-', a.deployments?.length ? ui.c.green('yes') : ui.c.dim('no'), a.github ? ui.c.green(`${a.github.owner}/${a.github.repo}`) : ui.c.dim('no'),
      fs.existsSync(a.outDir) ? a.outDir : ui.c.red(`${a.outDir} (missing)`),
    ]));
    return { ok: true, apps: apps.map(({ id, name, mode, outDir, source, github, deployments }) => ({ id, name, mode, outDir, source, github, deployments: deployments?.length ?? 0 })) };
  },
};

export const statusCmd = {
  name: 'status',
  aliases: ['receipts'],
  summary: 'Show one app: paths, hashes, receipts, GitHub',
  usage: 'compact status [app] [options]',
  options: { all: { type: 'boolean', description: 'Show receipts from every deployment, not just the latest' } },
  examples: ['compact status', 'compact status notes --all'],
  async run({ ctx, ui, values, positionals }) {
    const app = await loadApp(ctx, positionals[0]);
    const { manifest, connect } = await readProject(app);
    const deployments = app.deployments ?? [];
    ui.heading(app.name);
    ui.kv([
      ['App id', app.id], ['Folder', app.outDir], ['Source', app.source?.type === 'github' ? `${app.source.url} @ ${app.source.sha?.slice(0, 8)}` : app.source?.path],
      ['Mode', manifest.mode], ['Manifest', connect.manifestSha256], ['Runner key', (await runnerKeyHash(manifest)).slice(0, 16) + '…'],
      ['Endpoint', connect.endpoint], ['Registry', connect.near?.registryAccount ?? ui.c.dim('not anchored yet')],
      ['GitHub', app.github ? `${app.github.url} (${app.github.branch}, ${app.github.commitSha?.slice(0, 8)})` : ui.c.dim('not pushed yet')],
    ]);
    const shown = values.all ? deployments : deployments.slice(-1);
    for (const run of shown) { ui.heading(`Deployment ${run.at}`); printReceipts(ui, run.receipts); }
    if (!deployments.length) ui.hint('No deployments yet: run compact deploy');
    return { ok: true, app: { id: app.id, name: app.name, outDir: app.outDir, mode: manifest.mode, manifestSha256: connect.manifestSha256, endpoint: connect.endpoint, registry: connect.near?.registryAccount ?? null, github: app.github ?? null }, deployments: shown };
  },
};

export const keysCmd = {
  name: 'keys',
  summary: 'Connection info for the portal; runner secrets for your TEE host',
  usage: 'compact keys [app] [--b64 | --secret]',
  options: { b64: { type: 'boolean', description: 'Print only COMPACT_KEYS_B64 (the runner secret, for a sealed env var)' }, secret: { type: 'boolean', description: 'Show the runner private key file location and contents' } },
  examples: ['compact keys', 'compact keys --b64 | pbcopy'],
  async run({ ctx, ui, values, positionals, flags }) {
    const app = await loadApp(ctx, positionals[0]);
    const d = dirs(app);
    const { manifest, connect } = await readProject(app);
    const keyFile = path.join(d.compact, 'keys/runner.secret.json');
    if (values.b64 || values.secret) {
      if (!fs.existsSync(keyFile)) throw new CompactError('E_KEYS_MISSING', 'The runner key file is missing.', { hint: 'Restore it from your backup.' });
      if (ctx.interactive && !flags.yes && !values.b64 && !(await confirm('This prints private keys. Continue?', { fallback: false }))) return { ok: false, cancelled: true };
      const raw = fs.readFileSync(keyFile, 'utf8');
      const b64 = Buffer.from(raw).toString('base64');
      if (values.b64 && !ctx.ui.json_) { process.stdout.write(`${b64}\n`); return { ok: true, silent: true }; }
      ui.box('PRIVATE: runner keys', [`File: ${keyFile}`, 'COMPACT_KEYS_B64 (set as a sealed secret on the TEE host):', b64.slice(0, 60) + '…  (use --b64 to print it fully)'], { tone: 'yellow' });
      return { ok: true, keyFile, COMPACT_KEYS_B64: b64 };
    }
    ui.heading('Connection info (public)');
    ui.kv([['File', d.connectFile], ['Endpoint', connect.endpoint], ['Registry', connect.near?.registryAccount ?? '(deploy first)'], ['Verify', connect.verify], ['Manifest', connect.manifestSha256], ['Runner ML-DSA key', manifest.runner.dsaPublic.slice(0, 32) + '…'], ['Runner ML-KEM key', manifest.runner.kemPublic.slice(0, 32) + '…']]);
    ui.blank();
    ui.hint('This is all the portal needs, and it is public. The private keys stay in compact/keys/ and on the TEE host.');
    return { ok: true, connect, connectFile: d.connectFile };
  },
};

export const forgetCmd = {
  name: 'forget',
  summary: 'Remove an app from Compact\'s memory (files are kept)',
  usage: 'compact forget <app>',
  options: {},
  examples: ['compact forget notes'],
  async run({ ctx, ui, positionals, flags }) {
    if (!positionals[0]) throw new CompactError('E_USAGE', 'Which app? compact forget <app>', { exitCode: EXIT.USAGE });
    const app = await ctx.state.resolve(positionals[0], ctx.cwd);
    if (ctx.interactive && !flags.yes && !(await confirm(`Forget "${app.name}"? Its folder stays on disk.`, { fallback: false }))) return { ok: false, cancelled: true };
    await ctx.state.remove(app.id);
    ui.success(`Forgot ${app.name} (files left at ${app.outDir})`);
    return { ok: true, removed: app.id };
  },
};
