// Applies the Compact fix pack to this repo. Safe to run twice. Run from the repo root (the folder with src/).
import fs from 'node:fs';
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const say = (m) => console.log(m);
let problems = 0;

function edit(file, label, fn) {
  const s = read(file);
  if (s === null) { say(`  ! ${file} not found (${label})`); problems++; return; }
  const r = fn(s);
  if (r === 'done') return say(`  = ${label}: already applied`);
  if (r === null) { say(`  ! ${label}: anchor not found in ${file}. Send me:  grep -n "portalPkg\\|pkg.scripts" ${file}`); problems++; return; }
  fs.writeFileSync(file, r); say(`  + ${label}`);
}

// 1. Vercel build fix, at transform time and at push time (covers apps transformed before this fix)
edit('src/transform/build.mjs', 'transform drops `cd server` build steps', (s) => {
  if (s.includes("dropServerSteps")) return 'done';
  const imp = "import { planViteConfig } from './viteconfig.mjs';";
  const anchor = "  portalPkg.dependencies = { ...(portalPkg.dependencies ?? {}), '@noble/post-quantum': NOBLE };\n  const criticalPkg";
  if (!s.includes(imp) || !s.includes(anchor)) return null;
  return s.replace(imp, `${imp}\nimport { dropServerSteps, serverDirsOf } from './scripts.mjs';`)
    .replace(anchor, `  const fixed = dropServerSteps(portalPkg.scripts, serverDirsOf(criticalPaths)); // \`cd server && npm run build\` would fail on Vercel\n  if (portalPkg.scripts) portalPkg.scripts = fixed.scripts;\n  removedScripts.push(...fixed.dropped);\n${anchor}`);
});
edit('src/deploy/vercel.mjs', 'push drops `cd server` build steps', (s) => {
  if (s.includes("dropServerSteps")) return 'done';
  const imp = "import { planViteConfig } from '../transform/viteconfig.mjs';";
  const anchor = "  if (!pkg.scripts?.build) pkg.scripts";
  if (!s.includes(imp) || !s.includes(anchor)) return null;
  return s.replace(imp, `${imp}\nimport { dropServerSteps, serverDirsOf } from '../transform/scripts.mjs';`)
    .replace(anchor, `  if (pkg.scripts) pkg.scripts = dropServerSteps(pkg.scripts, serverDirsOf(await walk(d.critical, { ignoreFile: isRealEnv }))).scripts; // apps built before this fix still ship a \`cd server\` build\n${anchor}`);
});

// 2. Two old tests expected the app's own vite.config to stay; the forced config replaced that rule (new tests are in test/server-steps.test.mjs)
edit('test/viteconfig.test.mjs', 'remove two outdated vite tests', (s) => {
  let out = s; let n = 0;
  for (const start of ["test('an existing config is never overwritten", "test('transform keeps the app’s own vite.config.js untouched"]) {
    const a = out.indexOf(start); if (a === -1) continue;
    const b = out.indexOf('\ntest(', a + 5);
    out = out.slice(0, a) + (b === -1 ? '' : out.slice(b + 1)); n++;
  }
  return n ? out : 'done';
});

// 3. Replit: "Could not find run command" means .replit has no [deployment] section
edit('.replit', 'add [deployment] run command', (s) => {
  if (/^\[deployment\]/m.test(s)) return 'done';
  return `${s.trimEnd()}

[deployment]
deploymentTarget = "cloudrun"
build = ["sh", "-c", "npm install && npm --prefix ui install && npm --prefix ui run build"]
run = ["sh", "-c", "COMPACT_UI_HOST=0.0.0.0 COMPACT_UI_PORT=3001 node src/ui-server/server.mjs"]
`;
});

// 4. Keep generated projects (they contain runner keys) and local files out of the public repo
{
  const want = ['node_modules/', 'ui/dist/', '.env', '.env.*', '!.env.example', '*.zip', '*.patch', '', '# Generated Compact projects hold runner keys: never commit them', 'test1-compact/', 'test2-compact/', 'test3-compact/', 'compact2-compact/', 'compact-test2-compact/', '**/compact/keys/', '*.staging-*/'];
  const cur = read('.gitignore') ?? '';
  const have = new Set(cur.split('\n').map((l) => l.trim()));
  const add = want.filter((l) => l === '' || !have.has(l));
  if (add.filter(Boolean).length) { fs.writeFileSync('.gitignore', `${cur.trimEnd()}${cur.trim() ? '\n' : ''}${add.join('\n')}\n`); say('  + .gitignore updated'); } else say('  = .gitignore: already applied');
}

// 5. The two earlier patch files are applied already; they should not be in the public repo
for (const f of ['vite-config-fix.patch', 'vault-diagnose.patch']) if (fs.existsSync(f)) { fs.rmSync(f); say(`  - removed ${f}`); }

say(problems ? `\nDone with ${problems} problem(s) above.` : '\nAll edits applied. Next: node --test   (then restart the UI server and re-run Transform + Push).');
process.exitCode = problems ? 1 : 0;
