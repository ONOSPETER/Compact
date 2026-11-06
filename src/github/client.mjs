import { CompactError, EXIT } from '../errors.mjs';
import { sleep } from '../util/fs.mjs';
import { nullLogger } from '../util/log.mjs';

const MAX_ATTEMPTS = 4;

/** Small GitHub REST client: auth, retries with backoff, rate-limit awareness, typed errors. */
export class GitHub {
  constructor({ token, fetchImpl = globalThis.fetch, apiBase = 'https://api.github.com', logger = nullLogger, timeoutMs = 30_000 } = {}) {
    Object.assign(this, { token, fetch: fetchImpl, apiBase, logger, timeoutMs });
  }

  async req(method, path, { body, allow404 = false, query } = {}) {
    const url = new URL(path.startsWith('http') ? path : `${this.apiBase}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await this.fetch(url, {
          method,
          headers: {
            accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'compact-cli',
            ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastErr = e;
        this.logger.warn('github network error', { path, attempt, error: e.message });
        if (attempt < MAX_ATTEMPTS) { await sleep(500 * 2 ** (attempt - 1)); continue; }
        throw new CompactError('E_GITHUB_NETWORK', 'Could not reach GitHub.', { hint: 'Check your connection and try again.', cause: e, exitCode: EXIT.NETWORK });
      }
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
      if (res.status >= 200 && res.status < 300) return data;
      if (res.status === 404 && allow404) return null;

      const remaining = res.headers.get?.('x-ratelimit-remaining');
      const reset = Number(res.headers.get?.('x-ratelimit-reset') ?? 0) * 1000;
      const retryAfter = Number(res.headers.get?.('retry-after') ?? 0) * 1000;
      const limited = res.status === 429 || (res.status === 403 && (remaining === '0' || retryAfter > 0 || /rate limit|abuse/i.test(data?.message ?? '')));
      if (limited && attempt < MAX_ATTEMPTS) {
        const wait = retryAfter || (reset ? Math.max(0, reset - Date.now()) + 500 : 4000 * attempt);
        if (wait > 90_000) throw new CompactError('E_GITHUB_RATE_LIMIT', 'GitHub rate limit reached.', { hint: `Resets at ${new Date(reset).toLocaleTimeString()}. Use a token (compact setup) for a higher limit.`, exitCode: EXIT.NETWORK });
        this.logger.warn('github rate limited', { wait });
        await sleep(wait);
        continue;
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) { await sleep(700 * 2 ** (attempt - 1)); continue; }

      const msg = data?.message ?? `HTTP ${res.status}`;
      if (res.status === 401) throw new CompactError('E_GITHUB_AUTH', 'GitHub rejected the token.', { hint: 'Create a new token and run `compact setup` again.', exitCode: EXIT.ENV });
      if (res.status === 403) throw new CompactError('E_GITHUB_FORBIDDEN', `GitHub refused the request: ${msg}`, { hint: 'The token needs repo access (classic: "repo"; fine-grained: Contents + Administration read/write).', exitCode: EXIT.ENV });
      if (res.status === 404) throw new CompactError('E_GITHUB_NOT_FOUND', `Not found on GitHub: ${path}`, { hint: 'Check the repository name, and that your token can see it (private repos need a token).' });
      throw Object.assign(new CompactError('E_GITHUB_API', `GitHub API error (${res.status}): ${msg}`, { details: data }), { status: res.status });
    }
    throw new CompactError('E_GITHUB_NETWORK', 'GitHub request failed.', { cause: lastErr });
  }

  user() { return this.req('GET', '/user'); }
  getRepo(o, r) { return this.req('GET', `/repos/${o}/${r}`, { allow404: true }); }
  createRepo({ name, isPrivate = true, org, description }) {
    return this.req('POST', org ? `/orgs/${org}/repos` : '/user/repos', { body: { name, private: isPrivate, description, auto_init: true } });
  }
  async getHead(o, r, branch) {
    const ref = await this.req('GET', `/repos/${o}/${r}/git/ref/heads/${encodeURIComponent(branch)}`, { allow404: true }).catch((e) => { if (e.status === 409) return null; throw e; });
    return ref?.object?.sha ?? null;
  }
  getCommit(o, r, sha) { return this.req('GET', `/repos/${o}/${r}/git/commits/${sha}`); }
  getTree(o, r, sha) { return this.req('GET', `/repos/${o}/${r}/git/trees/${sha}`, { query: { recursive: '1' } }); }
  getBlob(o, r, sha) { return this.req('GET', `/repos/${o}/${r}/git/blobs/${sha}`); }
  createBlob(o, r, buf) { return this.req('POST', `/repos/${o}/${r}/git/blobs`, { body: { content: buf.toString('base64'), encoding: 'base64' } }); }
  createTree(o, r, tree) { return this.req('POST', `/repos/${o}/${r}/git/trees`, { body: { tree } }); }
  createCommit(o, r, { message, tree, parents }) { return this.req('POST', `/repos/${o}/${r}/git/commits`, { body: { message, tree, parents } }); }
  updateRef(o, r, branch, sha) { return this.req('PATCH', `/repos/${o}/${r}/git/refs/heads/${encodeURIComponent(branch)}`, { body: { sha, force: false } }); }
  createRef(o, r, branch, sha) { return this.req('POST', `/repos/${o}/${r}/git/refs`, { body: { ref: `refs/heads/${branch}`, sha } }); }
  initEmptyRepo(o, r, branch) {
    return this.req('PUT', `/repos/${o}/${r}/contents/.compact-init`, { body: { message: 'Initialise repository', content: Buffer.from('init\n').toString('base64'), branch } });
  }
}
