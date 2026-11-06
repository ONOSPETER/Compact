export const stripAnsi = (s) => String(s).replace(/\u001b\[[0-9;]*m/g, '');
export const visibleLength = (s) => stripAnsi(s).length;

export function shouldColor({ stream = process.stdout, env = process.env, noColor = false } = {}) {
  if (noColor || env.NO_COLOR) return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== '0') return true;
  return !!stream.isTTY && env.TERM !== 'dumb';
}

export function createPaint(enabled) {
  const wrap = (open, close) => (s) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : String(s));
  return {
    bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39),
    blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
  };
}

export const padEnd = (s, n) => s + ' '.repeat(Math.max(0, n - visibleLength(s)));
