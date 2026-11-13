// Compact UI bridge. A tiny local HTTP API in front of the Compact SDK, so the browser UI can drive
// the same functions the CLI uses. The browser cannot import the SDK (it needs fs, crypto and your keystore),
// so this process does the work and the UI only shows it.
//
//   node src/ui-server/server.mjs        -> http://127.0.0.1:8788   (UI: Vite proxies /api here)
//
// Security: binds to 127.0.0.1. There is no login by default. To require a token again, start with
// COMPACT_UI_TOKEN=yourtoken (the UI then shows an error until the token is removed).
// Secrets are returned only by the endpoints marked SECRET.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createContext, silentUI, analyzeProject, transformProject, deployProject, pushProject, commitProject,
  assembleVercel, loadApp, readProject, getAccountInfo, formatNear,
} from '../index.mjs';
import { MIN_BALANCE } from '../near/account.mjs';
import { planJson } from '../cli/render.mjs';
import { GitHub } from '../github/client.mjs';
import { dirs, runnerKeyHash, apiBase } from '../deploy/project.mjs';
import { readRecord } from '../near/registry.mjs';
import { VaultClient, randomKey } from '../../templates/runtime/vault.mjs';
import doctor from '../cli/commands/doctor.mjs';

const PORT = Number(process.env.COMPACT_UI_PORT ?? 8788);
const HOST = process.env.COMPACT_UI_HOST ?? '127.0.0.1';
const TOKEN = process.env.COMPACT_UI_TOKEN || ''; // optional
const WORKDIR = path.resolve(process.env.COMPACT_UI_WORKDIR ?? process.cwd());
const DIST = path.resolve(process.env.COMPACT_UI_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist'));

// ---------- helpers ----------
const json = (res, code, body) => { const s = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v)); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(s); };
const errBody = (e) => ({ code: e.code ?? 'E_UNEXPECTED', message: e.message ?? String(e), hint: e.hint, details: Array.isArray(e.details) ? e.details.slice(0, 12) : undefined });
const readBody = (req) => new Promise((ok, no) => { let n = 0; const b = []; req.on('data', (c) => { n += c.length; if (n > 1e6) { no(new Error('Request too large')); req.destroy(); } else b.push(c); }); req.on('end', () => { try { ok(b.length ? JSON.parse(Buffer.concat(b).toString()) : {}); } catch { no(new Error('Invalid JSON')); } }); });
const authed = (req) => { if (!TOKEN) return true; const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || req.headers['x-compact-token'] || ''; const a = Buffer.from(String(t)), b = Buffer.from(TOKEN); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const ctxFor = (ui = silentUI(), passphrase) => createContext({ ui, cwd: WORKDIR, interactive: false, askPassphrase: passphrase ? async () => passphrase : undefined });
const list = (v) => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : String(v ?? '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean));

// ---------- jobs: long operations run in the background; the UI polls them ----------
const jobs = new Map();
function eventUI(job) {
  const ui = silentUI();
  ui.task = async (title, fn) => {
    const step = { title, state: 'running', note: '', detail: '' };
    job.steps.push(step);
    try {
      const r = await fn({ update: (t) => { step.detail = String(t); }, warn: (t) => job.warnings.push(String(t)) });
      step.state = 'done'; step.detail = '';
      if (r && typeof r === 'object' && r.__note !== undefined) { step.note = r.__note; return r.value; }
      return r;
    } catch (e) { step.state = 'failed'; throw e; }
  };
  ui.warn = (t) => job.warnings.push(String(t));
  return ui;
}
function startJob(kind, run) {
  const job = { id: crypto.randomUUID(), kind, status: 'running', steps: [], warnings: [], result: null, error: null, at: Date.now() };
  jobs.set(job.id, job);
  for (const [id, j] of jobs) if (jobs.size > 40 && j.status !== 'running') jobs.delete(id);
  Promise.resolve().then(() => run(eventUI(job))).then((r) => { job.result = r; job.status = 'done'; }).catch((e) => { job.error = errBody(e); job.status = 'failed'; });
  return job;
}

const JOBS = {
  analyze: (b) => (ui) => ctxFor(ui).then(async (ctx) => {
    if (!b.source) throw Object.assign(new Error('Paste a GitHub link or a folder path first.'), { code: 'E_USAGE' });
    const r = await analyzeProject(ctx, b.source, { critical: list(b.critical), portal: list(b.portal), entry: b.entry || undefined, port: b.port ? Number(b.port) : undefined });
    return { plan: planJson(r.plan) };
  }),
  transform: (b) => (ui) => ctxFor(ui).then(async (ctx) => {
    const r = await transformProject(ctx, b.source, { critical: list(b.critical), portal: list(b.portal), entry: b.entry || undefined, port: b.port ? Number(b.port) : undefined, name: b.name || undefined, out: b.out || undefined, force: !!b.force });
    return { appId: r.app.id, name: r.app.name, outDir: r.outDir, mode: r.plan.mode, keyFile: r.keyFile, manifestSha256: r.connect.manifestSha256, notes: r.notes, plan: planJson(r.plan) };
  }),
  deploy: (b) => (ui) => ctxFor(ui, b.passphrase).then(async (ctx) => {
    const d = await deployProject(ctx, b.appId, { endpoint: b.endpoint || undefined });
    return { appId: d.app.id, deployer: d.deployer, record: d.record, receipts: d.receipts, anchored: d.anchored, connect: d.connect };
  }),
  push: (b) => (ui) => ctxFor(ui).then(async (ctx) => {
    const p = await pushProject(ctx, b.appId, { owner: b.owner || undefined, repo: b.repo || undefined, isPrivate: !b.public, dryRun: !!b.dryRun, allowSecrets: false });
    if (p.dryRun) return { dryRun: true, files: p.files, env: p.env };
    return { url: p.url, owner: p.owner, repo: p.repo, branch: p.branch, commitSha: p.commitSha, unchanged: !!p.unchanged, private: p.private, env: p.env };
  }),
  // End-to-end check of a live Vercel deployment. Each check runs even if an earlier one fails.
  verify: (b) => (ui) => ctxFor(ui).then(async (ctx) => {
    const app = await loadApp(ctx, b.appId);
    const { connect, manifest } = await readProject(app);
    const origin = new URL(String(b.url)).origin;
    const c = { ...connect, endpoint: origin, layout: 'vercel', verify: 'strict' };
    const checks = []; let health = null;
    const check = async (id, title, fn) => { try { await ui.task(title, fn); checks.push({ id, ok: true }); } catch (e) { checks.push({ id, ok: false, message: e.message, hint: e.hint }); } };
    await check('live', 'Function is live', async () => {
      health = await checkEndpoint(origin);
      if (!(health.status >= 200 && health.status < 300)) throw Object.assign(new Error(health.error ?? `The health URL answered ${health.status}.`), { hint: health.authPage ? 'Turn off Vercel Authentication under Settings, then Deployment Protection.' : health.status === 404 ? 'The function was not found. Check that the deployment finished.' : 'Open the deployment’s runtime logs on Vercel.' });
    });
    await check('integrity', 'Backend files match the signed manifest', async () => {
      if (health?.integrityOk !== true) throw Object.assign(new Error('The integrity check did not pass.'), { hint: 'The keys in Vercel may not match this build. Copy COMPACT_KEYS_B64 again.' });
    });
    await check('record', 'Manifest matches the NEAR record', async () => {
      const acct = connect.near?.registryAccount;
      if (!acct) throw new Error('Anchor your app on NEAR first.');
      const rec = await readRecord({ rpc: ctx.rpc, accountId: acct, appId: app.id });
      if (!rec) throw new Error('No record found on NEAR for this app.');
      if (rec.manifest !== connect.manifestSha256) throw Object.assign(new Error('The on-chain manifest differs from your build.'), { hint: 'Anchor again after rebuilding.' });
    });
    await check('handshake', 'Encrypted handshake works', async () => {
      const { CompactClient } = await import('../../templates/runtime/client-core.mjs');
      await new CompactClient({ connect: c, manifest, fetchImpl: ctx.fetch }).ready();
    });
    await check('vault', 'Vault test: write, read, verify', async () => { // writes and deletes one tiny entry under a throwaway key
      const v = new VaultClient({ endpoint: apiBase(c), appId: app.id, key: randomKey(), fetchImpl: ctx.fetch, near: connect.near?.registryAccount ? { rpcUrls: ctx.config.rpcUrls, registryAccount: connect.near.registryAccount } : undefined });
      const probe = await ctx.fetch(`${apiBase(c)}/v1/stats`).catch(() => null); // names the cause before the write fails
      if (probe && probe.status !== 200) {
        let j = null; try { j = JSON.parse(await probe.text()); } catch {}
        throw Object.assign(new Error(j?.error ? `The vault routes answered ${probe.status}: ${j.error}.` : `The vault routes answered ${probe.status}, but not from your Compact function.`), {
          hint: probe.status === 503 ? 'Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in Vercel (Settings, Environment Variables), then redeploy.'
            : probe.status === 404 ? (j ? 'The deployed function is older than this build: run Push again, then redeploy on Vercel.' : 'Vercel is not sending /api/compact/v1/* to the function: check vercel.json and api/compact/[...path].mjs in the repo.')
            : 'Open the function logs on Vercel.',
        });
      }
      const name = `compact-check/${Date.now()}`;
      await v.put(name, 'ok');
      if ((await v.get(name)) !== 'ok') throw new Error('Read back a different value than was written.');
      await v.remove(name);
    });
    return { checks };
  }),
  commit: (b) => (ui) => ctxFor(ui, b.passphrase).then(async (ctx) => commitProject(ctx, b.appId, { endpoint: b.endpoint || undefined, force: !!b.force, minWrites: Number(b.minWrites ?? 10) })),
};

// ---------- read models ----------
async function deployerInfo(ctx) {
  const id = await ctx.keystore.getDefaultId();
  if (!id) return null;
  const me = (await ctx.keystore.list()).find((a) => a.accountId === id);
  const out = { accountId: id, publicKey: me?.publicKey, encrypted: !!me?.encrypted, minNear: formatNear(MIN_BALANCE, 2) };
  try { const i = await getAccountInfo(ctx.rpc, id); Object.assign(out, { exists: i.exists, balance: i.balance.toString(), balanceNear: formatNear(i.balance, 4), funded: i.balance >= MIN_BALANCE }); }
  catch (e) { Object.assign(out, { funded: false, balanceNear: '?', balanceError: e.message }); }
  return out;
}
const appSummary = (a) => ({ id: a.id, name: a.name, mode: a.mode, outDir: a.outDir, source: a.source, github: a.github ?? null, deployments: a.deployments?.length ?? 0, anchors: a.anchors?.length ?? 0, lastReceipts: a.deployments?.at(-1)?.receipts ?? [], endpoint: null });

async function appDetail(ctx, id) {
  const app = await loadApp(ctx, id);
  const { connect, manifest } = await readProject(app);
  const env = (await assembleVercel(app).catch(() => null))?.env ?? { required: ['COMPACT_KEYS_B64'], storage: ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], app: [] };
  return { ...appSummary(app), endpoint: connect.endpoint, registry: connect.near?.registryAccount ?? null, manifestSha256: connect.manifestSha256, runnerKeyHash: (await runnerKeyHash(manifest)).slice(0, 16), env, explorer: ctx.config.explorer, deploymentsAll: (app.deployments ?? []).map((d) => ({ at: d.at, deployer: d.deployer, receipts: d.receipts })) };
}

async function checkEndpoint(raw) {
  let u; try { u = new URL(raw); } catch { throw Object.assign(new Error('That is not a valid URL.'), { code: 'E_USAGE' }); }
  const local = ['localhost', '127.0.0.1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !local) throw Object.assign(new Error('Use the https:// address that Vercel shows.'), { code: 'E_USAGE' });
  const url = `${u.origin}/api/compact/health`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch {}
    return { url, status: r.status, ok: r.ok && body?.integrity?.ok === true, integrityOk: body?.integrity?.ok ?? null, authPage: !body && /vercel|authentication|sign in/i.test(text), body: body ? { integrity: body.integrity, version: body.version } : null };
  } catch (e) { return { url, status: 0, ok: false, error: e.name === 'TimeoutError' ? 'No answer within 10 seconds.' : e.message }; }
}

// ---------- routes ----------
async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  const b = m === 'POST' || m === 'DELETE' || m === 'PUT' ? await readBody(req) : {};
  const ctx = await ctxFor();

  if (m === 'GET' && p === '/api/session') {
    const gh = await ctx.credentials.githubToken(ctx.env);
    return json(res, 200, { network: 'testnet', node: process.version, explorer: ctx.config.explorer, setupComplete: !!ctx.config.setupComplete, workdir: WORKDIR,
      deployer: await deployerInfo(ctx), github: gh ? { user: gh.user ?? null, source: gh.source } : null, apps: (await ctx.state.list()).map(appSummary) });
  }
  if (m === 'GET' && p === '/api/balance') return json(res, 200, { deployer: await deployerInfo(ctx) });
  if (m === 'POST' && p === '/api/doctor') { const r = await doctor.run({ ctx, ui: silentUI() }); return json(res, 200, { checks: r.checks }); }

  if (m === 'POST' && p === '/api/account/create') { // SECRET: shown once
    const c = await ctx.keystore.add({ passphrase: b.passphrase || undefined });
    await ctx.configStore.save({ setupComplete: true });
    return json(res, 200, { accountId: c.accountId, secretKey: c.secret });
  }
  if (m === 'POST' && p === '/api/account/import') {
    if (!b.secretKey) return json(res, 400, { error: { code: 'E_USAGE', message: 'Paste the secret key (it starts with ed25519:).' } });
    const r = await ctx.keystore.importSecret(String(b.secretKey).trim(), { passphrase: b.passphrase || undefined });
    await ctx.configStore.save({ setupComplete: true });
    return json(res, 200, { accountId: r.accountId });
  }
  if (m === 'POST' && p === '/api/account/export') { // SECRET
    const k = await ctx.keystore.unlock(undefined, async () => b.passphrase);
    return json(res, 200, { accountId: k.accountId, secretKey: k.secret });
  }
  if (m === 'POST' && p === '/api/github/token') {
    const token = String(b.token ?? '').trim();
    if (!token) return json(res, 400, { error: { code: 'E_USAGE', message: 'Paste your GitHub token first.' } });
    const u = await new GitHub({ token, fetchImpl: ctx.fetch, logger: ctx.logger }).user();
    await ctx.credentials.saveGithub({ token, user: u.login });
    return json(res, 200, { user: u.login });
  }
  if (m === 'DELETE' && p === '/api/github/token') { await ctx.credentials.clearGithub(); return json(res, 200, { ok: true }); }

  const jm = /^\/api\/jobs\/([a-z]+)$/.exec(p);
  if (m === 'POST' && jm) {
    if (!JOBS[jm[1]]) return json(res, 404, { error: { code: 'E_UNKNOWN_JOB', message: `Unknown job ${jm[1]}` } });
    return json(res, 202, { id: startJob(jm[1], JOBS[jm[1]](b)).id });
  }
  const jg = /^\/api\/jobs\/([0-9a-f-]{36})$/.exec(p);
  if (m === 'GET' && jg) { const j = jobs.get(jg[1]); return j ? json(res, 200, j) : json(res, 404, { error: { code: 'E_NO_JOB', message: 'That job is gone (the server restarted?).' } }); }

  const am = /^\/api\/apps\/([^/]+)(?:\/(keys))?$/.exec(p);
  if (m === 'GET' && am && !am[2]) return json(res, 200, await appDetail(ctx, decodeURIComponent(am[1])));
  if (m === 'POST' && am?.[2] === 'keys') { // SECRET: runner private keys for the host's sealed env var
    const app = await loadApp(ctx, decodeURIComponent(am[1]));
    const f = path.join(dirs(app).compact, 'keys/runner.secret.json');
    if (!fs.existsSync(f)) return json(res, 404, { error: { code: 'E_KEYS_MISSING', message: 'The runner key file is missing.', hint: 'Restore it from your backup.' } });
    return json(res, 200, { keyFile: f, COMPACT_KEYS_B64: Buffer.from(fs.readFileSync(f, 'utf8')).toString('base64') });
  }
  // Wizard progress, saved per deployer account so the same key brings unfinished work back. No secrets in it.
  if (p === '/api/progress' && (m === 'GET' || m === 'PUT')) {
    const id = await ctx.keystore.getDefaultId();
    const file = path.join(ctx.paths.home, 'ui-progress.json');
    let all = {}; try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
    if (m === 'GET') return json(res, 200, { accountId: id, progress: id ? all[id] ?? null : null });
    if (!id) return json(res, 400, { error: { code: 'E_NO_ACCOUNT', message: 'Connect a deployer account first.' } });
    const str = (v, n = 500) => String(v ?? '').slice(0, n);
    const src = b.src ?? {};
    all[id] = { step: Math.max(0, Math.min(Number(b.step) || 0, 20)), flags: Object.fromEntries(Object.entries(b.flags ?? {}).slice(0, 60).map(([k, v]) => [str(k, 40), !!v])),
      src: { source: str(src.source), critical: str(src.critical, 2000), portal: str(src.portal, 2000), entry: str(src.entry), port: str(src.port, 10) }, appId: str(b.appId, 200), url: str(b.url), at: new Date().toISOString() };
    fs.mkdirSync(ctx.paths.home, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(all), { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file);
    return json(res, 200, { ok: true });
  }
  if (m === 'POST' && p === '/api/check-endpoint') return json(res, 200, await checkEndpoint(b.url));
  return json(res, 404, { error: { code: 'E_NOT_FOUND', message: `${m} ${p}` } });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2' };
function serveStatic(res, pathname) {
  let f = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('UI not built. Run: npm --prefix ui run build  (or use the Vite dev server)'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}

export function startUiServer({ port = PORT, host = HOST } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (!url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    if (!authed(req)) return json(res, 401, { error: { code: 'E_TOKEN', message: 'This Compact server was started with COMPACT_UI_TOKEN set.', hint: 'Restart it without COMPACT_UI_TOKEN to open the UI.' } });
    try { await api(req, res, url); }
    catch (e) { json(res, e.exitCode === 5 || e.code === 'E_USAGE' ? 400 : 500, { error: errBody(e) }); }
  });
  server.listen(port, host, () => {
    console.log(`\n  Compact UI bridge  http://${host}:${port}`);
    if (TOKEN) console.log('  Access token       required (COMPACT_UI_TOKEN is set)');
    console.log(`  Working folder     ${WORKDIR}  (new projects are created here)\n  Network            NEAR testnet only\n`);
  });
  return server;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startUiServer();
