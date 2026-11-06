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
| `compact push` | Publish `portal/` to GitHub (private repo by default, secret scan first). |
| `compact apps / status / keys / forget` | Everything Compact remembers; receipts; connection info; cleanup. |
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
