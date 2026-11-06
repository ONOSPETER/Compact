import { CompactError, EXIT } from '../../errors.mjs';
import { getAccountInfo, formatNear, MIN_BALANCE } from '../../near/account.mjs';
import { ensureFunded } from '../../deploy/deploy.mjs';
import { confirm, askSecret } from '../../ui/prompt.mjs';
import { implicitAccountId } from '../../near/keys.mjs';

export default {
  name: 'account',
  aliases: ['acct'],
  summary: 'Deployer account: show, balance, export, import, list, use',
  usage: 'compact account [show|balance|export|import|list|use] [arg]',
  options: {
    wait: { type: 'boolean', description: 'balance: wait until the account is funded' },
    'no-passphrase': { type: 'boolean', description: 'import: store the key unencrypted' },
  },
  examples: ['compact account', 'compact account balance --wait', 'compact account export', 'compact account import ed25519:…'],
  async run({ ctx, ui, values, positionals, flags }) {
    const [sub = 'show', arg] = positionals;
    const defaultId = await ctx.keystore.getDefaultId();
    const need = () => { if (!defaultId) throw new CompactError('E_NO_DEPLOYER', 'No deployer account yet.', { hint: 'Run: compact setup', exitCode: EXIT.ENV }); return defaultId; };

    if (sub === 'list') {
      const rows = await ctx.keystore.list();
      ui.heading('Deployer accounts');
      if (!rows.length) ui.line('  (none) run: compact setup');
      else ui.table(['', 'Address', 'Encrypted', 'Created'], rows.map((r) => [r.isDefault ? '*' : '', r.accountId, r.encrypted ? 'yes' : 'no', r.createdAt.slice(0, 10)]));
      return { ok: true, accounts: rows };
    }
    if (sub === 'use') {
      if (!arg) throw new CompactError('E_USAGE', 'Which account? compact account use <address>', { exitCode: EXIT.USAGE });
      await ctx.keystore.setDefault(arg);
      ui.success(`Default deployer: ${arg}`);
      return { ok: true, default: arg };
    }
    if (sub === 'import') {
      const secret = arg ?? (ctx.interactive && !flags.yes ? await askSecret('Secret key (ed25519:…): ') : undefined);
      if (!secret) throw new CompactError('E_USAGE', 'Pass the secret key, or run interactively.', { exitCode: EXIT.USAGE });
      let passphrase;
      if (!values['no-passphrase'] && ctx.interactive && !flags.yes) { const p = await askSecret('Passphrase to encrypt it (Enter for none): '); if (p) passphrase = p; }
      const r = await ctx.keystore.importSecret(secret, { passphrase });
      ui.success(`Imported ${r.accountId}`);
      return { ok: true, accountId: r.accountId };
    }
    if (sub === 'export') {
      const id = need();
      if (ctx.interactive && !flags.yes && !(await confirm('Print the secret key on screen?', { fallback: false }))) return { ok: false, cancelled: true };
      const { secret } = await ctx.keystore.unlock(id, () => ctx.passphrase());
      ui.box('SECRET KEY: do not share', [`Address     ${id}`, `Secret key  ${secret}`], { tone: 'yellow' });
      return { ok: true, accountId: id, secretKey: secret };
    }
    if (sub === 'balance') {
      const id = need();
      const info = values.wait ? await ensureFunded(ctx, id, { wait: true }) : await getAccountInfo(ctx.rpc, id);
      ui.heading('Balance');
      ui.kv([['Address', id], ['Balance', `${formatNear(info.balance)} NEAR`], ['Status', info.balance >= MIN_BALANCE ? ui.c.green('ready to deploy') : ui.c.yellow(`needs ≥ ${formatNear(MIN_BALANCE, 2)} NEAR`)]]);
      return { ok: true, accountId: id, balance: info.balance.toString(), exists: info.exists };
    }
    if (sub !== 'show') throw new CompactError('E_USAGE', `Unknown subcommand "${sub}".`, { hint: 'Try: show, balance, export, import, list, use', exitCode: EXIT.USAGE });

    const id = need();
    const accounts = await ctx.keystore.list();
    const me = accounts.find((a) => a.accountId === id);
    const info = await getAccountInfo(ctx.rpc, id).catch(() => null);
    ui.heading('Deployer');
    ui.kv([['Address', id], ['Public key', me.publicKey], ['Network', 'NEAR testnet'], ['Key storage', me.encrypted ? 'encrypted (passphrase)' : 'plain file, mode 0600'], ['Balance', info ? `${formatNear(info.balance)} NEAR` : ui.c.dim('unknown (offline?)')]]);
    void implicitAccountId;
    return { ok: true, accountId: id, publicKey: me.publicKey, encrypted: me.encrypted, balance: info?.balance.toString() };
  },
};
