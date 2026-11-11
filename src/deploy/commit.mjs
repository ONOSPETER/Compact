import path from 'node:path';
import { CompactError, EXIT } from '../errors.mjs';
import { writeJson, ensureDir } from '../util/fs.mjs';
import { deployRegistry, writeRecord } from '../near/registry.mjs';
import { ensureFunded, summarize } from './deploy.mjs';
import { loadApp, readProject, apiBase } from './project.mjs';
import { withNote } from '../ui/ui.mjs';

async function runnerJson(ctx, url, init) {
  let res;
  try { res = await ctx.fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }); } catch (e) {
    throw new CompactError('E_RUNNER_UNREACHABLE', `Could not reach the runner at ${url}`, { hint: 'Is it running? Start it with `compact serve` (another shell), or pass --endpoint.', cause: e, exitCode: EXIT.NETWORK });
  }
  if (!res.ok) throw new CompactError('E_RUNNER_HTTP', `The runner answered ${res.status} for ${url}`, { hint: 'Run `compact upgrade` so the project has the vault endpoints, then restart the runner.' });
  return res.json();
}

/** How much of this app's activity touches the chain: on-chain transactions vs off-chain vault writes. */
export function onChainShare(app) {
  const txs = (app.deployments ?? []).reduce((n, d) => n + d.receipts.length, 0) + (app.anchors ?? []).length + (app.vault?.extraTxs ?? 0);
  const writes = app.vault?.writes ?? 0;
  return { txs, writes, share: txs + writes ? txs / (txs + writes) : 0 };
}

/**
 * Anchor the Merkle root of all vault heads on NEAR. One transaction commits to every user's latest
 * version, so on-chain activity stays a small fraction of data operations. Skipped unless at least
 * `minWrites` writes happened since the last anchor (override with force).
 */
export async function commitProject(ctx, ref, { endpoint, minWrites = 10, force = false, account, wait = false } = {}) {
  const { ui, rpc, config } = ctx;
  const app = await loadApp(ctx, ref);
  const { connect, d } = await readProject(app);
  const base = apiBase(connect, endpoint);
  const info = await ui.task('Reading the vault state from the runner', () => runnerJson(ctx, `${base}/v1/root`));
  const last = app.anchors?.at(-1);
  const since = info.writes - (last?.writes ?? 0);
  if (!info.count) return { skipped: true, reason: 'empty', ...info, since };
  if (!force) {
    if (last?.root === info.root) return { skipped: true, reason: 'unchanged', ...info, since };
    if (since < minWrites) return { skipped: true, reason: 'below-threshold', ...info, since, minWrites };
  }
  await ui.task('Saving a snapshot so clients can prove their entry', () => runnerJson(ctx, `${base}/v1/snapshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: info.root }) }));

  const deployer = await ctx.keystore.unlock(account, () => ctx.passphrase());
  if (connect.near?.registryAccount && connect.near.registryAccount !== deployer.accountId) {
    throw new CompactError('E_REGISTRY_MISMATCH', `This app's registry lives on ${connect.near.registryAccount}, not ${deployer.accountId}.`, { hint: 'Use --account <address>, or run `compact deploy` with the current deployer first.' });
  }
  await ensureFunded(ctx, deployer.accountId, { wait });
  const receipts = [];
  await ui.task('Registry contract', async () => {
    const r = await deployRegistry({ rpc, accountId: deployer.accountId, keyPair: deployer.keyPair, logger: ctx.logger });
    if (!r.skipped) receipts.push(summarize('deploy-registry', r.receipt, config.explorer));
    return withNote(r, r.skipped ? 'already deployed' : r.upgraded ? 'upgraded' : 'deployed');
  });
  const record = { v: 1, root: info.root, count: info.count, writes: info.writes, ts: new Date().toISOString() };
  const anchor = await ui.task('Anchoring the vault root on NEAR', async () => {
    const r = await writeRecord({ rpc, accountId: deployer.accountId, keyPair: deployer.keyPair, appId: `${app.id}:root`, record, logger: ctx.logger });
    const s = summarize('anchor-root', r, config.explorer);
    receipts.push(s);
    return withNote(s, r.txHash.slice(0, 8));
  });

  const entry = { at: record.ts, root: info.root, count: info.count, writes: info.writes, txHash: anchor.txHash, explorer: anchor.explorer };
  const updated = await ctx.state.upsert(app.id, (a) => ({ ...a, anchors: [...(a.anchors ?? []), entry], vault: { writes: info.writes, endpoint: base, extraTxs: (a.vault?.extraTxs ?? 0) + receipts.filter((r) => r.name === 'deploy-registry').length } }));
  await ensureDir(path.join(d.compact, 'receipts'));
  await writeJson(path.join(d.compact, 'receipts', `${record.ts.replace(/[:.]/g, '-')}-commit.json`), { ...entry, deployer: deployer.accountId, receipts });
  return { skipped: false, app: updated, record, receipts, since, ...onChainShare(updated) };
}
