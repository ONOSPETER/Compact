import fsp from 'node:fs/promises';
import path from 'node:path';
import { CompactError, EXIT } from '../errors.mjs';
import { ensureDir, writeJson } from '../util/fs.mjs';
import * as core from '../../templates/runtime/core.mjs';
import { getAccountInfo, waitForFunding, formatNear, MIN_BALANCE } from '../near/account.mjs';
import { deployRegistry, writeRecord, readRecord } from '../near/registry.mjs';
import { withNote } from '../ui/ui.mjs';
import { loadApp, refreshManifest, readProject, runnerKeyHash } from './project.mjs';

export const summarize = (name, r, explorer) => ({
  name, txHash: r.txHash, ok: r.ok, gasBurnt: r.gasBurnt, tokensBurnt: r.tokensBurnt, receiptIds: r.receiptIds,
  explorer: `${explorer}/txns/${r.txHash}`,
});

/** Make sure the deployer exists on-chain with enough balance. */
export async function ensureFunded(ctx, accountId, { wait = false } = {}) {
  const { ui, rpc } = ctx;
  const info = await getAccountInfo(rpc, accountId);
  if (info.exists && info.balance >= MIN_BALANCE) return info;
  if (!wait) {
    throw new CompactError('E_INSUFFICIENT_FUNDS', `Deployer ${accountId} has ${formatNear(info.balance, 4)} NEAR; at least ${formatNear(MIN_BALANCE, 2)} is needed.`, {
      hint: 'Send testnet NEAR to that address (a testnet faucet works), then re-run. Add --wait to poll until it arrives.', exitCode: EXIT.ENV,
    });
  }
  return ui.task(`Waiting for funds at ${accountId.slice(0, 10)}…`, async (t) =>
    waitForFunding(rpc, accountId, { signal: ctx.signal, onTick: ({ balance, waitedMs }) => t.update(`Waiting for funds… ${formatNear(balance, 4)} NEAR (${Math.round(waitedMs / 1000)}s)`) }));
}

/**
 * Anchor the project on NEAR testnet: deploy the registry contract (once per deployer account),
 * then write {manifest hash, tree hash, runner key hash, endpoint}. Every step is idempotent, so
 * a failed run can simply be repeated.
 */
export async function deployProject(ctx, ref, { endpoint, wait = false, account } = {}) {
  const { ui, rpc, config } = ctx;
  const app = await loadApp(ctx, ref);

  const refreshed = await ui.task('Checking critical/ against its manifest', async () => {
    const r = await refreshManifest(ctx, app);
    return withNote(r, r.changed ? 'changed: manifest re-signed' : 'unchanged');
  });
  const { manifest } = refreshed;
  const mHash = core.hex(await core.manifestHash(manifest));

  const deployer = await ctx.keystore.unlock(account, () => ctx.passphrase());
  const net = await ui.task('Connecting to NEAR testnet', async () => {
    const s = await rpc.status();
    if (s.chain_id && s.chain_id !== 'testnet') throw new CompactError('E_WRONG_NETWORK', `RPC reports chain "${s.chain_id}", expected testnet.`, { hint: 'Check COMPACT_RPC_URLS.', exitCode: EXIT.ENV });
    return withNote(s, `height ${s.sync_info?.latest_block_height ?? '?'}`);
  });
  void net;
  await ensureFunded(ctx, deployer.accountId, { wait });

  const receipts = [];
  const reg = await ui.task('Registry contract on your deployer account', async () => {
    const r = await deployRegistry({ rpc, accountId: deployer.accountId, keyPair: deployer.keyPair, logger: ctx.logger });
    if (!r.skipped) receipts.push(summarize('deploy-registry', r.receipt, config.explorer));
    return withNote(r, r.skipped ? 'already deployed' : r.upgraded ? 'upgraded' : 'deployed');
  });

  const { connect, d } = await readProject(app);
  const record = {
    v: 1, app: app.id, manifest: mHash, tree: manifest.critical.treeHash, runnerKey: await runnerKeyHash(manifest),
    endpoint: endpoint ?? connect.endpoint, ts: new Date().toISOString(),
  };
  const existing = await readRecord({ rpc, accountId: deployer.accountId, appId: app.id }).catch(() => null);
  const same = existing && existing.manifest === record.manifest && existing.endpoint === record.endpoint && existing.runnerKey === record.runnerKey;
  await ui.task('Writing the app record on-chain', async () => {
    if (same) return withNote(null, 'already up to date');
    const r = await writeRecord({ rpc, accountId: deployer.accountId, keyPair: deployer.keyPair, appId: app.id, record, logger: ctx.logger });
    receipts.push(summarize('write-record', r, config.explorer));
    return withNote(r, r.txHash.slice(0, 8));
  });

  const nextConnect = { ...connect, endpoint: record.endpoint, verify: 'strict', manifestSha256: mHash, near: { ...connect.near, registryAccount: deployer.accountId } };
  await writeJson(d.connectFile, nextConnect);

  const run = { at: new Date().toISOString(), network: 'testnet', deployer: deployer.accountId, manifestSha256: mHash, endpoint: record.endpoint, registryDeployed: !reg.skipped, receipts };
  await ensureDir(path.join(d.compact, 'receipts'));
  const receiptFile = path.join(d.compact, 'receipts', `${run.at.replace(/[:.]/g, '-')}-deploy.json`);
  await writeJson(receiptFile, run);
  const updated = await ctx.state.upsert(app.id, (a) => ({ ...a, deployments: [...(a.deployments ?? []), run], lastDeployer: deployer.accountId }));

  return { app: updated, deployer: deployer.accountId, record, receipts, receiptFile, connect: nextConnect, connectFile: d.connectFile, manifestChanged: refreshed.changed, anchored: !same };
}
