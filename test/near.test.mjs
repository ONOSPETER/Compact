import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encode, decode } from '../src/near/base58.mjs';
import { generateKeyPair, parseSecretKey, secretKeyString, publicKeyString, implicitAccountId, verify } from '../src/near/keys.mjs';
import { signTransaction, encodeTransaction } from '../src/near/tx.mjs';
import { buildRegistryWasm, registryKey } from '../src/near/registry.mjs';
import { NearRpc } from '../src/near/rpc.mjs';
import { formatNear } from '../src/near/account.mjs';

test('base58 round trips and keeps leading zeros', () => {
  for (const hex of ['00', '0000ff', '', 'deadbeef', '00'.repeat(5) + '01']) {
    const buf = Buffer.from(hex, 'hex');
    assert.deepEqual(decode(encode(buf)), buf);
  }
  assert.equal(encode(Buffer.from([0, 0, 1])), '112');
  assert.throws(() => decode('0OIl'));
});

test('keys: generate, serialize, parse, sign/verify', () => {
  const kp = generateKeyPair();
  const secret = secretKeyString(kp);
  assert.match(secret, /^ed25519:/);
  const again = parseSecretKey(secret);
  assert.ok(again.publicKey.equals(kp.publicKey));
  assert.equal(implicitAccountId(kp.publicKey).length, 64);
  assert.ok(publicKeyString(kp.publicKey).startsWith('ed25519:'));
  const sig = crypto.sign(null, Buffer.from('hi'), kp.privateKey);
  assert.ok(verify(kp.publicKey, Buffer.from('hi'), sig));
  assert.throws(() => parseSecretKey('nope'), /NEAR secret key/);
});

test('transaction encoding has the expected borsh layout and a valid signature', () => {
  const kp = generateKeyPair();
  const tx = {
    signerId: 'alice.testnet', publicKey: kp.publicKey, nonce: 7n, receiverId: 'bob.testnet',
    blockHash: Buffer.alloc(32, 1), actions: [{ type: 'transfer', deposit: 10n ** 24n }],
  };
  const bytes = encodeTransaction(tx);
  // 4+13 signer, 1+32 key, 8 nonce, 4+11 receiver, 32 hash, 4 actions len, 1+16 transfer
  assert.equal(bytes.length, 17 + 33 + 8 + 15 + 32 + 4 + 17);
  const signed = signTransaction(tx, kp);
  const raw = Buffer.from(signed.signedBase64, 'base64');
  assert.equal(raw.length, bytes.length + 1 + 64);
  assert.ok(verify(kp.publicKey, signed.hashBytes, signed.signature));
  assert.equal(signTransaction(tx, kp).txHash, signed.txHash); // deterministic
});

// --- registry contract, executed against a mock NEAR host -------------------------------
function mockHost(wasm) {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const registers = new Map();
  const storage = new Map();
  let ret = null;
  const MAX = 0xffffffffffffffffn;
  const mem = () => new Uint8Array(memory.buffer);
  const bytes = (rawLen, ptr) => { const len = BigInt.asUintN(64, rawLen); return len === MAX ? Buffer.from(registers.get(ptr) ?? (() => { throw new Error('bad register'); })()) : Buffer.from(mem().slice(Number(ptr), Number(ptr + len))); };
  const imports = {
    env: {
      memory,
      input: (r) => registers.set(r, host.input),
      register_len: (r) => BigInt(registers.get(r)?.length ?? MAX),
      read_register: (r, p) => mem().set(registers.get(r), Number(p)),
      storage_write: (kl, kp, vl, vp, r) => { storage.set(bytes(kl, kp).toString('hex'), bytes(vl, vp)); return 0n; },
      storage_read: (kl, kp, r) => { const v = storage.get(bytes(kl, kp).toString('hex')); if (!v) return 0n; registers.set(r, v); return 1n; },
      value_return: (l, p) => { ret = bytes(l, p); },
      panic: () => { throw new Error('contract panic'); },
    },
  };
  const host = { input: Buffer.alloc(0), storage };
  return WebAssembly.instantiate(wasm, imports).then(({ instance }) => ({
    call(method, input) { host.input = Buffer.from(input); ret = null; registers.clear(); instance.exports[method](); return ret; },
    storage,
  }));
}

test('registry wasm validates and behaves: set, get, overwrite, missing key, short input', async () => {
  const wasm = buildRegistryWasm();
  assert.ok(WebAssembly.validate(wasm));
  assert.ok(wasm.length < 400);
  const c = await mockHost(wasm);
  const key = registryKey('my-app');
  c.call('set', Buffer.concat([key, Buffer.from('{"v":1}')]));
  assert.equal(c.call('get', key).toString(), '{"v":1}');
  c.call('set', Buffer.concat([key, Buffer.from('{"v":2}')]));
  assert.equal(c.call('get', key).toString(), '{"v":2}');
  assert.throws(() => c.call('get', registryKey('other')), /panic/);
  assert.throws(() => c.call('set', key), /panic/); // no value
  assert.throws(() => c.call('set', Buffer.alloc(70000, 1)), /panic/); // too large for one page
});

test('rpc fails over to the next endpoint and retries transient errors', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('bad')) return { status: 503, json: async () => ({}) };
    return { status: 200, json: async () => ({ result: { ok: true } }) };
  };
  const rpc = new NearRpc({ urls: ['https://bad.example', 'https://good.example'], fetchImpl, attempts: 2 });
  assert.deepEqual(await rpc.call('status', []), { ok: true });
  assert.equal(rpc.urls[0], 'https://good.example'); // remembered
  const rpc2 = new NearRpc({ urls: ['https://bad.example'], fetchImpl, attempts: 1 });
  await assert.rejects(() => rpc2.call('status', []), (e) => e.code === 'E_RPC_UNREACHABLE');
});

test('rpc maps unknown account to null and surfaces other errors', async () => {
  const fetchImpl = async (url, init) => {
    const { params } = JSON.parse(init.body);
    if (params.account_id === 'ghost') return { status: 200, json: async () => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'x', data: 'account ghost does not exist' } }) };
    return { status: 200, json: async () => ({ result: { amount: '5', code_hash: '1'.repeat(32), storage_usage: 1 } }) };
  };
  const rpc = new NearRpc({ urls: ['https://x'], fetchImpl });
  assert.equal(await rpc.viewAccount('ghost'), null);
  assert.equal((await rpc.viewAccount('real')).amount, '5');
});

test('formatNear', () => {
  assert.equal(formatNear(10n ** 24n), '1.0000');
  assert.equal(formatNear(1234500000000000000000000n), '1.2345');
  assert.equal(formatNear(0n), '0.0000');
});
