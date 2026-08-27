# Deploying muan companion

An operator's guide to actually hosting muan companion for a real workshop —
somewhere participants outside your laptop can reach. For the day-of
experience of _running_ a workshop once it's deployed (what to say, when to
open the dashboard, how to hand out the join link), see
[`instructor.md`](./instructor.md) instead; this doc stops at "the two
processes are up, reachable, and secure."

## 1. Two things to host, and why

Muan companion is two separate processes:

1. **`muan-companion-server`** (`packages/muan-companion-server`) — a
   persistent Node process running Socket.io. This is the one piece that
   genuinely can't be a static file: it holds the live session state (who's
   joined, current slide/step, error reports) in memory and pushes updates
   over WebSocket. It must be a long-running process somewhere.
2. **The Slidev deck itself** (e.g. `demo/muan-companion`, or your own deck
   using `slidev-addon-muan-companion`) — the participant- and
   presenter-facing slides.

The deck is the more interesting case: it does **not** need its own
long-running Node process to serve. `packages/addon-muan-companion/src/client.ts`'s
`getWorkshopSocket()` opens a Socket.io connection to a URL resolved once, at
build/runtime, by `getMuanCompanionServerUrl()` — which just reads
`import.meta.env.VITE_SLIDEV_MUAN_COMPANION_SERVER_URL` (falling back to
`http://localhost:3710`). Every bit of the addon's real-time behavior (slide
sync, step tracking, error reporting, presence) is client-side JS in the
deck's own bundle talking to that URL over WebSocket/HTTP — none of it
depends on the deck being served by a Node process. That means `slidev
build`'s static HTML/JS/CSS output (see §4) can, in principle, be hosted on
any static file host — nginx, Caddy, S3+CloudFront, Netlify, GitHub Pages,
wherever — as long as the sync server is reachable from the browser at the
URL baked in at build time.

**Flag this clearly**: that reasoning is a correct read of the client code,
not something exercised by `muan-companion-server`'s or the addon's test
suites, and not something that's been verified end-to-end against a real
static-hosted deployment. Treat "the deck can be a static export" as
_should work, verify before relying on it for a real workshop_ — do a full
rehearsal (join, slide sync, step tracking, error reporting, presenter
controls) against your actual static hosting setup before running a live
session on it, not just `pnpm dev`. If you don't have time to verify it,
the safe fallback is running `slidev dev`/`preview` behind a process
manager instead of a true static export — slower to set up, but exercises
the same code path the local quick start already uses.

## 2. Configuration reference

### `muan-companion-server` (runtime env vars)

| Variable                               | What it does                                                                                                                                                                                                                                | Default                                        | Required?                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                 | TCP port the HTTP + Socket.io server listens on.                                                                                                                                                                                            | `3710`                                         | No                                                                                                                                                                                                                                         |
| `SLIDEV_MUAN_COMPANION_ROOM_CODE`      | Low-privilege shared secret participants supply to `participant:join`.                                                                                                                                                                      | Auto-generated fresh on every startup if unset | No — an explicit value only matters if you want the _same_ code across restarts (e.g. a recurring demo); the server is fully functional with none set.                                                                                     |
| `SLIDEV_MUAN_COMPANION_PRESENTER_CODE` | High-privilege secret required for every `presenter:*` event and to open `/dashboard`. Never derivable from the room code.                                                                                                                  | Auto-generated fresh on every startup if unset | No — same as the room code above.                                                                                                                                                                                                          |
| `SLIDEV_MUAN_COMPANION_ORIGIN`         | CORS origin allowed to connect (the deck's origin, since it's cross-origin to this server — see §6).                                                                                                                                        | `*`                                            | No, but set it explicitly in production (see §6).                                                                                                                                                                                          |
| `SLIDEV_MUAN_COMPANION_DECK_URL`       | Base URL of the participant-facing Slidev deck — a _different_ process/port than this server. Used only to build the shareable join link (`${SLIDEV_MUAN_COMPANION_DECK_URL}?roomCode=${roomCode}`) and the QR code shown on the dashboard. | `http://localhost:3030`                        | No for a local trial (the default matches Slidev's own default dev port); **yes, set it** in production — otherwise the dashboard's join link/QR point at `localhost:3030`, which is meaningless to anyone but the operator's own machine. |

### The deck (build-time env var)

| Variable                                | What it does                                                                                                                                                                                                                              | Default                 | Required?                                                                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL` | Base URL of the sync server that the deck's addon JS connects to, for both the Socket.io connection and the `POST /api/screenshot` error-report upload. Read once at build/dev-server start (Vite env var), baked into the deck's bundle. | `http://localhost:3710` | No for local dev; **yes, set it** for any deployment where the deck isn't served from the same machine/port as the sync server. |

## 3. Local quick start

Two terminals, same shape as the demo. The two code env vars are optional
for a quick local trial — omit them and the server generates fresh ones on
startup (see §2's table) — but pass them explicitly if you want fixed,
memorable codes across restarts:

```bash
# Terminal 1 — the sync server
cd packages/muan-companion-server
SLIDEV_MUAN_COMPANION_ROOM_CODE=<pick-a-room-code> \
  SLIDEV_MUAN_COMPANION_PRESENTER_CODE=<pick-a-presenter-code> \
  pnpm dev
```

```bash
# Terminal 2 — the deck
cd demo/muan-companion
pnpm dev
```

This is fine for rehearsing locally but isn't a deployment — both processes
die when you close the terminals, and nobody outside your machine's network
can reach either one.

## 4. Production build

**Sync server** — build once, then run the built output directly with Node
(no dev-server, no file watching):

```bash
pnpm --filter muan-companion-server build   # tsdown -> packages/muan-companion-server/dist/index.mjs

SLIDEV_MUAN_COMPANION_ROOM_CODE=<...> \
  SLIDEV_MUAN_COMPANION_PRESENTER_CODE=<...> \
  SLIDEV_MUAN_COMPANION_ORIGIN=https://your-deck-host.example \
  SLIDEV_MUAN_COMPANION_DECK_URL=https://your-deck-host.example \
  PORT=3710 \
  node packages/muan-companion-server/dist/index.mjs
```

Note `dist/index.mjs` isn't fully self-contained: tsdown only externalizes
`@slidev/*` packages (see the repo root `tsdown.config.ts`), so
`socket.io`/`connect`/`sirv`/`pathe`/`busboy` remain real `node_modules`
imports — run this from a checkout with `node_modules` installed (or see the
Docker image in §5, which handles this for you).

**The deck** — build the static export, pointing the addon at wherever the
sync server actually lives:

```bash
cd demo/muan-companion   # or your own deck
VITE_SLIDEV_MUAN_COMPANION_SERVER_URL=https://sync.your-workshop.example \
  pnpm build   # slidev build -> ./dist (a static site)
```

Serve the resulting `dist/` directory with any static file server (nginx,
Caddy, `sirv`, a CDN — whatever you already use). Remember §1's caveat: this
static-export path is a reasoned inference from the client code, not a
tested deployment path — rehearse the full flow against it before a real
session.

## 5. Docker

A `Dockerfile` and `.dockerignore` are provided for
`packages/muan-companion-server` — a single persistent Node process with a
clean build-then-run split is a natural fit for a container, and it's the
piece most likely to end up on a VM/cluster rather than someone's laptop.
No Dockerfile is provided for the deck: it's a static export (§4), so it
doesn't need a container any more than any other static site would — bake
it into whatever static-hosting image or pipeline you already use.

The Dockerfile builds `muan-companion-server` inside the full pnpm
workspace (its `package.json` uses `catalog:` version refs from
`pnpm-workspace.yaml`, which only resolve inside the workspace, and pnpm
has no way to install from just one member's manifest), then copies the
built `dist/`, `public/` (the dashboard's static assets — `server.ts`
resolves them relative to its own compiled location on disk, so they must
ship alongside `dist/`), `package.json`, and the workspace's hoisted
`node_modules` (`shamefullyHoist: true` is set in `pnpm-workspace.yaml`,
so the flat root `node_modules` already has everything the server imports
at runtime) into a slim runtime stage. It's a real multi-stage build, not
copy-everything-and-run.

Because of the `catalog:` dependency, **build with the repo root as
context**, pointing `-f` at the Dockerfile's actual location:

```bash
# from the repo root
docker build -f packages/muan-companion-server/Dockerfile -t muan-companion-server .
```

```bash
docker run -d \
  -p 3710:3710 \
  -e SLIDEV_MUAN_COMPANION_ROOM_CODE=<...> \
  -e SLIDEV_MUAN_COMPANION_PRESENTER_CODE=<...> \
  -e SLIDEV_MUAN_COMPANION_ORIGIN=https://your-deck-host.example \
  -e SLIDEV_MUAN_COMPANION_DECK_URL=https://your-deck-host.example \
  --name muan-companion-server \
  muan-companion-server
```

**Verified**: this Dockerfile was actually built and run in this
repository's sandbox (`docker build` succeeded end-to-end, and the
resulting container correctly returned 401 for `GET /dashboard` without a
code, 200 with the right `?code=`, and answered a real Socket.io
handshake) — this is a confirmed-working build, not just a plausible one.

**One caveat on the `.dockerignore` specifically**: because the intended
build context is the repo root (not `packages/muan-companion-server/`
itself), a plain `.dockerignore` sitting next to the Dockerfile is _not_
picked up automatically by Docker/BuildKit for the command above — Docker
only auto-applies a context-root `.dockerignore`, or (BuildKit only) a
file named after the Dockerfile at its context-relative path (i.e.
`packages/muan-companion-server/Dockerfile.dockerignore`). This was
confirmed experimentally: building with only
`packages/muan-companion-server/.dockerignore` present sent the _entire_
repo (1.5GB+, including `node_modules`) as build context; naming a copy
`Dockerfile.dockerignore` at that same path cut it to ~19MB. Until this is
made more convenient, either copy `packages/muan-companion-server/.dockerignore`
to the repo root as `.dockerignore` before building, or duplicate it as
`packages/muan-companion-server/Dockerfile.dockerignore` — the file's own
header comment repeats this.

## 6. Networking & HTTPS

The PRD requires a secure context for screen capture (the error-report
screenshot feature): browsers only allow it over HTTPS or on `localhost`.
Anything beyond a `localhost` demo needs TLS in front of the sync server.

Two different origins are involved, and they have different needs:

- **The dashboard and `POST /api/screenshot`** are served by the sync
  server itself and requested by browsers pointed directly at it — **same
  origin**, so no CORS configuration is needed for either.
- **The deck** is a separate origin (different host/port from the sync
  server) making cross-origin Socket.io/HTTP calls into it — that's what
  `SLIDEV_MUAN_COMPANION_ORIGIN` (CORS) is for. Set it to the deck's exact
  origin in production; the `*` default is fine for local dev only.

Example: **nginx** terminating TLS and reverse-proxying to the Node
process, with the WebSocket-upgrade headers Socket.io needs (a very common
place to get this wrong — a proxy that doesn't forward `Upgrade`/
`Connection` will let the initial HTTP polling handshake through but the
WebSocket upgrade will silently fail or fall back to slow, flaky long
polling):

```nginx
server {
    listen 443 ssl http2;
    server_name sync.your-workshop.example;

    ssl_certificate     /etc/letsencrypt/live/sync.your-workshop.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.your-workshop.example/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3710;

        # Required for the Socket.io WebSocket upgrade — without these
        # three lines the handshake still succeeds over HTTP polling, but
        # silently never upgrades to a real WebSocket.
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Socket.io connections are long-lived; don't let nginx's default
        # timeouts kill an idle-but-open WebSocket mid-workshop.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

server {
    listen 80;
    server_name sync.your-workshop.example;
    return 301 https://$host$request_uri;
}
```

Point `muan-companion-server` at `PORT=3710` behind this (or your own
choice of port), and set `SLIDEV_MUAN_COMPANION_ORIGIN` to the deck's
`https://` origin so the CORS check on the Socket.io handshake passes.

If the deck is also served over plain HTTP instead of HTTPS, screen
capture will fail there too, regardless of whether the sync server has
TLS — put the deck behind TLS as well (same approach: a static file host
with its own TLS termination, or the same reverse-proxy pattern serving
static files instead of proxying).

## 7. Process management

As an alternative or complement to Docker, run the built server as a
systemd service:

```ini
# /etc/systemd/system/muan-companion-server.service
[Unit]
Description=muan-companion-server (Slidev workshop sync server)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/muan-companion-server
ExecStart=/usr/bin/node dist/index.mjs
Environment=PORT=3710
Environment=SLIDEV_MUAN_COMPANION_ROOM_CODE=changeme-per-workshop
Environment=SLIDEV_MUAN_COMPANION_PRESENTER_CODE=changeme-per-workshop
Environment=SLIDEV_MUAN_COMPANION_ORIGIN=https://your-deck-host.example
Environment=SLIDEV_MUAN_COMPANION_DECK_URL=https://your-deck-host.example
Restart=on-failure
RestartSec=2
User=muan-companion
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

`/opt/muan-companion-server` here means a deployment of this package with
`node_modules` installed and `dist/` built (e.g. the same tree produced by
the Docker build's builder stage, copied out, or a plain `pnpm install &&
pnpm --filter muan-companion-server build` on the target machine). Reload
and enable with the usual `systemctl daemon-reload && systemctl enable
--now muan-companion-server`. Update the two `Environment=` code lines and
restart between workshops — see §8.

## 8. Security notes

- **Both codes are secrets.** Treat `SLIDEV_MUAN_COMPANION_ROOM_CODE` and
  `SLIDEV_MUAN_COMPANION_PRESENTER_CODE` like passwords: don't commit them
  to the repo, don't put them in shell history you'll paste elsewhere, and
  don't post them somewhere public. Only the **room** code is meant for
  participants — the presenter code is yours alone (it controls slide
  navigation and opens the dashboard).
- **Don't post the presenter code or dashboard URL in the same public
  channel as the room code.** The room code is fine to put on a slide or
  say out loud to the room; the dashboard URL (`.../dashboard?code=...`)
  and the presenter code should only ever reach the instructor.
- **Rotate both codes between separate workshops.** Reusing a code across
  sessions means a past participant can still join or (worse) still hold a
  working presenter URL from before. This is now the default behavior, not
  something you have to remember: if you don't set the two code env vars,
  a fresh room code and presenter code are generated on every server
  start, so simply restarting between workshops rotates both. Only set the
  env vars explicitly if you specifically want the _same_ codes to survive
  a restart (e.g. a recurring demo) — there's still no in-app
  regenerate-_while running_-without-a-restart feature.
- A server restart with different env vars invalidates every URL built
  from the old codes — see §9's 401 entry.

## 9. Troubleshooting

- **`EADDRINUSE` on startup.** Something else is already bound to the
  port (default `3710`). Find and stop it (`lsof -i :3710`, or your
  platform's equivalent), or start this server with a different `PORT`.
- **Dashboard returns 401.** The `?code=` in the dashboard URL doesn't
  match the server's _currently configured_ `SLIDEV_MUAN_COMPANION_PRESENTER_CODE`.
  This is expected after a server restart with a different (or newly
  rotated) presenter code — every previously-handed-out dashboard URL
  stops working immediately, since the check is against live config, not
  a stored value. Re-share the dashboard URL with the new code.
- **Slides aren't syncing to participants.** Check the presenter's own
  deck URL _first_: it needs `?presenterCode=<the presenter code>`
  appended (e.g. `.../presenter/1?presenterCode=...`). Without it, every
  `presenter:setSlide`/`presenter:setStep` the addon sends is a **silent
  no-op** on the server — no error in the browser console, no error on
  the server, nothing in the UI. This is the single most common
  "it's just not working" report and the first thing to check before
  suspecting CORS, the sync server being down, or anything else.
