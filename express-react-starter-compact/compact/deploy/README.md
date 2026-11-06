# Deploying the critical side

1. `compact deploy` anchors the manifest on NEAR testnet (receipts are saved in compact/receipts/).
2. Build and run the runner on a TEE host:
   - Local test: `compact serve`
   - TEE host: build with `compact/deploy/Dockerfile` (context = project root) and set the sealed secret
     `COMPACT_KEYS_B64` (print it with `compact keys <app> --b64`). Never put it in an image or a repo.
3. Tell the portal where it lives: `compact deploy --endpoint https://your-runner.example.com`
4. `compact push` publishes the portal to GitHub; import that repo in Vercel.

NEAR does not execute Node code: the registry on NEAR records what the runner must be; the runner itself runs on the TEE host.
