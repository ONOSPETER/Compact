import fs from 'node:fs';
import path from 'node:path';

const SECRET_PATTERNS = [
  /ed25519:[1-9A-HJ-NP-Za-km-z]{70,}/g, // NEAR secret keys (64 bytes in base58)
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Remove anything that looks like a secret from a string before it is logged or printed. */
export function redact(text) {
  let out = String(text);
  for (const re of SECRET_PATTERNS) out = out.replace(re, '«redacted»');
  return out;
}

/** Best-effort JSON-lines logger. Logging must never break a command. */
export function createLogger(logsDir, { debug = false, stream = process.stderr } = {}) {
  let file;
  try {
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    file = path.join(logsDir, `compact-${new Date().toISOString().slice(0, 10)}.log`);
  } catch { /* ignore */ }
  const write = (level, msg, data) => {
    let safe;
    try { safe = data ? JSON.parse(redact(JSON.stringify(data))) : undefined; } catch { safe = undefined; }
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg: redact(msg), data: safe });
    if (file) {
      try { fs.appendFileSync(file, line + '\n', { mode: 0o600 }); } catch { /* ignore */ }
    }
    if (debug) stream.write(`[debug] ${redact(msg)}\n`);
  };
  return {
    debug: (m, d) => write('debug', m, d),
    info: (m, d) => write('info', m, d),
    warn: (m, d) => write('warn', m, d),
    error: (m, d) => write('error', m, d),
    file,
  };
}

export const nullLogger = { debug() {}, info() {}, warn() {}, error() {}, file: undefined };
