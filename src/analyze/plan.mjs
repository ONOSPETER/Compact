import path from 'node:path';
import { parseSource, findFetchPrefixes } from './scan.mjs';
import {
  SOURCE_EXT, ASSET_RE, SERVER_FRAMEWORKS, SERVER_ONLY_LIBS, CRYPTO_LIBS, BROWSER_LIBS, SECRET_ENV_RE, SERVERISH_DIRS,
  packageName, isBare, isNodeBuiltin, NODE_ONLY_BUILTINS, matchesAny,
} from './rules.mjs';

const EXTS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json'];
export const isSourceFile = (f) => SOURCE_EXT.has(path.posix.extname(f));
const isEnvFile = (f) => /(^|\/)\.env(\..+)?$/.test(f) && !/\.example$|\.sample$/.test(f);
const isLockfile = (f) => /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(f);

function resolveLocal(from, spec, fileSet, root) {
  let base;
  if (spec.startsWith('@/') || spec.startsWith('~/')) base = path.posix.join('src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  else if (spec.startsWith('/')) base = spec.slice(1);
  else return null;
  for (const ext of EXTS) if (fileSet.has(base + ext)) return base + ext;
  for (const ext of EXTS.slice(1)) if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  // ESM TypeScript style: './x.js' that really is './x.ts'
  const noExt = base.replace(/\.(m|c)?js$/, '');
  if (noExt !== base) for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (fileSet.has(noExt + ext)) return noExt + ext;
  return null;
}

/**
 * Build the split plan.
 * @param {{files: string[], read: (f:string)=>string, pkg: object|null, config?: {critical?: string[], portal?: string[], proxyPrefixes?: string[], port?: number, entry?: string}}} input
 */
export function buildPlan({ files, read, pkg, config = {} }) {
  const fileSet = new Set(files);
  const info = new Map(); // file -> parse result + decisions
  const violations = [];
  const warn = (code, file, message, hint) => violations.push({ level: 'warning', code, file, message, hint });
  const fail = (code, file, message, hint) => violations.push({ level: 'error', code, file, message, hint });

  // 1. parse every source file and resolve local imports
  for (const f of files.filter(isSourceFile)) {
    let text;
    try { text = read(f); } catch { continue; }
    if (text.length > 1_500_000) { warn('W_SKIPPED_LARGE', f, 'File is very large; treated as a plain asset.'); continue; }
    const parsed = parseSource(text);
    const local = [];
    const bare = new Set();
    for (const imp of parsed.imports) {
      if (isBare(imp.spec)) bare.add(imp.spec);
      const target = resolveLocal(f, imp.spec, fileSet);
      if (target) local.push({ target, imp });
      else if (!isBare(imp.spec) && !/\.(css|svg|png|jpe?g|gif|webp|json|wasm)(\?.*)?$/i.test(imp.spec)) {
        warn('W_UNRESOLVED_IMPORT', f, `Could not resolve import "${imp.spec}".`, 'If it is a path alias, move the file manually or use --critical/--portal.');
      }
    }
    if (parsed.flags.dynamicNonLiteral) warn('W_DYNAMIC_IMPORT', f, 'Dynamic import/require with a non-literal path cannot be analysed.', 'Make sure the target stays on the same side.');
    info.set(f, { parsed, local, bare, importers: new Set(), side: null, reasons: [] });
  }
  for (const [f, i] of info) for (const { target } of i.local) info.get(target)?.importers.add(f);

  // 2. decide each source file from explicit overrides first, then signals
  for (const [f, i] of info) {
    const { parsed, bare } = i;
    const pk = [...bare].map(packageName);
    const builtins = [...bare].filter((s) => isNodeBuiltin(s));
    const fw = pk.filter((p) => SERVER_FRAMEWORKS.has(p));
    const serverLibs = pk.filter((p) => SERVER_ONLY_LIBS.has(p));
    const nodeOnly = builtins.filter((s) => NODE_ONLY_BUILTINS.has(s.replace(/^node:/, '')));
    const crypto = [...bare].filter((s) => CRYPTO_LIBS.has(packageName(s)) || /^(node:)?crypto$/.test(s));
    const browserLibs = pk.filter((p) => BROWSER_LIBS.has(p));
    const secrets = parsed.envRefs.filter((n) => SECRET_ENV_RE.test(n) && !n.startsWith('VITE_'));
    const dirHint = f.split('/').slice(0, -1).some((d) => SERVERISH_DIRS.has(d));

    const critical = [];
    if (fw.length) critical.push(`imports server framework (${fw.join(', ')})`);
    if (parsed.flags.listens) critical.push('starts a server (.listen)');
    if (serverLibs.length) critical.push(`imports server-only package (${serverLibs.slice(0, 3).join(', ')})`);
    if (nodeOnly.length) critical.push(`uses Node-only modules (${nodeOnly.slice(0, 3).join(', ')})`);
    if (secrets.length) critical.push(`reads secret env (${secrets.slice(0, 3).join(', ')})`);
    if (dirHint) critical.push('lives in a server/ or backend/ folder');
    const browser = [];
    if (browserLibs.length) browser.push(`imports UI library (${browserLibs.join(', ')})`);
    if (parsed.flags.browserGlobals) browser.push('uses browser globals (window/document/localStorage)');
    if (parsed.flags.importMetaEnv) browser.push('reads import.meta.env (Vite client env)');
    if (['.jsx', '.tsx'].includes(path.posix.extname(f)) && parsed.flags.jsx) browser.push('is a JSX component');
    const weak = crypto.length ? [`uses crypto (${crypto.slice(0, 3).join(', ')})`] : [];

    if (parsed.markers.critical || matchesAny(f, config.critical)) { i.side = 'critical'; i.reasons = ['marked critical']; }
    else if (parsed.markers.portal || matchesAny(f, config.portal)) { i.side = 'portal'; i.reasons = ['marked portal']; }
    else if (critical.length && browser.length) {
      i.side = 'conflict'; i.reasons = [...critical, ...browser];
      fail('E_CONFLICT', f, `Needs both sides: ${critical[0]} but also ${browser[0]}.`, 'Split the file, or force a side with --critical/--portal or an @compact-critical / @compact-portal comment.');
    } else if (critical.length) { i.side = 'critical'; i.reasons = critical; }
    else if (browser.length) { i.side = 'portal'; i.reasons = browser; }
    else if (weak.length) { i.side = 'critical'; i.reasons = weak; }
    else { i.side = 'neutral'; i.reasons = []; }
  }

  // 3. neutral files follow their importers (fixpoint: a helper used only by critical code is critical)
  for (let changed = true; changed;) {
    changed = false;
    for (const [f, i] of info) {
      if (i.side !== 'neutral') continue;
      const sides = [...i.importers].map((x) => info.get(x)?.side).filter((s) => s && s !== 'neutral' && s !== 'conflict');
      if (!i.importers.size || !sides.length) continue;
      if (sides.every((s) => s === 'critical')) { i.side = 'critical'; i.reasons = ['only used by critical code']; changed = true; }
      else if (sides.every((s) => s === 'portal' || s === 'shared')) { i.side = 'portal'; i.reasons = ['used by portal code']; changed = true; }
      else if (sides.includes('critical') && sides.includes('portal')) { i.side = 'shared'; i.reasons = ['used by both sides (copied to each)']; changed = true; }
    }
  }
  for (const i of info.values()) if (i.side === 'neutral') { i.side = 'portal'; i.reasons = ['no server signals (default)']; }

  // 4. mode, entry, port
  const criticalFiles = [...info].filter(([, i]) => i.side === 'critical').map(([f]) => f);
  const httpServers = criticalFiles.filter((f) => info.get(f).parsed.flags.listens || info.get(f).bare.size && [...info.get(f).bare].some((s) => SERVER_FRAMEWORKS.has(packageName(s))));
  let mode = 'none';
  let entry = null;
  let port = config.port ?? null;
  if (httpServers.length) {
    mode = 'http';
    const fromScripts = ['start', 'server', 'serve', 'start:server'].map((k) => /node\s+(?:--[\w-]+\s+)*([^\s&|;]+)/.exec(pkg?.scripts?.[k] ?? '')?.[1]).filter(Boolean).map((p) => path.posix.normalize(p.replace(/^\.\//, '')));
    entry = config.entry ?? fromScripts.find((p) => info.get(p)?.side === 'critical')
      ?? criticalFiles.filter((f) => info.get(f).parsed.flags.listens).sort((a, b) => a.split('/').length - b.split('/').length)[0]
      ?? criticalFiles.find((f) => /(^|\/)(server|app|index|main)\.[cm]?[jt]s$/.test(f));
    if (!entry) fail('E_NO_ENTRY', null, 'Found server code but no entry file that starts it.', 'Set it explicitly in compact.config.json ("entry") or pass --entry.');
    port = port ?? info.get(entry)?.parsed.flags.listenPort ?? 3001;
    if (entry && /\.tsx?$/.test(entry)) warn('W_TS_ENTRY', entry, 'The server entry is TypeScript; the runner needs plain JavaScript.', 'Compile it first (e.g. tsc/esbuild) or use a JS entry.');
  } else if (criticalFiles.length) mode = 'rpc';

  // 5. boundary checks
  const importedByPortal = new Map(); // critical file -> {names:Set, star:boolean}
  for (const [f, i] of info) {
    for (const { target, imp } of i.local) {
      const t = info.get(target);
      if (!t) continue;
      if (i.side === 'critical' && t.side === 'portal') {
        fail('E_CRITICAL_IMPORTS_PORTAL', f, `Critical file imports portal file ${target}.`, 'Mark that file critical/shared, or remove the dependency.');
      }
      if (i.side === 'portal' && t.side === 'critical') {
        if (mode === 'http') {
          fail('E_PORTAL_IMPORTS_SERVER', f, `Portal file imports server file ${target}.`, 'In server mode the portal can only reach the backend over HTTP (fetch).');
        } else {
          const e = importedByPortal.get(target) ?? { names: new Set(), star: false };
          for (const n of imp.names) e.names.add(n);
          if (imp.hasDefault) e.names.add('default');
          if (imp.star) e.star = true;
          importedByPortal.set(target, e);
        }
      }
    }
  }
  const rpc = { modules: {}, allow: {} };
  if (mode === 'rpc') {
    for (const [file, used] of importedByPortal) {
      const exps = info.get(file).parsed.exports;
      const fns = exps.filter((e) => e.kind === 'function').map((e) => e.name);
      const wanted = used.star ? fns : [...used.names];
      for (const n of wanted) {
        const e = exps.find((x) => x.name === n);
        if (!e) { warn('W_UNKNOWN_EXPORT', file, `Portal imports "${n}" but no such export was detected.`, 'Check the name, or the export style (re-exports are not followed).'); continue; }
        if (e.kind !== 'function') fail('E_NON_FUNCTION_EXPORT', file, `Export "${n}" is not a function, so it cannot cross the boundary.`, 'Only async/sync functions with JSON-serialisable arguments can be called remotely. Move constants to a shared file.');
      }
      rpc.allow[file] = wanted.filter((n) => exps.find((x) => x.name === n && x.kind === 'function'));
      rpc.modules[file] = exps;
    }
  }

  // 6. portal-side hygiene
  const prefixes = new Map();
  for (const [f, i] of info) {
    if (i.side !== 'portal' && i.side !== 'shared') continue;
    const leaked = i.parsed.envRefs.filter((n) => SECRET_ENV_RE.test(n) && !n.startsWith('VITE_'));
    if (leaked.length) fail('E_SECRET_IN_PORTAL', f, `Portal file reads secret-looking env var(s): ${leaked.join(', ')}.`, 'Anything in the portal is public. Move this code to the critical side.');
    if (i.parsed.flags.usesAxios) warn('W_AXIOS', f, 'axios uses XHR by default, which Compact cannot intercept.', "Use fetch, or set axios adapter to 'fetch'.");
    if (i.parsed.flags.usesCookies) warn('W_COOKIES', f, 'Cookie-based auth does not work across the secure channel in v1.', 'Use an Authorization header with a token held in memory/localStorage.');
    if (mode === 'http') {
      try { for (const [p, n] of findFetchPrefixes(read(f))) prefixes.set(p, (prefixes.get(p) || 0) + n); } catch { /* ignore */ }
    }
  }
  const proxyPrefixes = config.proxyPrefixes ?? (prefixes.size ? [...prefixes].sort((a, b) => b[1] - a[1]).map(([p]) => p) : ['/api']);
  if (mode === 'none') fail('E_NOTHING_CRITICAL', null, 'No critical code was found.', 'Mark files with an "// @compact-critical" comment or pass --critical "src/lib/auth.js".');

  // 7. non-source files
  const sideOf = {};
  const dirSides = new Map();
  for (const [f, i] of info) {
    const d = path.posix.dirname(f);
    const e = dirSides.get(d) ?? { critical: 0, portal: 0 };
    if (i.side === 'critical') e.critical++; else if (i.side === 'portal') e.portal++;
    dirSides.set(d, e);
  }
  for (const f of files) {
    if (info.has(f)) sideOf[f] = info.get(f).side;
    else if (f === 'package.json' || isLockfile(f)) sideOf[f] = 'special';
    else if (isEnvFile(f)) sideOf[f] = 'env';
    else if (ASSET_RE.test(f) || !f.includes('/') ) sideOf[f] = 'portal'; // root-level config (vite.config, index.html, ...)
    else {
      const e = dirSides.get(path.posix.dirname(f));
      sideOf[f] = e && e.critical > 0 && e.portal === 0 ? 'critical' : 'portal';
    }
  }

  // 8. dependencies
  const declared = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const used = { critical: new Set(), portal: new Set() };
  for (const [, i] of info) {
    const targets = i.side === 'critical' ? ['critical'] : i.side === 'shared' ? ['critical', 'portal'] : ['portal'];
    for (const s of i.bare) if (!isNodeBuiltin(s)) for (const t of targets) used[t].add(packageName(s));
  }
  const deps = {
    critical: Object.fromEntries([...used.critical].filter((n) => declared[n]).sort().map((n) => [n, declared[n]])),
    portalRemove: [...used.critical].filter((n) => declared[n] && !used.portal.has(n)),
  };

  const counts = { critical: 0, portal: 0, shared: 0, conflict: 0 };
  for (const i of info.values()) counts[i.side] = (counts[i.side] || 0) + 1;

  return {
    mode, entry, port, proxyPrefixes,
    files: Object.fromEntries([...info].map(([f, i]) => [f, { side: i.side, reasons: i.reasons }])),
    sideOf, rpc, deps, counts, violations,
    errors: violations.filter((v) => v.level === 'error'),
    warnings: violations.filter((v) => v.level === 'warning'),
    isVite: !!(pkg && (declared.vite || files.some((f) => /^vite\.config\./.test(f)))),
  };
}
