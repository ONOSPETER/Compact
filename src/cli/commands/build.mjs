import path from 'node:path';
import { analyzeProject, assertPlanOk, transformProject } from '../../transform/transform.mjs';
import { deployProject } from '../../deploy/deploy.mjs';
import { pushPortal } from '../../deploy/push.mjs';
import { serveProject } from '../../deploy/serve.mjs';
import { confirm } from '../../ui/prompt.mjs';
import { CompactError, EXIT } from '../../errors.mjs';
import { printPlan, planJson, printReceipts } from '../render.mjs';

const splitOpts = {
  critical: { type: 'string', multiple: true, description: 'Force files/globs to the critical side (repeatable)' },
  portal: { type: 'string', multiple: true, description: 'Force files/globs to the portal side (repeatable)' },
  entry: { type: 'string', description: 'Server entry file (server mode)' },
  port: { type: 'string', description: 'Port the server listens on (server mode)' },
};
const splitFrom = (v) => ({ critical: v.critical, portal: v.portal, entry: v.entry, port: v.port ? Number(v.port) : undefined });

function printCreated(ui, r) {
  ui.heading('Created');
  ui.kv([
    ['Project', r.outDir], ['portal/', 'public half: push to GitHub, host on Vercel'], ['critical/', 'private half: never published, runs behind the PQ channel'],
    ['compact/', 'manifest, runtime, deploy files, receipts, keys'],
  ]);
  ui.blank();
  ui.box('Keep this file secret', [`${path.relative(process.cwd(), r.keyFile) || r.keyFile}`, 'Holds the runner private keys. It is git-ignored: back it up, never commit it.'], { tone: 'yellow' });
  for (const n of r.notes) ui.hint(`note: ${n}`);
}

function printDeployed(ui, d) {
  ui.heading('Anchored on NEAR testnet');
  ui.kv([['Deployer', d.deployer], ['App id', d.record.app], ['Manifest', d.record.manifest], ['Endpoint', d.record.endpoint]]);
  ui.blank();
  printReceipts(ui, d.receipts);
  ui.blank();
  ui.line(`  ${ui.c.bold('Connection info for the portal')} (public): ${d.connectFile}`);
  ui.hint(`receipts saved in ${d.receiptFile}`);
}

function printPushed(ui, p) {
  ui.heading(p.unchanged ? 'GitHub is already up to date' : 'Portal pushed to GitHub');
  ui.kv([['Repository', p.url], ['Branch', p.branch], ['Commit', p.commitSha?.slice(0, 10)], ['Visibility', p.private ? 'private' : 'public']]);
  ui.blank();
  ui.line('  Next: import this repository in Vercel (Add New → Project). Framework preset: Vite.');
  if (p.endpointIsLocal) ui.warn('The portal still points at localhost. Host the runner, then: compact deploy --endpoint <https url>, then compact push.');
}

export const analyzeCmd = {
  name: 'analyze',
  summary: 'Scan an app (folder or GitHub URL) and show how it would be split',
  usage: 'compact analyze <path|github-url> [options]',
  options: { ...splitOpts, verbose: { type: 'boolean', description: 'List every file and the reason for its side' } },
  examples: ['compact analyze ./my-app', 'compact analyze https://github.com/me/my-app', 'compact analyze . --critical "src/lib/auth.js"'],
  async run({ ctx, ui, values, positionals }) {
    if (!positionals[0]) throw new CompactError('E_USAGE', 'Which app? compact analyze <path|github-url>', { exitCode: EXIT.USAGE });
    const { plan } = await analyzeProject(ctx, positionals[0], splitFrom(values));
    printPlan(ui, plan, { verbose: values.verbose });
    ui.blank();
    plan.errors.length ? ui.line(ui.c.red('  Not ready: fix the problems above, then run `compact transform`.')) : ui.success('Ready: run `compact transform` (or `compact ship`).');
    return { ok: plan.errors.length === 0, plan: planJson(plan), exitCode: plan.errors.length ? EXIT.VALIDATION : 0 };
  },
};

export const transformCmd = {
  name: 'transform',
  aliases: ['split'],
  summary: 'Restructure an app into portal/ critical/ compact/ with fresh PQ keys',
  usage: 'compact transform <path|github-url> [options]',
  options: {
    ...splitOpts,
    out: { type: 'string', short: 'o', description: 'Output folder (default: <name>-compact)' },
    name: { type: 'string', description: 'App name' },
    force: { type: 'boolean', description: 'Replace an existing output folder (regenerates keys)' },
    'allow-errors': { type: 'boolean', description: 'Proceed even if the plan has errors (advanced)' },
    verbose: { type: 'boolean' },
  },
  examples: ['compact transform ./my-app', 'compact transform github.com/me/my-app --out ./built --name notes'],
  async run({ ctx, ui, values, positionals }) {
    if (!positionals[0]) throw new CompactError('E_USAGE', 'Which app? compact transform <path|github-url>', { exitCode: EXIT.USAGE });
    const r = await transformProject(ctx, positionals[0], { ...splitFrom(values), out: values.out, name: values.name, force: values.force, allowErrors: values['allow-errors'] });
    printPlan(ui, r.plan, { verbose: values.verbose });
    printCreated(ui, r);
    ui.heading('Next steps');
    ui.line('  1. compact serve     run the critical side locally and test the portal');
    ui.line('  2. compact deploy    anchor it on NEAR testnet (needs a funded deployer)');
    ui.line('  3. compact push      publish portal/ to GitHub, then import it in Vercel');
    return { ok: true, appId: r.app.id, outDir: r.outDir, mode: r.plan.mode, keyFile: r.keyFile, manifestSha256: r.connect.manifestSha256, notes: r.notes, plan: planJson(r.plan) };
  },
};

export const deployCmd = {
  name: 'deploy',
  summary: 'Anchor the critical side on NEAR testnet and print the receipts',
  usage: 'compact deploy [app] [options]',
  options: {
    endpoint: { type: 'string', description: 'Public URL where the runner is hosted (recorded on-chain and in the portal)' },
    wait: { type: 'boolean', description: 'Wait for the deployer to be funded instead of failing' },
    account: { type: 'string', description: 'Use a specific deployer address' },
  },
  examples: ['compact deploy', 'compact deploy notes --wait', 'compact deploy --endpoint https://runner.example.com'],
  async run({ ctx, ui, values, positionals }) {
    const d = await deployProject(ctx, positionals[0], { endpoint: values.endpoint, wait: values.wait, account: values.account });
    printDeployed(ui, d);
    return { ok: true, appId: d.app.id, deployer: d.deployer, record: d.record, receipts: d.receipts, receiptFile: d.receiptFile, connect: d.connect, connectFile: d.connectFile, anchored: d.anchored };
  },
};

export const pushCmd = {
  name: 'push',
  summary: 'Publish portal/ to a GitHub repository (private by default)',
  usage: 'compact push [app] [options]',
  options: {
    repo: { type: 'string', description: 'Repository name (default: <app>-portal)' },
    owner: { type: 'string', description: 'User or organisation (default: you)' },
    branch: { type: 'string', description: 'Branch (default: main)' },
    public: { type: 'boolean', description: 'Create the repository as public' },
    message: { type: 'string', short: 'm', description: 'Commit message' },
    'allow-secrets': { type: 'boolean', description: 'Push even if the secret scan finds something' },
    'dry-run': { type: 'boolean', description: 'List what would be pushed' },
  },
  examples: ['compact push', 'compact push notes --repo notes-site --public', 'compact push --dry-run'],
  async run({ ctx, ui, values, positionals }) {
    const p = await pushPortal(ctx, positionals[0], { owner: values.owner, repo: values.repo, branch: values.branch, isPrivate: !values.public, message: values.message, allowSecrets: values['allow-secrets'], dryRun: values['dry-run'] });
    if (p.dryRun) { ui.heading(`Would push ${p.files.length} files`); p.files.slice(0, 40).forEach((f) => ui.line(`  ${f}`)); return { ok: true, dryRun: true, files: p.files }; }
    printPushed(ui, p);
    return { ok: true, url: p.url, owner: p.owner, repo: p.repo, branch: p.branch, commitSha: p.commitSha, unchanged: p.unchanged, private: p.private };
  },
};

export const shipCmd = {
  name: 'ship',
  summary: 'transform + deploy + push in one go',
  usage: 'compact ship <path|github-url> [options]',
  options: {
    ...splitOpts,
    out: { type: 'string', short: 'o' }, name: { type: 'string' }, force: { type: 'boolean' },
    endpoint: { type: 'string', description: 'Public runner URL (optional now, set later with compact deploy --endpoint)' },
    wait: { type: 'boolean', description: 'Wait for the deployer to be funded' },
    repo: { type: 'string' }, owner: { type: 'string' }, public: { type: 'boolean' },
    'skip-push': { type: 'boolean', description: 'Stop after deploy' },
  },
  examples: ['compact ship ./my-app --wait', 'compact ship github.com/me/my-app --yes'],
  async run({ ctx, ui, values, positionals, flags }) {
    if (!positionals[0]) throw new CompactError('E_USAGE', 'Which app? compact ship <path|github-url>', { exitCode: EXIT.USAGE });
    const { plan } = await analyzeProject(ctx, positionals[0], splitFrom(values));
    printPlan(ui, plan);
    assertPlanOk(plan);
    if (ctx.interactive && !flags.yes && !(await confirm('\nBuild, anchor on NEAR testnet and push the portal?'))) return { ok: false, cancelled: true, exitCode: EXIT.CANCELLED };

    const r = await transformProject(ctx, positionals[0], { ...splitFrom(values), out: values.out, name: values.name, force: values.force });
    printCreated(ui, r);
    const d = await deployProject(ctx, r.app.id, { endpoint: values.endpoint, wait: values.wait });
    printDeployed(ui, d);
    let p = null;
    if (!values['skip-push']) { p = await pushPortal(ctx, r.app.id, { owner: values.owner, repo: values.repo, isPrivate: !values.public }); printPushed(ui, p); }
    ui.heading('What is left for you');
    ui.line('  1. Host the runner on a TEE host (see compact/deploy/README.md); `compact keys --b64` prints its sealed secret.');
    ui.line('  2. compact deploy --endpoint <runner url>   then   compact push');
    ui.line('  3. Import the GitHub repo in Vercel.');
    return { ok: true, appId: r.app.id, outDir: r.outDir, deploy: { deployer: d.deployer, receipts: d.receipts, record: d.record }, github: p && { url: p.url, commitSha: p.commitSha } };
  },
};

export const serveCmd = {
  name: 'serve',
  summary: 'Run the critical side locally (development)',
  usage: 'compact serve [app] [options]',
  handlesSignals: true,
  options: { port: { type: 'string', description: 'Runner port (default 8787)' }, 'no-install': { type: 'boolean', description: 'Do not run npm install' }, origins: { type: 'string', description: 'Allowed CORS origins, comma separated (default *)' } },
  examples: ['compact serve', 'compact serve notes --port 9000'],
  async run({ ctx, values, positionals }) {
    const r = await serveProject(ctx, positionals[0], { port: Number(values.port ?? 8787), install: !values['no-install'], origins: values.origins });
    return { ok: r.exitCode === 0, exitCode: r.exitCode };
  },
};
