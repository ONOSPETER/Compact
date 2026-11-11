# Compact CLI (v0.1, testnet)

Split a **Vite + Node** app into a public **portal** and a private **critical** half. The critical half runs behind a
post-quantum-hardened channel (X25519 + ML-KEM-768 key exchange, ML-DSA-65 signatures, AES-256-GCM). Its manifest is
anchored on **NEAR testnet**; the portal is pushed to **GitHub** so you can import it in **Vercel**.

No AI is involved: the split is rule-based, deterministic, and every decision is explained.

```
my-app/                      my-app-compact/
  index.html                   portal/    public half   -> GitHub -> Vercel
  src/…                        critical/  private half  -> runner (TEE host), never published
  server/…          ──────►    compact/   manifest, runtime, deploy files, receipts, keys/ (secret)
```

## Install

```bash
cd compact-cli
npm install          # installs @noble/post-quantum (the only dependency)
npm link             # makes the `compact` command available (or: node bin/compact.mjs)
npm test             # 40 tests, no network needed
```
Requires Node 20+.

## 60-second tour

```bash
compact setup                          # deployer account + GitHub token + checks (once)
compact ship ./my-vite-app --wait      # transform → anchor on NEAR → push portal to GitHub
```
`setup` creates a NEAR **implicit account** (id = hex of the public key), prints the address and secret key **once**, and
waits for you to fund it with ≥ 0.05 testnet NEAR from any faucet.

Step by step instead of `ship`:

| Command | What it does |
|---|---|
| `compact analyze <path\|github-url>` | Show how the app would be split and why. Writes nothing. |
| `compact transform <path\|github-url>` | Build `portal/ critical/ compact/` + fresh PQ keys + signed manifest. |
| `compact serve` | Run the critical side locally on :8787 (installs deps if needed). |
| `compact deploy [--endpoint URL]` | Deploy the registry contract (once) and write the app record on NEAR; print receipts. |
| `compact push` | Publish the **whole app as ONE private repo ready for Vercel** (Vite app at the root, critical + Compact runtime under `compact/`, one serverless function). Secret scan first. `--portal-only` pushes just `portal/`. |
| `compact export` | Write that same single-repo tree to a local folder (inspect it, or `vercel dev`). |
| `compact upgrade [app]` | Refresh the generated runtime files of an existing project (adds the vault) without touching code, keys or manifest. |
| `compact vault init/put/get/list/rm/verify` | End-to-end encrypted storage on the runner, checked against NEAR. |
| `compact commit [--every N]` | Anchor the vault's Merkle root on NEAR, only when enough writes accumulated. |
| `compact apps / status / keys / forget` | Everything Compact remembers; receipts; connection info; on-chain share; cleanup. |
| `compact account / doctor` | Deployer management (balance, export, import) and diagnostics. |

Every command supports `--json` (clean machine output), `--yes` (no prompts), `--debug`, `--quiet`, `--no-color`.
Exit codes: 0 ok · 1 failure · 2 usage · 3 environment/config · 4 network · 5 validation · 130 cancelled.

## What `transform` does

1. Reads the app (local folder or GitHub URL, downloaded through the Git Data API and cached by commit SHA).
2. Classifies every file by explicit rules (`src/analyze/rules.mjs`): server frameworks, Node-only modules, server-only
   packages, secret env vars, `server/` folders → **critical**; UI libraries, browser globals, `import.meta.env`, JSX →
   **portal**; helpers follow their importers; both → **shared** (copied to each); contradictions are **errors**, not guesses.
   Override with `--critical/--portal <glob>`, a `compact.config.json`, or `// @compact-critical` / `// @compact-portal`.
3. **Server mode** (Express/Fastify/…): the backend moves to `critical/` and runs unmodified behind the channel. The portal
   gets `src/compact/install.mjs`, which routes same-origin `fetch('/api/…')` calls through the encrypted channel.
   **Function mode** (client-side secrets): critical modules are replaced in the portal by generated stubs at the *same
   path* (imports keep working); only the functions the portal actually imports are exposed (least privilege).
4. Moves secret `.env` values to `critical/` only (`VITE_*` stay public), strips server-only dependencies from the portal.
5. Generates ML-KEM-768 + ML-DSA-65 keys, signs the manifest, writes the public `connect.json` for the portal.
6. Writes everything to a staging folder and swaps it in atomically: you never get a half-built project.

## Keys: who holds what

| Key | Where | Secret? |
|---|---|---|
| Deployer (ed25519 NEAR key) | `~/.compact/keystore.json`, 0600, optionally passphrase-encrypted | **yes** |
| Runner keys (ML-KEM, ML-DSA) | `compact/keys/runner.secret.json` (git-ignored) and the TEE host's sealed env `COMPACT_KEYS_B64` | **yes** |
| Connection info for the portal (`portal/src/compact/connect.json`, `manifest.json`) | in the portal | no, public by design |

The portal never holds a private key: anything shipped to a browser is public. `compact keys` shows the connection info;
`compact keys --b64` prints the sealed secret for your TEE host.

## On-chain registry (no Rust needed)

`compact deploy` deploys a ~300-byte WebAssembly contract (assembled in `src/near/registry.mjs`) to **your deployer
account** and stores `{manifest hash, critical tree hash, runner key hash, endpoint}` under `sha256(appId)`. The portal's
viewer reads it with a free view call and refuses to talk to a runner whose manifest differs
(`connect.json` → `"verify": "strict"`). The contract does not check callers: use a **dedicated deployer** account.
Everything is idempotent: re-running `deploy` only sends what changed. Receipts land in `compact/receipts/`.

> NEAR does not execute your Node code. The registry records what the runner must be; the runner itself runs on a
> TEE host (dstack / Phala Cloud) using `compact/deploy/Dockerfile`, or locally with `compact serve`.

## Running everything on Vercel (single repo)

`compact push` assembles one repository that Vercel deploys as-is:
```
index.html, src/…            your Vite app (portal) + src/compact/ (client, vault client, connect.json)
api/compact/[...path].mjs    ONE Vercel function: PQ channel + encrypted vault + your critical code
compact/critical/            your backend code (never served; read by the function)
compact/runtime/             serverless handler, Redis store, crypto
compact/manifest.json/.sig   signed manifest (public)
vercel.json  .env.example  README.vercel.md  package.json (portal + backend dependencies merged)
```
Vercel setup: import the repo (preset Vite) → add the **Upstash Redis** integration (sets `UPSTASH_REDIS_REST_URL/TOKEN`)
→ set `COMPACT_KEYS_B64` (`compact keys --b64`) and your app's own secrets → deploy → check `/api/compact/health`
(`integrity.ok` should be true) → `compact deploy --endpoint https://<app>.vercel.app` → `compact commit --force`.

How it differs from the long-running runner (it has to, serverless instances share no memory):
- sessions are **sealed tickets** (the session keys travel with each request, encrypted under a server-side key), so any
  instance can answer; replay protection uses Redis `SET NX`;
- vault blobs and heads live in Redis (records up to about 256 KB), not on a disk;
- your Express app starts inside the function on first request (it must listen on `process.env.PORT`, as most do).
Not verified on real Vercel/Upstash from the build sandbox: run the steps above and report anything that differs.

## Vault (v0.2): data the host cannot read, with at most ~10% of activity on-chain

```bash
compact serve                                   # runner (stores ciphertext only), shell 1
compact vault init                              # random 256-bit key at ~/.compact/vault-keys/<app>.key  (BACK IT UP)
compact vault put notes/1 "my secret"           # encrypted on this device, padded, stored as an opaque blob
compact vault get notes/1
compact commit --force                          # anchor the Merkle root of all vault heads on NEAR (one tx)
compact vault verify                            # is the host serving what was anchored?  (free view call)
compact status                                  # shows the on-chain share
```
- **Post-quantum by construction:** the data path uses only AES-256-GCM with a 256-bit key that never leaves the
  client. No public-key exchange sits in the path, so recorded traffic and stolen ciphertext stay unreadable.
- **Host sees:** fixed-size ciphertext blobs (4 KB / 16 KB / 64 KB / 256 KB / 1 MB buckets), a pseudonymous id, IP and
  timing. **Host cannot:** read, edit or silently roll back data (hash-checked blobs + on-chain anchor).
- **On-chain share:** one transaction commits to every vault. `compact commit` skips unless `--min-writes` (default 10)
  writes happened since the last anchor, so the share is about 1/(min-writes+1) or lower. Reads never need a transaction.
  Raise `--min-writes` (or use `--every 30`) to go lower. All chain activity is on NEAR; blobs live in ordinary storage.
- **Limits:** the runner needs a persistent disk (not Vercel functions); the index is re-encrypted on each write
  (thousands of entries is fine, millions is not); one key per vault (no sharing between users yet); the anchor is
  signed with the deployer's ed25519 key until NEAR's ML-DSA account keys are supported by the CLI.

## Fault tolerance

Atomic file writes + cross-process lock (state, keystore, config) · corrupt files are quarantined, never overwritten ·
RPC failover and backoff · transactions are signed once and re-broadcast safely, nonce conflicts re-checked by hash ·
GitHub retries with rate-limit awareness · deploy/push are idempotent and resumable · secret scan before every push ·
transform never touches your source and never leaves partial output.

## Use it as an SDK (for the web UI backend)

```js
import { createContext, silentUI, transformProject, deployProject, pushPortal } from '@compact/cli';
const ctx = await createContext({ home: '/data/tenant-1', ui: silentUI(), askPassphrase: async () => process.env.PASS });
const built  = await transformProject(ctx, 'https://github.com/me/app', { out: '/data/tenant-1/app' });
const anchor = await deployProject(ctx, built.app.id, { wait: true });
const pushed = await pushPortal(ctx, built.app.id, { repo: 'my-portal' });
```
Core functions take a context and a `ui` that can be silent or event-driven; nothing prints on its own.

## Known limits (v1)

- **Testnet only.** Not security-audited.
- The post-quantum channel protects the portal↔runner link. TLS certificates, TEE attestation roots and NEAR's own
  transaction signatures (ed25519) are still classical. Attestation is not verified yet: the registry anchors the manifest,
  not the TEE measurement.
- Cookie-based auth, WebSockets and axios's default XHR adapter do not pass through the channel (warnings are shown).
- TypeScript server entries must be compiled first; native Node addons are untested in the runner.
- Analysis is regex-based (no full parser): dynamic imports and unusual export styles are reported as warnings.
- Not yet verified end to end against live services from the build sandbox (no network there): real NEAR testnet RPC,
  the GitHub API, and the real `@noble/post-quantum` package. All of those are covered by mocks/independent decoders in the tests;
  run `compact doctor`, then try `compact ship` on a small app, and report anything that differs.
