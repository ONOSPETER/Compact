import crypto from 'node:crypto';
import { encode, decode } from './base58.mjs';
import { CompactError, EXIT } from '../errors.mjs';

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** Build a key pair from a 32-byte seed. */
export function fromSeed(seed) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
  return { seed: Buffer.from(seed), publicKey: Buffer.from(jwk.x, 'base64url'), privateKey };
}

export const generateKeyPair = () => fromSeed(crypto.randomBytes(32));

export const publicKeyString = (pub) => `ed25519:${encode(pub)}`;
export const secretKeyString = (kp) => `ed25519:${encode(Buffer.concat([kp.seed, kp.publicKey]))}`;

/** On NEAR, an "implicit account" id is the hex of the ed25519 public key. */
export const implicitAccountId = (pub) => Buffer.from(pub).toString('hex');

export function parseSecretKey(str) {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(String(str).trim());
  if (!m) {
    throw new CompactError('E_KEY_FORMAT', 'That does not look like a NEAR secret key.', {
      hint: 'Expected: ed25519:<base58>.', exitCode: EXIT.USAGE,
    });
  }
  const raw = decode(m[1]);
  if (raw.length !== 64 && raw.length !== 32) {
    throw new CompactError('E_KEY_FORMAT', 'Secret key has the wrong length.', { exitCode: EXIT.USAGE });
  }
  const kp = fromSeed(raw.subarray(0, 32));
  if (raw.length === 64 && !raw.subarray(32).equals(kp.publicKey)) {
    throw new CompactError('E_KEY_MISMATCH', 'Secret key is corrupted (public part does not match).', { exitCode: EXIT.USAGE });
  }
  return kp;
}

export const sign = (kp, message) => crypto.sign(null, message, kp.privateKey);

export function verify(publicKeyRaw, message, signature) {
  const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519, publicKeyRaw]), format: 'der', type: 'spki' });
  return crypto.verify(null, message, key, signature);
}
