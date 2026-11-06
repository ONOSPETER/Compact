import { parseArgs } from 'node:util';
import fs from 'node:fs';
import { CompactError, EXIT, isCompactError } from '../errors.mjs';
import { UI } from '../ui/ui.mjs';
import { createContext } from '../context.mjs';
import { askSecret } from '../ui/prompt.mjs';
import { redact } from '../util/log.mjs';
import setup from './commands/setup.mjs';
import account from './commands/account.mjs';
import doctor from './commands/doctor.mjs';
import { analyzeCmd, transformCmd, deployCmd, pushCmd, shipCmd, serveCmd } from './commands/build.mjs';
import { appsCmd, statusCmd, keysCmd, forgetCmd } from './commands/manage.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;

export const GLOBAL = {
  json: { type: 'boolean', description: 'Machine-readable output (JSON on stdout, nothing else)' },
  quiet: { type: 'boolean', short: 'q', description: 'Only print errors' },
  yes: { type: 'boolean', short: 'y', description: 'Do not ask questions; accept defaults' },
  debug: { type: 'boolean', description: 'Print debug logs and stack traces' },
  'no-color': { type: 'boolean', description: 'Disable colors' },
  help: { type: 'boolean', short: 'h', description: 'Show help' },
  version: { type: 'boolean', short: 'v', description: 'Show version' },
};

const GROUPS = [
  ['Get started', [setup, doctor, account]],
  ['Build', [analyzeCmd, transformCmd, deployCmd, pushCmd, shipCmd, serveCmd]],
  ['Manage', [appsCmd, statusCmd, keysCmd, forgetCmd]],
];
export const COMMANDS = GROUPS.flatMap(([, c]) => c);

const lev = (a, b) => { const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
const find = (name) => COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
const toParseArgs = (opts) => Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, { type: v.type, ...(v.short ? { short: v.short } : {}), ...(v.multiple ? { multiple: true } : {}) }]));

function optionLines(ui, opts) {
  const rows = Object.entries(opts).map(([k, v]) => [`${v.short ? `-${v.short}, ` : '    '}--${k}${v.type === 'string' ? ' <value>' : ''}`, v.description ?? '']);
  const w = Math.max(...rows.map(([l]) => l.length));
  return rows.map(([l, d]) => `  ${ui.c.cyan(l.padEnd(w))}  ${d}`);
}

export function globalHelp(ui) {
  const { c } = ui;
  ui.line(`${c.bold('compact')} ${c.dim(`v${VERSION}`)}  split an app into a public portal and a post-quantum-hardened critical half, anchored on NEAR testnet`);
  ui.blank();
  ui.line(c.bold('USAGE'));
  ui.line('  compact <command> [options]');
  for (const [title, cmds] of GROUPS) {
    ui.blank(); ui.line(c.bold(title.toUpperCase()));
    const w = Math.max(...cmds.map((x) => x.name.length));
    for (const x of cmds) ui.line(`  ${c.cyan(x.name.padEnd(w))}  ${x.summary}`);
  }
  ui.blank(); ui.line(c.bold('GLOBAL OPTIONS')); optionLines(ui, GLOBAL).forEach((l) => ui.line(l));
  ui.blank(); ui.line(`${c.dim('Quick start:')}  compact setup  →  compact ship ./my-vite-app --wait`);
  ui.line(c.dim('Run `compact <command> --help` for details. Testnet only in v1.'));
}

export function commandHelp(ui, cmd) {
  const { c } = ui;
  ui.line(`${c.bold(cmd.usage)}\n`);
  ui.line(`  ${cmd.summary}`);
  if (Object.keys(cmd.options ?? {}).length) { ui.blank(); ui.line(c.bold('OPTIONS')); optionLines(ui, cmd.options).forEach((l) => ui.line(l)); }
  ui.blank(); ui.line(c.bold('GLOBAL OPTIONS')); optionLines(ui, GLOBAL).forEach((l) => ui.line(l));
  if (cmd.examples?.length) { ui.blank(); ui.line(c.bold('EXAMPLES')); cmd.examples.forEach((e) => ui.line(`  ${e}`)); }
}

/** Returns the process exit code. Never throws. */
export async function main(argv, { stdout = process.stdout, env = process.env } = {}) {
  const pre = parseArgs({ args: argv, options: toParseArgs(GLOBAL), strict: false, allowPositionals: true });
  const ui = new UI({ json: !!pre.values.json, quiet: !!pre.values.quiet, noColor: !!pre.values['no-color'], stream: stdout, env });
  const debug = !!pre.values.debug;
  try {
    let [name, ...rest] = pre.positionals;
    if (pre.values.version && !name) { stdout.write(`${VERSION}\n`); return EXIT.OK; }
    if (name === 'help') { name = rest[0]; if (!name) { globalHelp(ui); return EXIT.OK; } rest = ['--help']; argv = [name, '--help']; }
    if (!name) { globalHelp(ui); return pre.values.help ? EXIT.OK : EXIT.USAGE; }
    const cmd = find(name);
    if (!cmd) {
      const guess = COMMANDS.map((c) => [c.name, lev(name, c.name)]).sort((a, b) => a[1] - b[1])[0];
      throw new CompactError('E_UNKNOWN_COMMAND', `Unknown command "${name}".`, { hint: guess && guess[1] <= 3 ? `Did you mean "compact ${guess[0]}"?  (compact --help lists all commands)` : 'Run `compact --help` to see the commands.', exitCode: EXIT.USAGE });
    }
    let parsed;
    try {
      parsed = parseArgs({ args: argv.filter((a, i) => !(i === argv.indexOf(name) && a === name)), options: { ...toParseArgs(cmd.options ?? {}), ...toParseArgs(GLOBAL) }, allowPositionals: true, strict: true });
    } catch (e) {
      throw new CompactError('E_USAGE', e.message.replace(/ to treat it as a positional.*$/, ''), { hint: `See: compact ${cmd.name} --help`, exitCode: EXIT.USAGE });
    }
    if (parsed.values.help) { commandHelp(ui, cmd); return EXIT.OK; }
    if (Number(process.versions.node.split('.')[0]) < 20) throw new CompactError('E_NODE_VERSION', `Node ${process.version} is too old.`, { hint: 'Install Node 20 or newer.', exitCode: EXIT.ENV });

    const interactive = !!process.stdin.isTTY && !parsed.values.json;
    const abort = new AbortController();
    if (!cmd.handlesSignals) {
      let hits = 0;
      process.on('SIGINT', () => { if (++hits > 1) process.exit(EXIT.CANCELLED); abort.abort(); ui.warn('Cancelling… (press Ctrl+C again to force quit)'); });
    }
    const ctx = await createContext({ env, ui, debug, interactive, signal: abort.signal, askPassphrase: interactive ? () => askSecret('Deployer key passphrase: ') : undefined });
    const result = await cmd.run({ ctx, ui, values: parsed.values, positionals: parsed.positionals, flags: parsed.values });
    if (parsed.values.json && result && !result.silent) ui.json(JSON.parse(JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? v.toString() : v))));
    return result?.exitCode ?? (result?.cancelled ? EXIT.CANCELLED : EXIT.OK);
  } catch (err) {
    if (isCompactError(err)) { ui.error(err, { debug }); return err.exitCode; }
    ui.error(Object.assign(new CompactError('E_UNEXPECTED', `Unexpected error: ${redact(err?.message ?? err)}`, { hint: 'Re-run with --debug for details; logs are in ~/.compact/logs.' }), { stack: debug ? redact(err?.stack ?? '') : undefined }), { debug });
    return EXIT.FAIL;
  }
}
