import { BROWSER_GLOBALS_RE } from './rules.mjs';

const STRING_OR_COMMENT = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;

/** Remove comments but keep string literals intact (so URLs containing // survive). */
export function stripComments(src) {
  return src.replace(STRING_OR_COMMENT, (m, str) => (str ? m : ' '));
}

function parseClause(clause) {
  const c = clause.trim();
  if (/^type\s/.test(c)) return null; // TypeScript type-only import: erased at build time
  const names = [];
  const braces = /\{([^}]*)\}/.exec(c);
  if (braces) {
    for (const part of braces[1].split(',')) {
      const t = part.trim();
      if (/^type\s/.test(t)) continue; // inline type specifier: erased at build time
      const n = t.split(/\s+as\s+/)[0].trim();
      if (n) names.push(n);
    }
  }
  const star = /\*\s*as\s+\w+/.test(c);
  const head = c.replace(/\{[^}]*\}/, '').replace(/\*\s*as\s+\w+/, '').replace(/,/g, '').trim();
  return { names, star, hasDefault: head.length > 0 };
}

const looksLikeFunction = (rest) => /^\s*(?:async\s*)?(?:\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(rest);
const declaresFunction = (src, name) =>
  new RegExp(`(?:function\\s*\\*?\\s*${name}\\s*\\(|(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\(|function\\b|[A-Za-z_$][\\w$]*\\s*=>))`).test(src);

/** Extract what the planner needs from one source file, using regexes over comment-free text. */
export function parseSource(raw) {
  const src = stripComments(raw);
  const imports = [];
  let m;

  const importRe = /\bimport\s+(?:([^'"();]*?)\s+from\s*)?['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(src))) {
    const clause = m[1] ? parseClause(m[1]) : { names: [], star: false, hasDefault: false, sideEffect: true };
    if (clause) imports.push({ spec: m[2], ...clause, kind: 'import' });
  }
  const reexportRe = /\bexport\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = reexportRe.exec(src))) imports.push({ spec: m[1], names: [], star: true, hasDefault: false, kind: 'reexport' });
  const requireRe = /(?:(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*)?\brequire\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = requireRe.exec(src))) {
    const destructured = m[1]?.startsWith('{') ? m[1].slice(1, -1).split(',').map((s) => s.split(':')[0].trim()).filter(Boolean) : [];
    imports.push({ spec: m[2], names: destructured, star: !destructured.length, hasDefault: false, kind: 'require' });
  }
  const dynRe = /\bimport\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = dynRe.exec(src))) imports.push({ spec: m[2], names: [], star: true, hasDefault: false, kind: 'dynamic' });
  const dynamicNonLiteral = /\b(?:import|require)\(\s*[^'"\s)]/.test(src);

  const exports = [];
  const seen = new Set();
  const add = (name, kind) => { if (!seen.has(name)) { seen.add(name); exports.push({ name, kind }); } };
  const fnRe = /\bexport\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
  while ((m = fnRe.exec(src))) add(m[1], 'function');
  const constRe = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?=([\s\S]{0,80}))/g;
  while ((m = constRe.exec(src))) add(m[1], looksLikeFunction(m[2]) ? 'function' : 'value');
  const defRe = /\bexport\s+default\s+(?=([\s\S]{0,60}))/g;
  while ((m = defRe.exec(src))) add('default', /^(?:async\s+)?function\b/.test(m[1]) || looksLikeFunction(m[1]) ? 'function' : 'value');
  const listRe = /\bexport\s*\{([^}]*)\}(?!\s*from)/g;
  while ((m = listRe.exec(src))) {
    for (const part of m[1].split(',')) {
      const [local, exported] = part.trim().split(/\s+as\s+/);
      if (local) add((exported || local).trim(), declaresFunction(src, local.trim()) ? 'function' : 'value');
    }
  }
  const cjsRe = /\b(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=(?=([\s\S]{0,80}))/g;
  while ((m = cjsRe.exec(src))) add(m[1], looksLikeFunction(m[2]) ? 'function' : declaresFunction(src, m[1]) ? 'function' : 'value');
  const cjsObj = /\bmodule\.exports\s*=\s*\{([^}]*)\}/.exec(src);
  if (cjsObj) {
    for (const part of cjsObj[1].split(',')) {
      const key = part.trim().split(':')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(key)) add(key, declaresFunction(src, key) ? 'function' : 'value');
    }
  }

  const envRefs = new Set();
  for (const re of [/process\.env\.([A-Z0-9_]+)/g, /process\.env\[['"]([A-Z0-9_]+)['"]\]/g, /import\.meta\.env\.([A-Z0-9_]+)/g]) {
    while ((m = re.exec(src))) envRefs.add(m[1]);
  }
  const listen = /\.listen\(\s*(?:process\.env\.PORT\s*(?:\|\||\?\?)\s*)?(\d{2,5})?/.exec(src);

  return {
    imports,
    exports,
    envRefs: [...envRefs],
    flags: {
      browserGlobals: BROWSER_GLOBALS_RE.test(src),
      importMetaEnv: /import\.meta\.env/.test(src),
      listens: !!listen,
      listenPort: listen?.[1] ? Number(listen[1]) : null,
      dynamicNonLiteral,
      usesCookies: /document\.cookie|credentials\s*:\s*['"]include['"]/.test(src),
      usesAxios: /from\s*['"]axios['"]|require\(\s*['"]axios['"]\s*\)/.test(src),
      jsx: /<\/?[A-Z][\w.]*[\s/>]/.test(src) || /<\/\w+>/.test(src),
    },
    markers: {
      critical: /@compact[-:]critical\b/.test(raw.slice(0, 400)),
      portal: /@compact[-:]portal\b/.test(raw.slice(0, 400)),
    },
  };
}

/** Same-origin path prefixes the portal fetches (e.g. /api). */
export function findFetchPrefixes(raw) {
  const out = new Map();
  const src = stripComments(raw);
  const bump = (p) => out.set(p, (out.get(p) || 0) + 1);
  let m;
  const a = /\b(?:fetch|axios(?:\.\w+)?|\$\.(?:get|post|ajax))\(\s*['"`](\/[A-Za-z0-9_-]+)(?=[/?'"`$])/g;
  while ((m = a.exec(src))) bump(m[1]);
  const b = /baseURL\s*:\s*['"`](\/[A-Za-z0-9_-]+)/g;
  while ((m = b.exec(src))) bump(m[1]);
  return out;
}
