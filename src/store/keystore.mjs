import crypto from 'node:crypto';
import { readJson, writeJson, withLock } from '../util/fs.mjs';
import { CompactError, EXIT } from '../errors.mjs';
import { generateKeyPair, implicitAccountId, parseSecretKey, publicKeyString, secretKeyString } from '../near/keys.mjs';

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

function encrypt(secret, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, SCRYPT);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return {
    enc: 'scrypt-aes256gcm', params: { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
    salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64'),
  };
}

function decrypt(box, passphrase) {
  try {
    const key = crypto.scryptSync(passphrase, Buffer.from(box.salt, 'base64'), 32, { ...SCRYPT, ...box.params });
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]).toString('utf8');
  } catch {
    throw new CompactError('E_BAD_PASSPHRASE', 'Wrong passphrase (or the keystore entry is corrupted).', { exitCode: EXIT.USAGE });
  }
}

/**
 * Deployer accounts. Secrets are optionally encrypted with a passphrase (scrypt + AES-256-GCM).
 * File permissions are 0600. NEAR "implicit accounts" need no creation transaction: the account
 * id is the hex of the public key and it comes into existence when someone sends it NEAR.
 */
export class Keystore {
  constructor(paths) { this.file = paths.keystore; this.lock = `${paths.keystore}.lock`; }

  async #read() {
    const { value, recovered, backup } = await readJson(this.file, { schema: 1, default: null, accounts: {} });
    if (recovered) throw new CompactError('E_KEYSTORE_CORRUPT', `Keystore was unreadable; moved to ${backup}.`, {
      hint: 'Restore it from backup, or re-import your deployer key with: compact account import', exitCode: EXIT.ENV,
    });
    return value;
  }

  async list() {
    const ks = await this.#read();
    return Object.entries(ks.accounts).map(([id, a]) => ({
      accountId: id, publicKey: a.publicKey, createdAt: a.createdAt, encrypted: a.secret.enc !== 'none', isDefault: ks.default === id,
    }));
  }

  async getDefaultId() { return (await this.#read()).default; }

  /** Add (generate or import) an account. Returns the key pair so the caller can show the secret once. */
  async add({ keyPair = generateKeyPair(), passphrase, setDefault = true } = {}) {
    const accountId = implicitAccountId(keyPair.publicKey);
    const secretStr = secretKeyString(keyPair);
    return withLock(this.lock, async () => {
      const ks = await this.#read();
      if (ks.accounts[accountId]) throw new CompactError('E_ACCOUNT_EXISTS', `Account ${accountId} is already in the keystore.`, { exitCode: EXIT.USAGE });
      ks.accounts[accountId] = {
        publicKey: publicKeyString(keyPair.publicKey),
        createdAt: new Date().toISOString(),
        secret: passphrase ? encrypt(secretStr, passphrase) : { enc: 'none', value: secretStr },
      };
      if (setDefault || !ks.default) ks.default = accountId;
      await writeJson(this.file, ks, { mode: 0o600 });
      return { accountId, keyPair, secret: secretStr };
    });
  }

  async importSecret(secretStr, opts = {}) { return this.add({ keyPair: parseSecretKey(secretStr), ...opts }); }

  async setDefault(accountId) {
    return withLock(this.lock, async () => {
      const ks = await this.#read();
      if (!ks.accounts[accountId]) throw new CompactError('E_NO_ACCOUNT', `Unknown account ${accountId}.`, { exitCode: EXIT.USAGE });
      ks.default = accountId;
      await writeJson(this.file, ks, { mode: 0o600 });
    });
  }

  /** @param {() => Promise<string>} [askPassphrase] called only when the entry is encrypted */
  async unlock(accountId, askPassphrase) {
    const ks = await this.#read();
    const id = accountId || ks.default;
    const entry = id && ks.accounts[id];
    if (!entry) {
      throw new CompactError('E_NO_DEPLOYER', 'No deployer account found.', { hint: 'Run: compact setup', exitCode: EXIT.ENV });
    }
    let secret = entry.secret.value;
    if (entry.secret.enc !== 'none') {
      const pass = askPassphrase ? await askPassphrase() : undefined;
      if (!pass) throw new CompactError('E_PASSPHRASE_REQUIRED', 'This deployer key is encrypted and no passphrase was provided.', {
        hint: 'Set COMPACT_PASSPHRASE or run interactively.', exitCode: EXIT.USAGE,
      });
      secret = decrypt(entry.secret, pass);
    }
    return { accountId: id, keyPair: parseSecretKey(secret), secret };
  }
}
