// On-chain registry without a Rust toolchain.
//
// The contract is a ~300 byte WebAssembly module assembled here, so Compact can deploy it
// from any machine. It exposes two methods:
//   set(input = key[32] || value[..])  -> storage[key] = value
//   get(input = key[32])               -> returns storage[key] (panics if absent)
// Key = sha256(appId). Value = UTF-8 JSON record. Only the account itself can call `set`
// because the contract lives on the deployer's own account and Compact signs with its key
// (the contract does not check the caller, so never deploy it on an account whose keys you share).
import crypto from 'node:crypto';
import { encode as b58 } from './base58.mjs';
import { CompactError } from '../errors.mjs';
import { GAS_30T, NO_CONTRACT_HASH, sendTransaction } from './account.mjs';

const leb = (n) => { const out = []; let v = BigInt(n); do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v); return out; };
const sleb = (n) => { let v = BigInt(n); const out = []; for (;;) { const b = Number(v & 0x7fn); v >>= 7n; const sign = (b & 0x40) !== 0; if ((v === 0n && !sign) || (v === -1n && sign)) { out.push(b); return out; } out.push(b | 0x80); } };
const vec = (items) => [...leb(items.length), ...items.flat()];
const section = (id, payload) => [id, ...leb(payload.length), ...payload];
const name = (s) => [...leb(s.length), ...Buffer.from(s)];
const I64 = (n) => [0x42, ...sleb(n)];
const CALL = (i) => [0x10, ...leb(i)];
const LGET = (i) => [0x20, ...leb(i)];
const LSET = (i) => [0x21, ...leb(i)];
const OP = { eqz: 0x50, lt_u: 0x54, gt_u: 0x56, sub: 0x7d, drop: 0x1a, end: 0x0b, if_: [0x04, 0x40] };

// Host function indices (order of imports below)
const H = { input: 0, read_register: 1, register_len: 2, storage_write: 3, storage_read: 4, value_return: 5, panic: 6 };
const T_I64 = 0x7e;

export function buildRegistryWasm({ legacy = false } = {}) {
  const types = vec([
    [0x60, ...vec([[T_I64]]), ...vec([])],                                   // 0: (i64) -> ()
    [0x60, ...vec([[T_I64], [T_I64]]), ...vec([])],                          // 1: (i64,i64) -> ()
    [0x60, ...vec([[T_I64]]), ...vec([[T_I64]])],                            // 2: (i64) -> i64
    [0x60, ...vec([[T_I64], [T_I64], [T_I64], [T_I64], [T_I64]]), ...vec([[T_I64]])], // 3: (i64 x5) -> i64
    [0x60, ...vec([[T_I64], [T_I64], [T_I64]]), ...vec([[T_I64]])],          // 4: (i64 x3) -> i64
    [0x60, ...vec([]), ...vec([])],                                          // 5: () -> ()
  ]);
  const fn = (n, t) => [...name('env'), ...name(n), 0x00, ...leb(t)];
  const imports = vec([
    fn('input', 0), fn('read_register', 1), fn('register_len', 2), fn('storage_write', 3),
    fn('storage_read', 4), fn('value_return', 1), fn('panic', 5),
    ...(legacy ? [[...name('env'), ...name('memory'), 0x02, 0x00, ...leb(1)]] : []),
  ]);
  const functions = vec([[...leb(5)], [...leb(5)]]); // two () -> () functions: indices 7 (set) and 8 (get)
  const memory = vec([[0x00, ...leb(1)]]);
  const exports_ = vec([[...name('set'), 0x00, ...leb(7)], [...name('get'), 0x00, ...leb(8)], ...(legacy ? [] : [[...name('memory'), 0x02, ...leb(0)]])]);

  const setBody = [
    ...vec([[...leb(1), T_I64]]),                 // one local: i64 `len`
    ...I64(0), ...CALL(H.input),
    ...I64(0), ...CALL(H.register_len), ...LSET(0),
    ...LGET(0), ...I64(33), OP.lt_u, ...OP.if_, ...CALL(H.panic), OP.end,      // need key + >=1 byte
    ...LGET(0), ...I64(65536), OP.gt_u, ...OP.if_, ...CALL(H.panic), OP.end,   // fits in 1 memory page
    ...I64(0), ...I64(0), ...CALL(H.read_register),                            // register 0 -> memory[0..len]
    ...I64(32), ...I64(0), ...LGET(0), ...I64(32), OP.sub, ...I64(32), ...I64(1), ...CALL(H.storage_write), OP.drop,
    OP.end,
  ];
  const getBody = [
    ...vec([]),
    ...I64(0), ...CALL(H.input),
    ...I64(-1), ...I64(0), ...I64(1), ...CALL(H.storage_read),                 // key from register 0 -> value in register 1
    OP.eqz, ...OP.if_, ...CALL(H.panic), OP.end,
    ...I64(-1), ...I64(1), ...CALL(H.value_return),                            // return register 1
    OP.end,
  ];
  const code = vec([[...leb(setBody.length), ...setBody], [...leb(getBody.length), ...getBody]]);

  return Buffer.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types), ...section(2, imports), ...section(3, functions), ...(legacy ? [] : section(5, memory)), ...section(7, exports_), ...section(10, code),
  ]);
}

export const registryWasmHash = (opts) => b58(crypto.createHash('sha256').update(buildRegistryWasm(opts)).digest());
export const registryKey = (appId) => crypto.createHash('sha256').update(appId, 'utf8').digest();

/** Is our registry contract already deployed on this account? */
export async function registryStatus(rpc, accountId) {
  const a = await rpc.viewAccount(accountId);
  if (!a) return { state: 'no-account' };
  if (a.code_hash === NO_CONTRACT_HASH) return { state: 'no-contract' };
  if (a.code_hash === registryWasmHash()) return { state: 'deployed' };
  if (a.code_hash === registryWasmHash({ legacy: true })) return { state: 'outdated' };
  return { state: 'other-contract', codeHash: a.code_hash };
}

export async function deployRegistry({ rpc, accountId, keyPair, logger }) {
  const st = await registryStatus(rpc, accountId);
  if (st.state === 'deployed') return { skipped: true };
  if (st.state === 'other-contract') {
    throw new CompactError('E_REGISTRY_CONFLICT', `${accountId} already hosts a different contract.`, {
      hint: 'Use a dedicated deployer account (compact account import) so Compact never overwrites existing code.',
    });
  }
  const receipt = await sendTransaction({
    rpc, signerId: accountId, keyPair, receiverId: accountId, logger,
    actions: [{ type: 'deployContract', code: buildRegistryWasm() }],
  });
  assertOk(receipt, 'deploy registry contract');
  return { skipped: false, upgraded: st.state === 'outdated', receipt };
}

export async function writeRecord({ rpc, accountId, keyPair, appId, record, logger }) {
  const value = Buffer.from(JSON.stringify(record), 'utf8');
  const receipt = await sendTransaction({
    rpc, signerId: accountId, keyPair, receiverId: accountId, logger,
    actions: [{ type: 'functionCall', methodName: 'set', args: Buffer.concat([registryKey(appId), value]), gas: GAS_30T, deposit: 0n }],
  });
  assertOk(receipt, 'write registry record');
  return receipt;
}

export async function readRecord({ rpc, accountId, appId }) {
  try {
    const out = await rpc.callView(accountId, 'get', registryKey(appId));
    return JSON.parse(out.toString('utf8'));
  } catch (e) {
    if (e?.rpcName === 'VIEW_FAILED' || /MethodResolveError|CodeDoesNotExist|panic|ExecutionError/i.test(String(e?.message))) return null;
    throw e;
  }
}

function assertOk(receipt, what) {
  if (!receipt.ok) {
    throw new CompactError('E_TX_REJECTED', `The network rejected the transaction (${what}).`, {
      details: [`failure: ${JSON.stringify(receipt.failure)}`, `tx: ${receipt.txHash}`],
      hint: `Inspect it: https://testnet.nearblocks.io/txns/${receipt.txHash}`,
    });
  }
}
