import { CompactError, EXIT } from '../../errors.mjs';
import { getAccountInfo, MIN_BALANCE, formatNear } from '../../near/account.mjs';
import { ensureFunded } from '../../deploy/deploy.mjs';
import { withNote } from '../../ui/ui.mjs';
import { askSecret, confirm } from '../../ui/prompt.mjs';
import { GitHub } from '../../github/client.mjs';

export default {
  name: 'setup',
  summary: 'First-run wizard: deployer account, GitHub token, connectivity checks',
  usage: 'compact setup [options]',
  options: {
    'no-passphrase': { type: 'boolean', description: 'Store the deployer key without a passphrase (file mode 0600)' },
    'new-account': { type: 'boolean', description: 'Create another deployer even if one already exists' },
    'github-token': { type: 'string', description: 'GitHub token (prefer the GITHUB_TOKEN environment variable)' },
    'skip-github': { type: 'boolean', description: 'Do not ask for a GitHub token' },
    wait: { type: 'boolean', description: 'Wait until the deployer address has been funded' },
  },
  examples: ['compact setup', 'compact setup --no-passphrase --skip-github --yes   # non-interactive'],
  async run({ ctx, ui, values, flags }) {
    const interactive = ctx.interactive && !flags.yes;
    ui.heading('Compact setup');
    if (Number(process.versions.node.split('.')[0]) < 20) throw new CompactError('E_NODE_VERSION', `Node ${process.version} is too old.`, { hint: 'Install Node 20 or newer.', exitCode: EXIT.ENV });
    ui.success(`Node ${process.version}`);
    await ui.task('Reaching NEAR testnet', async () => { const s = await ctx.rpc.status(); return withNote(s, `block ${s.sync_info?.latest_block_height ?? '?'}`); });

    // ---- deployer account ----
    let created = null;
    if (!(await ctx.keystore.list()).length || values['new-account']) {
      let passphrase;
      if (!values['no-passphrase'] && interactive) {
        const p1 = await askSecret('Passphrase to encrypt the deployer key (Enter for none): ');
        if (p1) {
          if (p1 !== (await askSecret('Repeat passphrase: '))) throw new CompactError('E_PASSPHRASE_MISMATCH', 'Passphrases did not match.', { exitCode: EXIT.USAGE });
          passphrase = p1;
        }
      }
      created = await ctx.keystore.add({ passphrase });
      ui.success('Deployer account created');
      ui.box('SAVE THESE NOW', [
        `Address     ${created.accountId}`,
        `Secret key  ${created.secret}`,
        '',
        'The secret key is shown once. Anyone with it controls the account.',
        passphrase ? 'It is stored encrypted; you will need your passphrase to deploy.' : 'It is stored in ~/.compact/keystore.json (mode 0600), unencrypted.',
      ], { tone: 'yellow' });
      if (interactive) { if (!(await confirm('I saved the secret key somewhere safe', { fallback: false }))) throw new CompactError('E_NOT_SAVED', 'Setup stopped before you saved the key.', { hint: 'Run `compact account export` any time to see it again.', exitCode: EXIT.CANCELLED }); }
      else ui.warn('Non-interactive run: copy the secret key above now, it will not be printed again.');
    } else {
      ui.success('Deployer account already configured');
    }
    const id = created?.accountId ?? (await ctx.keystore.getDefaultId());

    // ---- funding ----
    const info = await getAccountInfo(ctx.rpc, id);
    if (info.exists && info.balance >= MIN_BALANCE) ui.success(`Deployer funded: ${formatNear(info.balance)} NEAR`);
    else {
      ui.box('Fund the deployer (testnet only, no real money)', [id, '', `Send at least ${formatNear(MIN_BALANCE, 2)} testnet NEAR to this address`, 'from a NEAR testnet faucet or another testnet account.', 'Check later with: compact account balance --wait']);
      if (values.wait) await ensureFunded(ctx, id, { wait: true });
    }

    // ---- GitHub ----
    let github = null;
    if (!values['skip-github']) {
      let token = values['github-token'] ?? (await ctx.credentials.githubToken(ctx.env))?.token;
      if (!token && interactive) token = (await askSecret('GitHub token (Enter to skip; needed for `push` and private repos): ')).trim();
      if (token) {
        github = await ui.task('Checking GitHub token', async () => { const u = await new GitHub({ token, fetchImpl: ctx.fetch, logger: ctx.logger }).user(); return withNote(u, `@${u.login}`); });
        if (!ctx.env.GITHUB_TOKEN && !ctx.env.COMPACT_GITHUB_TOKEN) await ctx.credentials.saveGithub({ token, user: github.login });
      } else ui.info('GitHub: skipped (add later with `compact setup`)');
    }

    await ctx.configStore.save({ setupComplete: true });
    ui.heading('Ready');
    ui.line('  Try it:  compact analyze ./my-vite-app');
    ui.line('           compact ship ./my-vite-app');
    return { ok: true, deployer: id, created: !!created, secretKey: created?.secret, github: github?.login ?? null, funded: info.balance >= MIN_BALANCE };
  },
};
