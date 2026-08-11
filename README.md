# Among You

An online multiplayer social-deduction demo (lobby + movement) that runs entirely
peer-to-peer in the browser via [PeerJS](https://peerjs.com/) (WebRTC). One player
hosts a room; others join with a room code. There is no game server — the host's
browser is the authority.

## Local development

```bash
npm install
npm run dev        # http://localhost:5173  (also exposed on your LAN)
```

Other scripts:

```bash
npm run build      # type-check + production build into dist/
npm run preview    # serve the production build locally
npm run typecheck  # tsc --noEmit
```

## Deploying to GitHub Pages

This repo builds with Vite and publishes the compiled `dist/` via the workflow in
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) on every push to
`main`.

> [!IMPORTANT]
> In **Settings → Pages → Build and deployment**, set **Source = "GitHub Actions"**
> (not "Deploy from a branch").
>
> If Pages is set to "Deploy from a branch", GitHub serves the **raw repository
> source** instead of the build. The source `index.html` loads
> `/src/main.ts`, and GitHub Pages serves `.ts` with a non-JavaScript MIME type
> (`video/mp2t`), which browsers refuse to execute as a module. The result is a
> page where **the color swatches never render and the Create/Join buttons do
> nothing** — because the app's JavaScript never ran. `dist/` is intentionally
> git-ignored, so it is *only* ever served through the GitHub Actions build.

Deploy steps:

1. Settings → Pages → Source → **GitHub Actions**.
2. Push to `main` (or run the "Deploy to GitHub Pages" workflow manually).
3. Wait for the workflow to finish, then load your Pages URL.

The build uses `base: "./"` (relative asset paths), so it works both at a domain
root (`user.github.io`) and under a subpath (`user.github.io/repo/`).

## Networking configuration (optional)

By default the app uses public STUN plus the **public PeerJS cloud broker** for
signaling. That broker is convenient but flaky, and privacy/ad-blocker extensions
frequently block it. When the broker can't be reached, Create/Join reports a clear
error after a short timeout (see `OPEN_TIMEOUT_MS` in `src/net.ts`).

For a reliable public deployment, run your own [PeerServer](https://github.com/peers/peerjs-server)
and point the client at it. All settings are optional `VITE_*` env vars (copy
[`.env.example`](.env.example) to `.env.local` for local dev, or set them as repo
secrets for the Pages build):

| Variable | Purpose |
| --- | --- |
| `VITE_PEER_HOST` / `VITE_PEER_PORT` / `VITE_PEER_PATH` / `VITE_PEER_KEY` / `VITE_PEER_SECURE` | Point at your own PeerServer instead of the public cloud broker |
| `VITE_TURN_URLS` / `VITE_TURN_USERNAME` / `VITE_TURN_CREDENTIAL` | Add a TURN relay for strict NATs (STUN-only is the default) |
| `VITE_ICE_RELAY_ONLY` | Force relay-only (needs a working TURN server) |

> `VITE_*` values are inlined into the public client bundle and readable by anyone
> who loads the page — prefer short-lived / ephemeral TURN credentials.
