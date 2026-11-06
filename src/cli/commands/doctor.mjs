import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { getAccountInfo, formatNear, MIN_BALANCE } from '../../near/account.mjs';
import { NearRpc } from '../../near/rpc.mjs';
import { loadPQ } from '../../transform/transform.mjs';
import { GitHub } from '../../github/client.mjs';

export default {
  name: 'doctor',
  summary: 'Diagnose your setup (Node, RPC, funds, GitHub, post-quantum library)',
  usage: 'compact doctor',
  options: {},
  examples: ['compact doctor', 'compact doctor --json'],
  async run({ ctx, ui }) {
    const checks = [];
    const check = async (name, fn) => {
      try { checks.push({ name, ...(await fn()) }); } catch (e) { checks.push({ name, status: 'fail', detail: e.message, hint: e.hint }); }
    };
    await check('Node.js', async () => ({ status: Number(process.versions.node.split('.')[0]) >= 20 ? 'ok' : 'fail', detail: process.version, hint: 'Compact needs Node 20+' }));
    await check('Compact home', async () => { fs.mkdirSync(ctx.paths.home, { recursive: true }); fs.accessSync(ctx.paths.home, fs.constants.W_OK); return { status: 'ok', detail: ctx.paths.home }; });
    await check('Post-quantum library', async () => { const pq = await loadPQ(ctx); return { status: 'ok', detail: pq.name ?? 'loaded' }; });
    for (const url of ctx.config.rpcUrls) {
      await check(`RPC ${new URL(url).host}`, async () => {
        const t = Date.now();
        const s = await new NearRpc({ urls: [url], attempts: 1, timeoutMs: 8000, fetchImpl: ctx.fetch }).status();
        return { status: s.chain_id === 'testnet' ? 'ok' : 'warn', detail: `${s.chain_id}, block ${s.sync_info?.latest_block_height}, ${Date.now() - t}ms`, hint: s.chain_id === 'testnet' ? undefined : 'Not a testnet endpoint' };
      });
    }
    const id = await ctx.keystore.getDefaultId().catch(() => null);
    await check('Deployer account', async () => (id ? { status: 'ok', detail: id } : { status: 'fail', detail: 'none', hint: 'Run: compact setup' }));
    if (id) {
      await check('Deployer balance', async () => {
        const i = await getAccountInfo(ctx.rpc, id);
        return i.balance >= MIN_BALANCE ? { status: 'ok', detail: `${formatNear(i.balance)} NEAR` } : { status: 'warn', detail: `${formatNear(i.balance)} NEAR`, hint: `Fund ${id} (need ≥ ${formatNear(MIN_BALANCE, 2)})` };
      });
    }
    await check('GitHub token', async () => {
      const found = await ctx.credentials.githubToken(ctx.env);
      if (!found) return { status: 'warn', detail: 'not configured', hint: 'Needed for push and private repos: compact setup' };
      const u = await new GitHub({ token: found.token, fetchImpl: ctx.fetch }).user();
      return { status: 'ok', detail: `@${u.login} (${found.source})` };
    });
    await check('npm', async () => { const r = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version']); return r.status === 0 ? { status: 'ok', detail: r.stdout.toString().trim() } : { status: 'warn', detail: 'not found', hint: 'Needed by `compact serve` to install dependencies' }; });
    await check('Docker (optional)', async () => { const r = spawnSync('docker', ['--version']); return r.status === 0 ? { status: 'ok', detail: r.stdout.toString().trim() } : { status: 'warn', detail: 'not found', hint: 'Only needed to build the TEE image yourself' }; });

    ui.heading('Compact doctor');
    for (const c of checks) {
      const mark = c.status === 'ok' ? ui.c.green(ui.g.ok) : c.status === 'warn' ? ui.c.yellow(ui.g.warn) : ui.c.red(ui.g.fail);
      ui.line(`${mark} ${c.name.padEnd(26)} ${ui.c.dim(c.detail ?? '')}`);
      if (c.hint && c.status !== 'ok') ui.line(`    ${ui.c.dim(c.hint)}`);
    }
    const failed = checks.filter((c) => c.status === 'fail').length;
    ui.blank();
    failed ? ui.line(ui.c.red(`${failed} check(s) failed`)) : ui.success('All required checks passed');
    return { ok: failed === 0, checks, exitCode: failed ? 1 : 0 };
  },
};
