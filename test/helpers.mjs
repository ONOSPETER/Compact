import crypto from 'node:crypto';
import { encode as b58, decode as unb58 } from '../src/near/base58.mjs';
import { buildRegistryWasm } from '../src/near/registry.mjs';

// Deliberately insecure stand-in for ML-KEM / ML-DSA (same interface, deterministic maths).
const h = (...p) => new Uint8Array(crypto.createHash('sha256').update(Buffer.concat(p.map((x) => Buffer.from(x)))).digest());
const rnd = () => new Uint8Array(crypto.randomBytes(32));
export const mockPQ = {
  kem: {
    keygen() { const secretKey = rnd(); return { secretKey, publicKey: h(secretKey) }; },
    encapsulate(pub) { const cipherText = rnd(); return { cipherText, sharedSecret: h(pub, cipherText) }; },
    decapsulate(ct, sk) { return h(h(sk), ct); },
  },
  dsa: {
    keygen() { const secretKey = rnd(); return { secretKey, publicKey: h(secretKey) }; },
    sign(sk, msg) { return h(h(sk), msg); },
    verify(pub, msg, sig) { return Buffer.from(h(pub, msg)).equals(Buffer.from(sig)); },
  },
};

// ---- independent borsh reader: decodes what our encoder produced -----------------------------
function parseSignedTx(buf) {
  let o = 0;
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = buf.readBigUInt64LE(o); o += 8; return v; };
  const str = () => { const n = u32(); const s = buf.subarray(o, o + n).toString('utf8'); o += n; return s; };
  const bytes = () => { const n = u32(); const b = buf.subarray(o, o + n); o += n; return b; };
  const signerId = str(); o += 1; const publicKey = buf.subarray(o, o + 32); o += 32;
  const nonce = u64(); const receiverId = str(); o += 32;
  const actions = [];
  for (let n = u32(); n > 0; n--) {
    const t = buf[o++];
    if (t === 1) actions.push({ type: 'deployContract', code: Buffer.from(bytes()) });
    else if (t === 2) { const methodName = str(); const args = Buffer.from(bytes()); o += 8 + 16; actions.push({ type: 'functionCall', methodName, args }); }
    else if (t === 3) { o += 16; actions.push({ type: 'transfer' }); }
    else throw new Error(`unknown action ${t}`);
  }
  const txBytes = buf.subarray(0, o);
  return { signerId, publicKey, nonce, receiverId, actions, txHash: b58(crypto.createHash('sha256').update(txBytes).digest()) };
}

/** In-memory NEAR testnet. Understands the handful of RPC methods Compact uses. */
export function mockNear({ failBroadcastOnce = false, failStatus = false } = {}) {
  const accounts = new Map(); // id -> {balance, nonce, code, storage: Map}
  const txs = new Map();
  const calls = [];
  const state = { failBroadcastOnce, broadcasts: 0, accounts, calls, txs };
  state.fund = (id, near = 1) => accounts.set(id, { balance: BigInt(Math.round(near * 1e6)) * 10n ** 18n, nonce: 100n, code: null, storage: new Map() });
  const ok = (result) => ({ status: 200, json: async () => ({ result }) });
  const err = (name, data) => ({ status: 200, json: async () => ({ error: { name: 'HANDLER_ERROR', cause: { name }, message: name, data } }) });

  state.fetch = async (url, init) => {
    const { method, params } = JSON.parse(init.body);
    calls.push(method);
    if (method === 'status') { if (failStatus) return { status: 503, json: async () => ({}) }; return ok({ chain_id: 'testnet', sync_info: { latest_block_height: 123 } }); }
    if (method === 'block') return ok({ header: { hash: b58(crypto.randomBytes(32)), height: 123 } });
    if (method === 'query') {
      const a = accounts.get(params.account_id);
      if (params.request_type === 'view_account') return a ? ok({ amount: a.balance.toString(), code_hash: a.code ? b58(crypto.createHash('sha256').update(a.code).digest()) : '1'.repeat(32), storage_usage: 100 }) : err('UNKNOWN_ACCOUNT', `account ${params.account_id} does not exist`);
      if (params.request_type === 'view_access_key') return a ? ok({ nonce: Number(a.nonce) }) : err('UNKNOWN_ACCESS_KEY', 'no key');
      if (params.request_type === 'call_function') {
        const key = Buffer.from(params.args_base64, 'base64').toString('hex');
        const v = a?.storage.get(key);
        return v ? ok({ result: [...v], logs: [] }) : ok({ error: 'wasm execution failed: panic' });
      }
    }
    if (method === 'broadcast_tx_async') {
      state.broadcasts++;
      if (state.failBroadcastOnce && state.broadcasts === 1) return { status: 503, json: async () => ({}) };
      const t = parseSignedTx(Buffer.from(params[0], 'base64'));
      if (txs.has(t.txHash)) return ok(t.txHash);
      const a = accounts.get(t.signerId);
      let failure;
      if (!a || BigInt(t.nonce) <= a.nonce) failure = { InvalidTxError: 'InvalidNonce' };
      else {
        a.nonce = BigInt(t.nonce);
        for (const act of t.actions) {
          if (act.type === 'deployContract') a.code = act.code;
          if (act.type === 'functionCall') {
            if (!a.code || act.methodName !== 'set') failure = { ActionError: 'MethodResolveError' };
            else a.storage.set(act.args.subarray(0, 32).toString('hex'), act.args.subarray(32));
          }
        }
      }
      txs.set(t.txHash, { t, failure });
      return ok(t.txHash);
    }
    if (method === 'tx') {
      const hash = params.tx_hash ?? params[0];
      const rec = txs.get(hash);
      if (!rec) return err('UNKNOWN_TRANSACTION', 'not found');
      const outcome = (id) => ({ id, outcome: { gas_burnt: 2_000_000_000_000, tokens_burnt: '200000000000000000000', status: rec.failure ? { Failure: rec.failure } : { SuccessValue: '' } } });
      return ok({ status: rec.failure ? { Failure: rec.failure } : { SuccessValue: '' }, transaction_outcome: outcome(hash), receipts_outcome: [outcome('r1')], final_execution_status: 'EXECUTED_OPTIMISTIC' });
    }
    return { status: 400, json: async () => ({ error: { name: 'x', message: `unsupported ${method}` } }) };
  };
  return state;
}

/** Minimal in-memory GitHub REST API (repos, refs, blobs, trees, commits). */
export function mockGithub({ rateLimitOnce = false } = {}) {
  const repos = new Map();
  const state = { repos, requests: [], limited: !rateLimitOnce };
  const sha = (o) => crypto.createHash('sha1').update(JSON.stringify(o)).digest('hex');
  const res = (status, body, headers = {}) => ({ status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, text: async () => (body === undefined ? '' : JSON.stringify(body)) });
  state.fetch = async (url, init = {}) => {
    const u = new URL(url); const method = init.method ?? 'GET'; const p = u.pathname; const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push(`${method} ${p}`);
    if (!state.limited && method === 'POST' && p.endsWith('/git/blobs')) { state.limited = true; return res(429, { message: 'rate limit' }, { 'retry-after': '1' }); }
    if (p === '/user') return res(200, { login: 'ann' });
    let m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(p);
    if (m && method === 'GET') { const r = repos.get(`${m[1]}/${m[2]}`); return r ? res(200, r.info) : res(404, { message: 'Not Found' }); }
    if (p === '/user/repos' && method === 'POST') {
      const c = { tree: sha('init'), parents: [] }; const csha = sha(c);
      repos.set(`ann/${body.name}`, { info: { name: body.name, html_url: `https://github.com/ann/${body.name}`, default_branch: 'main', private: body.private }, blobs: new Map(), trees: new Map([[c.tree, []]]), commits: new Map([[csha, c]]), refs: new Map([['main', csha]]) });
      return res(201, repos.get(`ann/${body.name}`).info);
    }
    m = /^\/repos\/([^/]+)\/([^/]+)\/git\/(.+)$/.exec(p);
    if (m) {
      const r = repos.get(`${m[1]}/${m[2]}`); const rest = m[3];
      if (!r) return res(404, { message: 'Not Found' });
      let q;
      if ((q = /^ref\/heads\/(.+)$/.exec(rest))) return r.refs.has(q[1]) ? res(200, { object: { sha: r.refs.get(q[1]) } }) : res(404, { message: 'Not Found' });
      if (rest === 'blobs') { const s = sha(body.content); r.blobs.set(s, body.content); return res(201, { sha: s }); }
      if (rest === 'trees') { const t = body.tree.map((e) => ({ path: e.path, sha: e.sha })).sort((a, b) => (a.path < b.path ? -1 : 1)); const s = sha(t); r.trees.set(s, t); return res(201, { sha: s }); }
      if ((q = /^commits\/(.+)$/.exec(rest))) return res(200, { tree: { sha: r.commits.get(q[1]).tree } });
      if (rest === 'commits') { const c = { tree: body.tree, parents: body.parents, message: body.message }; const s = sha(c); r.commits.set(s, c); return res(201, { sha: s }); }
      if ((q = /^refs\/heads\/(.+)$/.exec(rest)) && method === 'PATCH') { r.refs.set(q[1], body.sha); return res(200, {}); }
      if (rest === 'refs' && method === 'POST') { r.refs.set(body.ref.replace('refs/heads/', ''), body.sha); return res(201, {}); }
    }
    return res(404, { message: `unhandled ${method} ${p}` });
  };
  return state;
}
