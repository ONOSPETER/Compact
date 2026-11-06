import { CompactError, EXIT } from '../errors.mjs';
import { retry } from '../util/retry.mjs';
import { nullLogger } from '../util/log.mjs';

export const DEFAULT_TESTNET_RPCS = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const TRANSIENT_NAMES = new Set(['TIMEOUT_ERROR', 'INTERNAL_ERROR', 'UNAVAILABLE_SHARD', 'NOT_SYNCED_YET']);

export class RpcError extends Error {
  constructor({ method, code, name, message, data }) {
    super(message);
    this.name = 'RpcError';
    this.method = method;
    this.rpcCode = code;
    this.rpcName = name;
    this.data = data;
  }
}

class TransientRpcError extends Error {}

/**
 * JSON-RPC client for NEAR with endpoint failover and retry on transient failures.
 * Semantic errors (unknown account, invalid tx...) are never retried.
 */
export class NearRpc {
  constructor({ urls = DEFAULT_TESTNET_RPCS, fetchImpl = globalThis.fetch, timeoutMs = 15_000, logger = nullLogger, attempts = 2 } = {}) {
    if (!urls.length) throw new CompactError('E_RPC_CONFIG', 'No RPC endpoints configured.', { exitCode: EXIT.ENV });
    this.urls = [...urls];
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.attempts = attempts;
    this.id = 0;
  }

  async #once(url, method, params) {
    let res;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new TransientRpcError(`${url}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`);
    }
    if (res.status === 429 || res.status >= 500) throw new TransientRpcError(`${url}: HTTP ${res.status}`);
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TransientRpcError(`${url}: invalid JSON response`);
    }
    if (body.error) {
      const name = body.error.cause?.name ?? body.error.name;
      const err = new RpcError({
        method, code: body.error.code, name,
        message: body.error.data && typeof body.error.data === 'string' ? body.error.data : body.error.message || 'RPC error',
        data: body.error,
      });
      if (TRANSIENT_NAMES.has(name)) throw new TransientRpcError(`${url}: ${name}`);
      throw err;
    }
    return body.result;
  }

  async call(method, params) {
    const errors = [];
    for (let i = 0; i < this.urls.length; i++) {
      const url = this.urls[i];
      try {
        const result = await retry(() => this.#once(url, method, params), {
          attempts: this.attempts,
          baseMs: 250,
          shouldRetry: (e) => e instanceof TransientRpcError,
          onRetry: (e, n) => this.logger.debug(`rpc retry ${n} ${method}: ${e.message}`),
        });
        if (i > 0) this.urls.unshift(...this.urls.splice(i, 1)); // remember the endpoint that worked
        return result;
      } catch (e) {
        if (!(e instanceof TransientRpcError)) throw e;
        errors.push(e.message);
        this.logger.warn(`rpc endpoint failed (${method})`, { error: e.message });
      }
    }
    throw new CompactError('E_RPC_UNREACHABLE', 'Could not reach any NEAR RPC endpoint.', {
      hint: 'Check your internet connection, or set COMPACT_RPC_URLS to another endpoint.',
      details: errors,
      exitCode: EXIT.NETWORK,
    });
  }

  /** `query` with both error shapes normalised: returns null for "does not exist". */
  async query(params) {
    try {
      const r = await this.call('query', params);
      if (r && typeof r.error === 'string') {
        if (/does not exist|unknown/i.test(r.error)) return null;
        throw new RpcError({ method: 'query', message: r.error, data: r });
      }
      return r;
    } catch (e) {
      if (e instanceof RpcError && /UNKNOWN_(ACCOUNT|ACCESS_KEY)|does not exist/i.test(`${e.rpcName} ${e.message}`)) return null;
      throw e;
    }
  }

  status() { return this.call('status', []); }
  async block() {
    const b = await this.call('block', { finality: 'final' });
    return { hash: b.header.hash, height: b.header.height };
  }
  viewAccount(accountId) { return this.query({ request_type: 'view_account', finality: 'final', account_id: accountId }); }
  viewAccessKey(accountId, publicKey) {
    return this.query({ request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
  }

  /** Call a view method. Returns a Buffer. Throws RpcError('VIEW_FAILED') when the contract panics. */
  async callView(accountId, methodName, args = Buffer.alloc(0)) {
    const r = await this.call('query', {
      request_type: 'call_function', finality: 'final', account_id: accountId,
      method_name: methodName, args_base64: Buffer.from(args).toString('base64'),
    });
    if (r && r.error) throw new RpcError({ method: 'call_function', name: 'VIEW_FAILED', message: String(r.error), data: r });
    return Buffer.from(r.result);
  }
}
