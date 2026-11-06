import { formatNear } from '../near/account.mjs';

export function printPlan(ui, plan, { verbose = false } = {}) {
  const { c } = ui;
  ui.heading('Split plan');
  ui.kv([
    ['Mode', plan.mode === 'http' ? 'server: your backend runs behind the secure channel (HTTP over PQ)' : plan.mode === 'rpc' ? 'functions: marked modules are called remotely (RPC)' : 'none'],
    ['Entry', plan.entry],
    ['Port', plan.port],
    ['Proxied paths', plan.mode === 'http' ? plan.proxyPrefixes.join(', ') : undefined],
    ['Files', `${plan.counts.portal ?? 0} portal · ${plan.counts.critical ?? 0} critical · ${plan.counts.shared ?? 0} shared`],
  ]);
  const critical = Object.entries(plan.files).filter(([, v]) => v.side === 'critical');
  if (critical.length) {
    ui.blank();
    ui.line(c.bold('  Critical (never published)'));
    const shown = verbose ? critical : critical.slice(0, 12);
    for (const [f, v] of shown) ui.line(`    ${c.cyan(f)} ${c.dim(`— ${v.reasons[0] ?? ''}`)}`);
    if (shown.length < critical.length) ui.line(c.dim(`    … ${critical.length - shown.length} more (use --verbose)`));
  }
  if (plan.mode === 'rpc') {
    const rows = Object.entries(plan.rpc.allow).map(([m, fns]) => `    ${c.cyan(m)} ${c.dim('→')} ${fns.join(', ') || '(none)'}`);
    if (rows.length) { ui.blank(); ui.line(c.bold('  Functions exposed to the portal (least privilege)')); rows.forEach((r) => ui.line(r)); }
  }
  if (verbose) {
    const portal = Object.entries(plan.files).filter(([, v]) => v.side === 'portal');
    ui.blank(); ui.line(c.bold('  Portal')); portal.forEach(([f, v]) => ui.line(`    ${f} ${c.dim(`— ${v.reasons[0] ?? ''}`)}`));
  }
  printViolations(ui, plan);
}

export function printViolations(ui, plan) {
  const { c, g } = ui;
  if (plan.errors.length) {
    ui.blank(); ui.line(c.red(c.bold(`  ${plan.errors.length} problem(s) to fix`)));
    for (const e of plan.errors) { ui.line(`    ${c.red(g.fail)} ${e.file ? `${c.cyan(e.file)}: ` : ''}${e.message}`); if (e.hint) ui.line(`      ${c.dim(e.hint)}`); }
  }
  if (plan.warnings.length) {
    ui.blank(); ui.line(c.yellow(c.bold(`  ${plan.warnings.length} warning(s)`)));
    for (const w of plan.warnings.slice(0, 10)) { ui.line(`    ${c.yellow(g.warn)} ${w.file ? `${c.cyan(w.file)}: ` : ''}${w.message}`); if (w.hint) ui.line(`      ${c.dim(w.hint)}`); }
  }
}

export const planJson = (plan) => ({
  mode: plan.mode, entry: plan.entry, port: plan.port, proxyPrefixes: plan.proxyPrefixes, counts: plan.counts,
  files: plan.files, rpcAllow: plan.rpc.allow, errors: plan.errors, warnings: plan.warnings,
});

export function printReceipts(ui, receipts) {
  if (!receipts.length) { ui.line(ui.c.dim('  (no new transactions: everything was already up to date)')); return; }
  ui.table(['Step', 'Status', 'Gas burnt', 'Transaction'], receipts.map((r) => [r.name, r.ok ? ui.c.green('success') : ui.c.red('failed'), `${(Number(r.gasBurnt) / 1e12).toFixed(2)} Tgas`, r.explorer]));
}

export const near = (y) => `${formatNear(y, 4)} NEAR`;
