import { createPaint, shouldColor, padEnd, visibleLength, stripAnsi } from './ansi.mjs';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function glyphs(ascii) {
  return ascii
    ? { ok: 'OK', fail: 'x', warn: '!', arrow: '->', dot: '*', skip: '-', h: '-', v: '|', tl: '+', tr: '+', bl: '+', br: '+' }
    : { ok: '✔', fail: '✖', warn: '▲', arrow: '→', dot: '•', skip: '○', h: '─', v: '│', tl: '╭', tr: '╮', bl: '╰', br: '╯' };
}

const fmtMs = (ms) => (ms < 950 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * Terminal UI. Human text goes to stdout; with { json: true } nothing human is printed and
 * only ui.json(...) writes to stdout, so `compact ... --json | jq` always works.
 */
export class UI {
  constructor({ json = false, quiet = false, noColor = false, ascii = false, stream = process.stdout, errStream = process.stderr, env = process.env } = {}) {
    this.json_ = json;
    this.quiet = quiet || json;
    this.stream = stream;
    this.errStream = errStream;
    this.tty = !!stream.isTTY && !json;
    this.c = createPaint(shouldColor({ stream, env, noColor }));
    this.g = glyphs(ascii || env.COMPACT_ASCII === '1' || env.TERM === 'dumb');
    this.active = null;
    this.width = Math.min(stream.columns || 80, 100);
  }

  #write(s) { if (!this.quiet) this.stream.write(s); }
  line(text = '') { this.#write(`${text}\n`); }
  blank() { this.line(''); }
  heading(text) { this.blank(); this.line(this.c.bold(text)); }
  info(text) { this.line(`${this.c.cyan(this.g.dot)} ${text}`); }
  success(text) { this.line(`${this.c.green(this.g.ok)} ${text}`); }
  warn(text) { if (this.json_) return; this.errStream.write(`${this.c.yellow(this.g.warn)} ${text}\n`); }
  hint(text) { this.line(`  ${this.c.dim(text)}`); }
  json(obj) { this.stream.write(`${JSON.stringify(obj, null, 2)}\n`); }

  error(err, { debug = false } = {}) {
    if (this.json_) { this.errStream.write(`${JSON.stringify({ ok: false, error: err.toJSON?.() ?? { message: err.message } })}\n`); return; }
    this.errStream.write(`\n${this.c.red(`${this.g.fail} ${err.message}`)}\n`);
    if (err.code) this.errStream.write(`  ${this.c.dim(`code: ${err.code}`)}\n`);
    if (err.hint) this.errStream.write(`  ${this.c.yellow(this.g.arrow)} ${err.hint}\n`);
    if (Array.isArray(err.details) && err.details.length) for (const d of err.details.slice(0, 6)) this.errStream.write(`    ${this.c.dim(this.g.dot)} ${typeof d === 'string' ? d : JSON.stringify(d)}\n`);
    if (debug && err.stack) this.errStream.write(`\n${this.c.dim(err.stack)}\n`);
    this.errStream.write('\n');
  }

  kv(rows, { indent = 2 } = {}) {
    const w = Math.max(...rows.map(([k]) => k.length));
    for (const [k, v] of rows) if (v !== undefined && v !== null) this.line(`${' '.repeat(indent)}${this.c.dim(k.padEnd(w))}  ${v}`);
  }

  table(headers, rows) {
    const widths = headers.map((h, i) => Math.max(visibleLength(h), ...rows.map((r) => visibleLength(String(r[i] ?? '')))));
    this.line(`  ${headers.map((h, i) => this.c.bold(padEnd(h, widths[i]))).join('  ')}`);
    this.line(`  ${widths.map((w) => this.c.dim(this.g.h.repeat(w))).join('  ')}`);
    for (const r of rows) this.line(`  ${r.map((cell, i) => padEnd(String(cell ?? ''), widths[i])).join('  ')}`);
  }

  box(title, lines, { tone = 'cyan' } = {}) {
    const paint = this.c[tone] ?? ((s) => s);
    const inner = Math.min(this.width - 4, Math.max(visibleLength(title) + 2, ...lines.map((l) => visibleLength(l))));
    const { h, v, tl, tr, bl, br } = this.g;
    this.line(paint(`${tl}${h} ${title} ${h.repeat(Math.max(1, inner - visibleLength(title) - 1))}${tr}`));
    for (const l of lines) this.line(`${paint(v)} ${padEnd(l, inner)} ${paint(v)}`);
    this.line(paint(`${bl}${h.repeat(inner + 2)}${br}`));
  }

  /** Run `fn` as a visible step with spinner/timing. fn receives { update(text), warn(text) }. */
  async task(title, fn) {
    const start = Date.now();
    let text = title;
    let frame = 0;
    const draw = () => this.stream.write(`\r\u001b[2K${this.c.cyan(FRAMES[frame++ % FRAMES.length])} ${text}`);
    let timer;
    if (!this.quiet) {
      if (this.tty) { draw(); timer = setInterval(draw, 90); } else this.stream.write(`${this.g.arrow} ${title}\n`);
    }
    const stop = () => { if (timer) { clearInterval(timer); this.stream.write('\r\u001b[2K'); } };
    const handle = { update: (t) => { text = t; if (!this.tty && !this.quiet) this.stream.write(`  ${this.c.dim(stripAnsi(t))}\n`); }, warn: (t) => { stop(); this.warn(t); if (timer) timer = setInterval(draw, 90); } };
    try {
      const result = await fn(handle);
      stop();
      const note = result && typeof result === 'object' && result.__note ? ` ${this.c.dim(result.__note)}` : '';
      this.#write(`${this.c.green(this.g.ok)} ${title} ${this.c.dim(`(${fmtMs(Date.now() - start)})`)}${note}\n`);
      return result && result.__note !== undefined ? result.value : result;
    } catch (e) {
      stop();
      this.#write(`${this.c.red(this.g.fail)} ${title}\n`);
      throw e;
    }
  }
}

/** Returned by a task callback to attach a short note to the success line. */
export const withNote = (value, note) => ({ __note: note, value });

/** A UI that prints nothing (SDK / tests / web backend). Methods mirror UI. */
export function silentUI() {
  const ui = new UI({ json: true, stream: { isTTY: false, write() {}, columns: 80 }, errStream: { write() {} } });
  ui.json = () => {};
  return ui;
}
