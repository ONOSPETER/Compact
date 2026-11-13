// The server half of an app moves to critical/, so any portal script that still builds or starts it by changing into
// its folder (`cd server && npm install && npm run build`) fails on Vercel: tsc finds no inputs (TS18003).
// dropServerSteps removes those scripts and the references to them, and never touches anything else.
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Segments of an `a && b && c` chain that do not run inside the server folder (after `cd server` everything is server until `cd ..`). */
function withoutServerSegments(cmd, touches) {
  let inServer = false;
  return cmd.split(/\s*&&\s*/).filter((seg) => {
    const t = seg.trim();
    if (/^cd\s+\.\.\/?$/.test(t)) { inServer = false; return false; }
    if (touches.test(t)) { if (/^cd\s/.test(t)) inServer = true; return false; }
    return !inServer;
  });
}

/** Top-level folders that hold critical code (never `src`: that is where the portal lives too). */
export function serverDirsOf(paths) {
  return [...new Set(paths.filter((p) => p.includes('/')).map((p) => p.split('/')[0]))].filter((d) => !['src', 'public', 'node_modules'].includes(d));
}

/** @returns {{ scripts: object, dropped: string[], changed: string[] }} */
export function dropServerSteps(scripts = {}, dirs = []) {
  const out = { ...scripts };
  const dropped = []; const changed = [];
  if (!dirs.length) return { scripts: out, dropped, changed };
  const touches = new RegExp(`(?:\\bcd|--prefix|--cwd|\\s-C)\\s+(?:\\./)?(?:${dirs.map(esc).join('|')})(?:/|\\s|$|&|;|"|')`);
  const drop = (name) => { dropped.push(name); delete out[name]; };
  for (const [k, v] of Object.entries(out)) {
    if (!touches.test(v)) continue;
    if (k !== 'build') { drop(k); continue; } // `build` itself is never deleted: keep its non-server steps, or fall back to vite build
    out.build = withoutServerSegments(v, touches).join(' && ').trim() || 'vite build'; changed.push('build');
  }
  for (let pass = 0; pass < 3 && dropped.length; pass++) {
    const refs = dropped.map(esc).join('|');
    const seg = new RegExp(`^(?:npm|pnpm|yarn)\\s+(?:run\\s+)?(?:${refs})(?:\\s|$)`);
    const quoted = new RegExp(`\\s*(["'])(?:npm|pnpm|yarn)\\s+(?:run\\s+)?(?:${refs})\\1`, 'g');
    let moved = false;
    for (const [k, v] of Object.entries(out)) {
      const parts = v.split(/\s*&&\s*/).filter((p) => !seg.test(p.trim()) && !/^cd\s+\.\.?\/?$/.test(p.trim()));
      let nv = parts.join(' && ').replace(quoted, '').trim();
      if (nv === v) continue;
      changed.push(k);
      if (!nv || /^concurrently$/.test(nv)) { if (k === 'build') nv = 'vite build'; else { drop(k); moved = true; continue; } }
      out[k] = nv;
    }
    if (!moved) break;
  }
  return { scripts: out, dropped, changed: [...new Set(changed)] };
}
