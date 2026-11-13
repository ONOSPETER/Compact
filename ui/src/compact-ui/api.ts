// Typed client for the Compact bridge (src/ui-server/server.mjs).
export type Receipt = { name: string; txHash: string; ok: boolean; explorer: string; gasBurnt?: string | number };
export type Deployer = { accountId: string; publicKey?: string; encrypted: boolean; minNear: string; balanceNear: string; funded: boolean; exists?: boolean; balanceError?: string };
export type AppSummary = { id: string; name: string; mode?: string; outDir: string; github: null | { owner: string; repo: string; url: string; branch: string; commitSha?: string; private?: boolean }; deployments: number; anchors: number; lastReceipts: Receipt[] };
export type AppDetail = AppSummary & { endpoint: string; registry: string | null; manifestSha256: string; runnerKeyHash: string; explorer: string; env: { required: string[]; storage: string[]; app: string[] } };
export type Session = { network: 'testnet'; node: string; explorer: string; setupComplete: boolean; workdir: string; deployer: Deployer | null; github: null | { user: string | null; source: string }; apps: AppSummary[] };
export type Check = { name: string; status: 'ok' | 'warn' | 'fail'; detail?: string; hint?: string };
export type PlanFile = { side: 'portal' | 'critical' | 'shared' | 'conflict'; reasons: string[] };
export type Issue = { file?: string; message: string; hint?: string };
export type Plan = { mode: 'http' | 'rpc' | 'none'; entry?: string; port?: number; proxyPrefixes: string[]; counts: Record<string, number>; files: Record<string, PlanFile>; rpcAllow: Record<string, string[]>; errors: Issue[]; warnings: Issue[] };
export type JobStep = { title: string; state: 'running' | 'done' | 'failed'; note: string; detail: string };
export type Job<T = any> = { id: string; kind: string; status: 'running' | 'done' | 'failed'; steps: JobStep[]; warnings: string[]; result: T | null; error: ErrInfo | null };
export type VerifyResult = { checks: { id: 'live' | 'integrity' | 'record' | 'handshake' | 'vault'; ok: boolean; message?: string; hint?: string }[] };
export type ErrInfo = { code: string; message: string; hint?: string; details?: string[] };

export class ApiError extends Error {
  code: string; hint?: string; details?: string[]; status: number;
  constructor(e: ErrInfo, status = 500) { super(e.message); this.code = e.code; this.hint = e.hint; this.details = e.details; this.status = status; }
}

export type Saved = { step: number; flags: Record<string, boolean>; src: { source: string; critical: string; portal: string; entry: string; port: string }; appId: string; url: string };

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError({ code: 'E_BRIDGE_DOWN', message: 'Cannot reach the Compact server.', hint: 'Start it with: node src/ui-server/server.mjs' }, 0);
  }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(data?.error ?? { code: 'E_HTTP', message: `The server answered ${res.status}.`, hint: 'Is the Compact server running? node src/ui-server/server.mjs' }, res.status);
  return data as T;
}

export const api = {
  session: () => req<Session>('GET', '/api/session'),
  getProgress: () => req<{ accountId: string | null; progress: Saved | null }>('GET', '/api/progress'),
  saveProgress: (p: Saved) => req<{ ok: true }>('PUT', '/api/progress', p),
  balance: () => req<{ deployer: Deployer | null }>('GET', '/api/balance'),
  doctor: () => req<{ checks: Check[] }>('POST', '/api/doctor', {}),
  createAccount: (passphrase?: string) => req<{ accountId: string; secretKey: string }>('POST', '/api/account/create', { passphrase }),
  importAccount: (secretKey: string, passphrase?: string) => req<{ accountId: string }>('POST', '/api/account/import', { secretKey, passphrase }),
  saveGithub: (token: string) => req<{ user: string }>('POST', '/api/github/token', { token }),
  clearGithub: () => req<{ ok: true }>('DELETE', '/api/github/token', {}),
  app: (id: string) => req<AppDetail>('GET', `/api/apps/${encodeURIComponent(id)}`),
  appKeys: (id: string) => req<{ keyFile: string; COMPACT_KEYS_B64: string }>('POST', `/api/apps/${encodeURIComponent(id)}/keys`, {}),
  checkEndpoint: (url: string) => req<{ url: string; status: number; ok: boolean; integrityOk: boolean | null; authPage?: boolean; error?: string }>('POST', '/api/check-endpoint', { url }),
};

/** Start a background job on the bridge and poll it until it finishes. */
export async function runJob<T = any>(kind: 'analyze' | 'transform' | 'deploy' | 'push' | 'commit' | 'verify', body: object, onUpdate?: (j: Job<T>) => void): Promise<T> {
  const { id } = await req<{ id: string }>('POST', `/api/jobs/${kind}`, body);
  for (;;) {
    const job = await req<Job<T>>('GET', `/api/jobs/${id}`);
    onUpdate?.(job);
    if (job.status === 'done') return job.result as T;
    if (job.status === 'failed') throw new ApiError(job.error!, 400);
    await new Promise((r) => setTimeout(r, 600));
  }
}
