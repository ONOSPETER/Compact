import crypto from 'node:crypto';
import { BorshWriter } from './borsh.mjs';
import { sign } from './keys.mjs';
import { encode as b58 } from './base58.mjs';

const ED25519 = 0;

function encodeAction(w, a) {
  switch (a.type) {
    case 'deployContract':
      w.u8(1).bytes(a.code);
      break;
    case 'functionCall':
      w.u8(2).string(a.methodName).bytes(a.args).u64(a.gas).u128(a.deposit ?? 0n);
      break;
    case 'transfer':
      w.u8(3).u128(a.deposit);
      break;
    default:
      throw new Error(`Unsupported action type: ${a.type}`);
  }
}

/** Borsh-encode an unsigned NEAR transaction. */
export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new BorshWriter();
  w.string(signerId).u8(ED25519).fixed(publicKey).u64(nonce).string(receiverId).fixed(blockHash).u32(actions.length);
  for (const a of actions) encodeAction(w, a);
  return w.toBuffer();
}

/** Sign a transaction. The result is deterministic for a given key and content. */
export function signTransaction(tx, keyPair) {
  const bytes = encodeTransaction(tx);
  const hash = crypto.createHash('sha256').update(bytes).digest();
  const signature = sign(keyPair, hash);
  const signed = new BorshWriter().fixed(bytes).u8(ED25519).fixed(signature).toBuffer();
  return { txHash: b58(hash), hashBytes: hash, signature, signedBase64: signed.toString('base64') };
}
