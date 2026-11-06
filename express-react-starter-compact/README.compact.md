# express-react-starter: Compact project

```
portal/    public half. Push this to GitHub and import it in Vercel.
critical/  private half (http mode). Never published. Runs behind the post-quantum channel.
compact/   manifest, keys (secret!), runtime, deploy files, receipts.
```

Next steps
1. `cd portal && npm install`   (portal now depends on @noble/post-quantum)
2. `compact serve`              (runs critical/ locally on :8787) then `cd portal && npm run dev`
3. `compact deploy`             (anchor on NEAR testnet, saves receipts)
4. `compact push`               (publish portal/ to GitHub, then import it in Vercel)

Secrets: compact/keys/runner.secret.json holds the runner's private keys. It is git-ignored; keep it that way.
