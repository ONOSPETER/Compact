import fsp from 'node:fs/promises';
import path from 'node:path';
import { CompactError } from '../errors.mjs';
import { ensureDir, atomicWrite, writeJson, hashFiles, treeHash, walk, sha256Hex } from '../util/fs.mjs';
import * as core from '../../templates/runtime/core.mjs';
import { planViteConfig } from './viteconfig.mjs';
import { dropServerSteps, serverDirsOf } from './scripts.mjs';

const TEMPLATES = new URL('../../templates/runtime/', import.meta.url);
const NOBLE = '^0.5.0';
export const RUNNER_PORT = 8787;

export const readTemplate = (name) => fsp.readFile(new URL(name, TEMPLATES), 'utf8');
export const RUNNER_RUNTIME = ['runner.mjs', 'core.mjs', 'pq.mjs', 'merkle.mjs', 'store.mjs', 'kv.mjs', 'serverless.mjs'];
export const portalRuntimeFiles = (mode) => ['client.mjs', 'client-core.mjs', 'core.mjs', 'pq.mjs', 'merkle.mjs', 'vault.mjs', ...(mode === 'http' ? ['install.mjs'] : [])];
const rel = (from, to) => { const r = path.posix.relative(path.posix.dirname(from), to); return r.startsWith('.') ? r : `./${r}`; };

export function splitEnv(text) {
  const pub = []; const secret = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!m) continue;
    (m[1].startsWith('VITE_') ? pub : secret).push(line);
  }
  return { pub: pub.join('\n') + (pub.length ? '\n' : ''), secret: secret.join('\n') + (secret.length ? '\n' : '') };
}

export function patchIndexHtml(html) {
  const tag = '<script type="module" src="/src/compact/install.mjs"></script>';
  if (html.includes('compact/install.mjs')) return html;
  const m = /<script\b[^>]*type=["']module["'][^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index) + tag + '\n    ' + html.slice(m.index);
  const head = /<\/head>/i.exec(html);
  return head ? html.slice(0, head.index) + `  ${tag}\n  ` + html.slice(head.index) : null;
}

export function stubSource(file, moduleId, names) {
  const importPath = rel(file, 'src/compact/client.mjs');
  const lines = [
    `// Compact stub for ${moduleId}. Generated: the real implementation runs on the critical side.`,
    `import { compact } from '${importPath}';`,
  ];
  for (const n of names) {
    if (n === 'default') lines.push(`export default (...args) => compact.call(${JSON.stringify(moduleId)}, 'default', args);`);
    else lines.push(`export const ${n} = (...args) => compact.call(${JSON.stringify(moduleId)}, ${JSON.stringify(n)}, args);`);
  }
  return lines.join('\n') + '\n';
}

async function copyOut(srcDir, destDir, relPath) {
  const src = path.join(srcDir, relPath);
  const dest = path.join(destDir, relPath);
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
  const st = await fsp.stat(src);
  await fsp.chmod(dest, st.mode & 0o777).catch(() => {});
}

function derivePackages({ pkg, plan, name }) {
  const removedScripts = [];
  const portalPkg = structuredClone(pkg);
  for (const section of ['dependencies', 'devDependencies']) {
    for (const d of plan.deps.portalRemove) delete portalPkg[section]?.[d];
  }
  const criticalPaths = [plan.entry, ...Object.keys(plan.files).filter((f) => plan.files[f].side === 'critical')].filter(Boolean);
  const startsServer = /\b(node|nodemon|tsx|ts-node|babel-node|bun|deno)\b/;
  for (const [k, v] of Object.entries(portalPkg.scripts ?? {})) {
    // Only drop scripts that launch a server file. Never build/dev/preview scripts.
    if (startsServer.test(v) && !/\bvite\b/.test(v) && criticalPaths.some((p) => v.includes(p))) { removedScripts.push(k); delete portalPkg.scripts[k]; }
  }
  const fixed = dropServerSteps(portalPkg.scripts, serverDirsOf(criticalPaths)); // `cd server && npm run build` would fail on Vercel
  if (portalPkg.scripts) portalPkg.scripts = fixed.scripts;
  removedScripts.push(...fixed.dropped);
  portalPkg.dependencies = { ...(portalPkg.dependencies ?? {}), '@noble/post-quantum': NOBLE };
  const criticalPkg = {
    name: `${pkg.name || name}-critical`, version: pkg.version || '0.0.0', private: true,
    ...(pkg.type ? { type: pkg.type } : {}),
    ...(plan.mode === 'http' ? { main: plan.entry, scripts: { start: `node ${plan.entry}` } } : {}),
    dependencies: plan.deps.critical,
  };
  return { portalPkg, criticalPkg, removedScripts };
}

/** Generate the whole project layout inside `staging`. Returns manifest + notes. */
export async function buildOutput({ srcDir, files, plan, pkg, staging, appId, name, source, pq, now = new Date() }) {
  const P = path.join(staging, 'portal');
  const C = path.join(staging, 'critical');
  const K = path.join(staging, 'compact');
  await Promise.all([ensureDir(P), ensureDir(C), ensureDir(path.join(K, 'keys'), 0o700), ensureDir(path.join(K, 'deploy')), ensureDir(path.join(K, 'runtime')), ensureDir(path.join(K, 'receipts'))]);
  const notes = [];

  // 1. copy files to their side
  for (const f of files) {
    const side = plan.sideOf[f];
    if (side === 'portal' || side === 'conflict') await copyOut(srcDir, P, f);
    else if (side === 'critical') await copyOut(srcDir, C, f);
    else if (side === 'shared') { await copyOut(srcDir, P, f); await copyOut(srcDir, C, f); }
    else if (side === 'env') {
      const { pub, secret } = splitEnv(await fsp.readFile(path.join(srcDir, f), 'utf8'));
      if (pub) { await ensureDir(path.dirname(path.join(P, f))); await fsp.writeFile(path.join(P, f), pub); }
      if (secret) { await ensureDir(path.dirname(path.join(C, f))); await fsp.writeFile(path.join(C, f), secret, { mode: 0o600 }); notes.push(`${f}: secret values moved to critical/ only (VITE_* kept in portal)`); }
    } else if (side === 'special' && /package-lock|yarn\.lock|pnpm-lock|bun\.lock/.test(f)) notes.push(`${path.posix.basename(f)} not copied: dependencies changed, run your package manager again`);
  }

  // 2. stubs (rpc) or fetch interception (http)
  if (plan.mode === 'rpc') {
    for (const [file, names] of Object.entries(plan.rpc.allow)) {
      if (!names.length) continue;
      await ensureDir(path.dirname(path.join(P, file)));
      await fsp.writeFile(path.join(P, file), stubSource(file, file, names));
    }
  } else {
    const idx = plan.sideOf['index.html'] ? 'index.html' : null;
    const html = idx ? await fsp.readFile(path.join(P, idx), 'utf8') : null;
    const patched = html && patchIndexHtml(html);
    if (patched) await fsp.writeFile(path.join(P, idx), patched);
    else notes.push('Could not patch index.html: add <script type="module" src="/src/compact/install.mjs"></script> before your main script');
  }

  // 3. package.json files, .gitignore
  const derived = derivePackages({ pkg, plan, name });
  const { criticalPkg, removedScripts } = derived;
  // A Vite portal without a React plugin renders a blank page (JSX compiled without React). Generate vite.config.ts when missing.
  const rootFiles = (await fsp.readdir(P)).filter((n) => !n.startsWith('.'));
  const vite = await planViteConfig({ rootFiles, pkg: derived.portalPkg, readFile: (n) => fsp.readFile(path.join(P, n), 'utf8') });
  for (const f of vite.remove ?? []) await fsp.rm(path.join(P, f), { force: true });
  if (vite.write) await fsp.writeFile(path.join(P, vite.write.path), vite.write.content);
  notes.push(...vite.notes.map((n) => `portal: ${n}`));
  const portalPkg = vite.pkg;
  // FORCED_VITE_CONFIG: every portal gets this exact vite.config.ts at its root; the app's own config is kept as .orig
  const FORCED_VITE_CONFIG = "import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({\n  plugins: [react()],\n  build: {\n    outDir: 'dist',\n    sourcemap: true,\n  },\n});\n";
  for (const f of rootFiles.filter((x) => /^vite\.config\.(js|mjs|cjs|ts|mts|cts)$/.test(x))) await fsp.rename(path.join(P, f), path.join(P, f + '.orig')).catch(() => {});
  await fsp.writeFile(path.join(P, 'vite.config.ts'), FORCED_VITE_CONFIG);
  if (!portalPkg.devDependencies?.['@vitejs/plugin-react'] && !portalPkg.dependencies?.['@vitejs/plugin-react']) portalPkg.devDependencies = { ...(portalPkg.devDependencies ?? {}), '@vitejs/plugin-react': '^4.3.4' };
  await writeJson(path.join(P, 'package.json'), portalPkg);
  await writeJson(path.join(C, 'package.json'), criticalPkg);
  if (removedScripts.length) notes.push(`removed server scripts from portal/package.json: ${removedScripts.join(', ')}`);
  const gi = path.join(P, '.gitignore');
  const existingGi = await fsp.readFile(gi, 'utf8').catch(() => '');
  await fsp.writeFile(gi, `${existingGi.trimEnd()}\nnode_modules\ndist\n.env\n.env.local\n.vercel\n`.trimStart());

  // 4. runtime files
  const portalRt = portalRuntimeFiles(plan.mode);
  await ensureDir(path.join(P, 'src/compact'));
  for (const t of portalRt) await fsp.writeFile(path.join(P, 'src/compact', t), await readTemplate(t));
  for (const t of RUNNER_RUNTIME) await fsp.writeFile(path.join(K, 'runtime', t), await readTemplate(t));
  await writeJson(path.join(K, 'runtime/package.json'), { name: 'compact-runtime', private: true, type: 'module', dependencies: { '@noble/post-quantum': NOBLE } });

  // 5. keys, manifest, signature
  if (!pq) throw new CompactError('E_PQ_MISSING', 'Post-quantum library is not available.');
  const kem = pq.kem.keygen();
  const dsa = pq.dsa.keygen();
  const keyFile = {
    v: 1, algorithms: { kem: 'ml-kem-768', dsa: 'ml-dsa-65' }, createdAt: now.toISOString(),
    kem: { public: core.b64.enc(kem.publicKey), secret: core.b64.enc(kem.secretKey) },
    dsa: { public: core.b64.enc(dsa.publicKey), secret: core.b64.enc(dsa.secretKey) },
  };
  await writeJson(path.join(K, 'keys/runner.secret.json'), keyFile, { mode: 0o600 });
  await writeJson(path.join(K, 'keys/runner.public.json'), { kem: keyFile.kem.public, dsa: keyFile.dsa.public });

  const criticalFiles = await hashFiles(C, await walk(C, { ignoreFile: (r) => /(^|\/)\.env/.test(r) }));
  const portalFiles = await hashFiles(P, await walk(P, { ignoreFile: (r) => r.startsWith('src/compact/') }));
  const manifest = {
    v: 1, app: { id: appId, name }, mode: plan.mode, createdAt: now.toISOString(),
    crypto: { kex: 'x25519+ml-kem-768', sig: 'ml-dsa-65', aead: 'aes-256-gcm', kdf: 'hkdf-sha256' },
    critical: {
      treeHash: treeHash(criticalFiles), files: criticalFiles,
      entry: plan.entry ?? undefined,
      http: plan.mode === 'http' ? { prefixes: plan.proxyPrefixes, port: plan.port } : undefined,
      rpc: plan.mode === 'rpc' ? { allow: plan.rpc.allow } : undefined,
    },
    portal: { treeHash: treeHash(portalFiles) },
    runner: { kemPublic: keyFile.kem.public, dsaPublic: keyFile.dsa.public },
  };
  const sig = core.b64.enc(pq.dsa.sign(dsa.secretKey, core.utf8.enc(core.canonicalJson(manifest))));
  await writeJson(path.join(K, 'manifest.json'), manifest);
  await atomicWrite(path.join(K, 'manifest.sig'), `${sig}\n`);
  await writeJson(path.join(P, 'src/compact/manifest.json'), manifest);

  const connect = {
    v: 1, appId, mode: plan.mode, manifestSha256: core.hex(await core.manifestHash(manifest)),
    endpoint: `http://localhost:${RUNNER_PORT}`, verify: 'warn',
    near: { network: 'testnet', rpcUrls: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'], registryAccount: null },
    proxyPrefixes: plan.mode === 'http' ? plan.proxyPrefixes : undefined,
  };
  await writeJson(path.join(P, 'src/compact/connect.json'), connect);

  // 6. project-level files
  await writeJson(path.join(K, 'compact.config.json'), {
    v: 1, appId, name, mode: plan.mode, entry: plan.entry ?? undefined, port: plan.port ?? undefined,
    proxyPrefixes: plan.mode === 'http' ? plan.proxyPrefixes : undefined, runnerPort: RUNNER_PORT, source,
    createdAt: now.toISOString(),
  });
  await writeDeployFiles(K, plan);
  await writeWrappers(K);
  await fsp.writeFile(path.join(staging, '.gitignore'), 'compact/keys/\ncompact/receipts/\ncompact/data/\nnode_modules/\ncritical/.env*\n.env*\n');
  await fsp.writeFile(path.join(staging, 'README.compact.md'), readme({ name, plan }));
  return { manifest, connect, notes, keyFile: 'compact/keys/runner.secret.json' };
}

async function writeDeployFiles(K, plan) {
  const D = path.join(K, 'deploy');
  await fsp.writeFile(path.join(D, 'Dockerfile'), `# Build context: the project root (the folder that contains critical/ and compact/)
FROM node:22-slim
WORKDIR /app
COPY critical/package.json ./critical/
RUN cd critical && npm install --omit=dev
COPY compact/runtime/package.json ./compact/runtime/
RUN cd compact/runtime && npm install --omit=dev
COPY critical ./critical
COPY compact ./compact
ENV COMPACT_DIR=/app/compact COMPACT_CRITICAL_DIR=/app/critical PORT=${RUNNER_PORT} NODE_ENV=production
EXPOSE ${RUNNER_PORT}
CMD ["node", "compact/runtime/runner.mjs"]
`);
  await fsp.writeFile(path.join(D, 'docker-compose.yml'), `# For a TEE host such as dstack / Phala Cloud. Put COMPACT_KEYS_B64 in the host's encrypted/sealed secrets.
services:
  compact-runner:
    build:
      context: ../..
      dockerfile: compact/deploy/Dockerfile
    ports:
      - "${RUNNER_PORT}:${RUNNER_PORT}"
    environment:
      COMPACT_KEYS_B64: \${COMPACT_KEYS_B64}
      COMPACT_ALLOWED_ORIGINS: \${COMPACT_ALLOWED_ORIGINS:-*}
    restart: unless-stopped
`);
  await fsp.writeFile(path.join(D, '.env.example'), `# Generate the value with: compact keys <app> --b64
COMPACT_KEYS_B64=
# Restrict to your Vercel domain(s) in production, comma separated:
COMPACT_ALLOWED_ORIGINS=*
`);
  await fsp.writeFile(path.join(D, '.dockerignore'), 'compact/keys\ncompact/receipts\ncompact/data\n**/node_modules\nportal\n.env*\n');
  await fsp.writeFile(path.join(D, 'README.md'), `# Deploying the critical side

1. \`compact deploy\` anchors the manifest on NEAR testnet (receipts are saved in compact/receipts/).
2. Build and run the runner on a TEE host:
   - Local test: \`compact serve\`
   - TEE host: build with \`compact/deploy/Dockerfile\` (context = project root) and set the sealed secret
     \`COMPACT_KEYS_B64\` (print it with \`compact keys <app> --b64\`). Never put it in an image or a repo.
3. Tell the portal where it lives: \`compact deploy --endpoint https://your-runner.example.com\`
4. \`compact push\` publishes the portal to GitHub; import that repo in Vercel.

NEAR does not execute Node code: the registry on NEAR records what the runner must be; the runner itself runs on the TEE host.
`);
}

async function writeWrappers(K) {
  const wrap = (cmd) => `#!/usr/bin/env node
// Convenience wrapper: \`node compact/${cmd}.mjs [flags]\` runs \`compact ${cmd}\` for this project.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const r = spawnSync('compact', ['${cmd}', root, ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32' });
if (r.error) { console.error('Could not run "compact". Install it first: npm i -g @compact/cli'); process.exit(1); }
process.exit(r.status ?? 1);
`;
  for (const c of ['deploy', 'serve']) await fsp.writeFile(path.join(K, `${c}.mjs`), wrap(c), { mode: 0o755 });
}

const readme = ({ name, plan }) => `# ${name}: Compact project

\`\`\`
portal/    public half. Push this to GitHub and import it in Vercel.
critical/  private half (${plan.mode} mode). Never published. Runs behind the post-quantum channel.
compact/   manifest, keys (secret!), runtime, deploy files, receipts.
\`\`\`

Next steps
1. \`cd portal && npm install\`   (portal now depends on @noble/post-quantum)
2. \`compact serve\`              (runs critical/ locally on :${RUNNER_PORT}) then \`cd portal && npm run dev\`
3. \`compact deploy\`             (anchor on NEAR testnet, saves receipts)
4. \`compact push\`               (publish portal/ to GitHub, then import it in Vercel)

Secrets: compact/keys/runner.secret.json holds the runner's private keys. It is git-ignored; keep it that way.
`;

export { sha256Hex };
