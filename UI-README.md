# Compact UI

A step-by-step web UI for the Compact SDK. 11 pages, from "check your setup" to "your app is live". Every page has **Your side** (tasks and guide links) and **Compact's side** (live status). Testnet is stated on every screen. Light and dark themes invert each other, using your logo.

## What's in this folder

| Path | Copy to | What it is |
|---|---|---|
| `ui-server/server.mjs` | `compact-cli/src/ui-server/server.mjs` | Small local API in front of the SDK. The browser cannot import the SDK (it needs fs, crypto and your keystore), so this does the work and the UI shows it. |
| `ui/` | `compact-cli/ui/` | The Vite + React + TypeScript UI. |
| `test/ui-server.test.mjs` | `compact-cli/test/` | 4 tests for the bridge. |

No existing file is changed except `package.json` (scripts only) and, if you choose, your root React file.

## Install (about 2 minutes)

```bash
cd ~/workspace            # your compact-cli folder
# 1. copy the three items in the table above into place, then:
npm --prefix ui install
```

Add these to the `scripts` in compact-cli's `package.json`:

```json
"ui:server": "node src/ui-server/server.mjs",
"ui:dev": "npm --prefix ui run dev",
"ui": "node src/ui-server/server.mjs & npm --prefix ui run dev"
```

## Run

```bash
npm run ui
```

1. The terminal prints `Access token  <something>`. Open the UI (port 3001, which your `.replit` already exposes) and paste it once to unlock.
2. Use the CLI in another shell at the same time. Both share `~/.compact`, so an app you built in the CLI appears in the UI and the other way round.

Optional: `COMPACT_UI_TOKEN=yourtoken` fixes the token, `COMPACT_UI_WORKDIR=/path` sets where new projects are created (default: the folder you started it in), and `COMPACT_UI_PORT` moves the bridge off 8788.

## "Edit the app.tsx / root file"

If you use the included `ui/` project, this is already done: `ui/src/App.tsx` is just

```tsx
import { CompactApp } from './compact-ui';
export default function App() { return <CompactApp />; }
```

If you already have a Vite + React app, copy `ui/src/compact-ui/` into its `src/`, add the `/api` proxy from `ui/vite.config.ts`, and render `<CompactApp />` from your root file the same way. It brings its own CSS (everything is scoped under `.cx`) and needs no other dependency besides React.

## The 11 pages

1. **Check your setup:** runs the same checks as `compact doctor`.
2. **Deployer account:** create or import, shows the secret key once, funding help, balance polling, low-balance pop-up.
3. **Connect GitHub:** token guide with direct links, verified before saving.
4. **Choose your app:** GitHub link or folder, with optional overrides.
5. **Review the split:** what is public vs private, and why.
6. **Build:** `transform`, then a reminder to back up the runner key.
7. **Anchor on NEAR:** `deploy`, with receipts and explorer links.
8. **Push to GitHub:** preview files, secret scan, push.
9. **Deploy on Vercel:** four guided tasks plus every environment variable to copy.
10. **Link Vercel:** health-checks your URL, then runs `deploy --endpoint` and `push`.
11. **Finish:** deliverables, vault anchor, and an honest post-quantum summary.

## Decision to know about: "connect your NEAR wallet"

Your SDK signs with a key it holds itself, and a browser wallet (MyNearWallet and others) can't sign for that. So step 2 creates or imports the **deployer account** the SDK already uses, which is what you described the wallet as. If you want a real wallet connection later, Compact's contract calls would need to move into the browser.

## Security

- The bridge listens on `127.0.0.1` only, and every call needs the access token. On Replit the UI is public, so the token is what protects your deployer key.
- Secrets leave the bridge only at three points: account creation (shown once), `COMPACT_KEYS_B64` (when you press "Show value"), and nothing else. `/api/session` never contains them.
- Do not put the UI on the open internet without something stronger in front.

## What was and was not tested

Tested here: the bridge against your real SDK (4 tests pass: auth, account create, analyze job, input checks), and the UI compiled and rendered in a browser against a mocked bridge, in light and dark mode and at phone width.

Not tested, because the sandbox has no network: real NEAR testnet, GitHub and Vercel runs from the UI; the `transform` job (it needs `@noble/post-quantum`, which `npm install` provides on your side); and a full Vite build (checked with esbuild instead, plus a partial TypeScript check). Run `npm --prefix ui run build` once; if `tsc` complains, send me the output. Faucet, Vercel and GitHub links were written from memory: click each once.
