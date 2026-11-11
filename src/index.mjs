// Compact SDK. Everything the CLI does is available here, with no terminal assumptions.
//
//   import { createContext, transformProject, deployProject, pushPortal } from '@compact/cli';
//   const ctx = await createContext({ home: '/data/tenant-1', ui: silentUI(), askPassphrase: async () => '...' });
//   const built = await transformProject(ctx, 'https://github.com/me/app', { out: '/data/tenant-1/out' });
//   const anchored = await deployProject(ctx, built.app.id, { wait: true });
//   const pushed = await pushPortal(ctx, built.app.id, { repo: 'my-portal' });
export { createContext } from './context.mjs';
export { analyzeProject, transformProject, assertPlanOk } from './transform/transform.mjs';
export { deployProject, ensureFunded } from './deploy/deploy.mjs';
export { pushPortal } from './deploy/push.mjs';
export { serveProject } from './deploy/serve.mjs';
export { commitProject, onChainShare } from './deploy/commit.mjs';
export { upgradeProject } from './deploy/upgrade.mjs';
export { assembleVercel, pushProject, exportProject } from './deploy/vercel.mjs';
export { VaultClient, randomKey, keyFromPassphrase } from '../templates/runtime/vault.mjs';
export { loadApp, readProject, refreshManifest } from './deploy/project.mjs';
export { buildPlan } from './analyze/plan.mjs';
export { Keystore } from './store/keystore.mjs';
export { StateStore } from './store/state.mjs';
export { NearRpc } from './near/rpc.mjs';
export { getAccountInfo, formatNear } from './near/account.mjs';
export { UI, silentUI } from './ui/ui.mjs';
export { CompactError, EXIT } from './errors.mjs';
