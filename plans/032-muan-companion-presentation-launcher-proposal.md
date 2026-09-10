# Plan 032 (proposal): Server-hosted presentation dashboard, deck launcher, and connect-key registration

> **Status of this document**: a PROPOSAL, not an executor-ready plan like
> 026-030. It answers a new architecture request from the owner (AnuchitO) —
> turn `muan-companion-server` from "waits for one pre-started deck" into
> "lists presentations, launches or accepts them, hands back presenter/
> participant URLs" — with a recommended design, but nothing here should be
> implemented until the owner signs off on scope/sequencing, same posture
> as 031.
>
> **Depends on / supersedes part of**: 031's Q2 ("can one server run
> multiple concurrent sessions?"). 031 treated multi-room (its "Option B")
> as *optional*, only worth building if running N separate processes ever
> stopped being enough. This proposal's dashboard — one screen listing
> multiple presentations, any of which can be live at once — makes Option B
> a **prerequisite**, not a someday item. Read 031 first; this document
> assumes its Q2/Option B section as background and does not re-derive it.
> 031's Q1 (self-serve codes) and Q3/Q4 (lobby, practice mode) are
> unaffected by this proposal and can land independently, in either order.

## The ask, restated

Today an operator manually starts a Slidev deck process *and* separately
starts `muan-companion-server`, then wires them together with env vars
(`muan-companion.md` §2-3). The owner wants the server to become the
starting point instead:

1. **Server-launched decks.** The server has a dashboard listing
   presentations — folders of Slidev decks it knows about. Pick one, click
   Present, and the server starts that deck itself and gives back a
   presenter URL and a participant URL.
2. **Deck-initiated registration.** Separately, someone already running
   `slidev dev` themselves (own laptop, own workflow) should be able to
   connect that deck to the server using an authentication key, so it shows
   up on the dashboard the same way — without the server having started it.

Both flows need to end up in the same place: a dashboard entry with a live
session, a presenter URL, and a participant URL. The two clarifying
decisions the owner made when this was scoped:

- Flow A spawns decks **on the server's own machine/filesystem** — no
  remote-exec, no SSH-to-another-host design needed.
- Flow B's connect key is **per-session, one-time, dashboard-generated** —
  not a single long-lived shared secret like today's room/presenter codes.

## Two new concepts

Today's `session.ts` has exactly one `WorkshopSession`, module-level. This
proposal splits "a deck that exists" from "a deck that's live" into two
layers:

- **Presentation** — something presentable, not necessarily running. For
  Flow A: a folder under a configured root directory containing a Slidev
  deck (detected by `slides.md` + the `muan-companion` addon configured in
  its frontmatter/`package.json`, so folders that can't actually sync don't
  show up as falsely presentable). Flow B decks don't need a Presentation
  entry at all — they arrive already running.
- **Session** — a live instance: today's `WorkshopSession` shape, but one of
  potentially several, each keyed by its own room code (per 031 Q2's
  recommendation to use the room code itself as the map key, not a separate
  `sessionId`). A Session optionally owns a **child process handle** (Flow
  A) or has none (Flow B, just a URL the server doesn't control the
  lifecycle of).

```
Map<roomCode, Session>
Session = WorkshopSession (from session.ts, per-room now instead of module-level)
        + { deckUrl, presenterCode, origin: 'spawned' | 'external' }
        + (origin: 'spawned' only) { process: ChildProcess, port, presentationId }
```

## Flow A — server-launched

1. **Discovery.** A configured root directory (e.g.
   `SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR`) is scanned for immediate
   subdirectories containing a Slidev entry deck. The dashboard's home
   screen lists these — title from frontmatter if present, folder name
   otherwise. This is read-only filesystem discovery, no new trust boundary
   by itself (scoped to one configured directory, not client-supplied
   paths — see Security below).
2. **Present.** Dashboard `POST`/socket event carries a Presentation id
   (never a raw path) chosen from the discovered list — the server resolves
   id → path itself, so a request can never name a directory outside the
   configured root.
3. **Launch.** Server picks a free port, spawns `slidev dev --port <n>`
   (`node:child_process.spawn`, not `exec` — this repo already prefers
   `execFile`/`spawn` over shell strings per plan 006) in that folder, with
   `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL` set in the child's env to the
   server's own externally-reachable URL. This works because Slidev's
   `dev` command *is* a Vite dev server, and Vite resolves `VITE_*` env vars
   from `process.env` at the same point whether the process was started by
   a human or spawned programmatically — no new mechanism needed on the
   addon/client side (`getMuanCompanionServerUrl()` in
   `packages/addon-muan-companion/src/client.ts` is unaffected).
4. **Readiness.** Poll the child's stdout for Vite's "ready" line, or poll
   the port with HTTP HEAD requests until it answers — either is fine;
   Vite's own dev server has no separate healthcheck endpoint to rely on.
5. **Register.** Once ready, generate a fresh room/presenter code pair
   (reuse `codeGeneration.ts` as-is), create the Session entry keyed by the
   new room code, and return `{ presenterUrl, participantUrl }` to whoever
   clicked Present — same URL shapes as today
   (`buildJoinUrl`/`.../presenter/1?code=...`), just computed per-session
   instead of once at server boot.
6. **Lifecycle.** A "Stop" action on the dashboard kills the child process
   and removes the Session. The server should also react to the child
   exiting on its own (crash, someone Ctrl-C'd it directly) by tearing down
   the Session and notifying any connected dashboard/participants — don't
   leave a Session pointing at a dead process.

## Flow B — deck-initiated connect

1. Dashboard has a "Connect a running deck" action (no folder involved —
   this is for a deck the server didn't start). Clicking it mints a
   **connect key**: single-use, short TTL (e.g. 5 minutes), generated with
   the same `generateCode`/entropy approach `codeGeneration.ts` already
   uses for room/presenter codes. Displayed once, not persisted anywhere
   retrievable after the fact.
2. Operator sets that key as an env var when starting their own
   `slidev dev` (e.g. `SLIDEV_MUAN_COMPANION_CONNECT_KEY`, alongside the
   existing `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL` pointed at the server).
3. The addon calls a new endpoint — `POST /api/register` fits the existing
   pattern better than a socket event, since it's a one-shot action prior
   to any session existing, and mirrors how `screenshotUpload.ts` already
   does one-shot HTTP POSTs alongside the Socket.io surface — with the key
   and its own public deck URL.
4. Server validates the key (exists, unused, unexpired — reject and burn
   the attempt otherwise, same fail-closed posture as every other
   `auth.ts` check), creates a Session exactly as Flow A's step 5 does
   (fresh room/presenter codes, `origin: 'external'`, no process handle),
   and returns the same `{ presenterUrl, participantUrl }` shape via the
   HTTP response *and* pushes a `state:update` so an already-open dashboard
   sees the new Session appear live, the same mechanism `broadcastStateUpdate`
   already uses for participant-roster changes.
5. Key is burned (single-use) the moment registration succeeds or fails
   with a wrong/expired key past some small attempt budget — this is new
   surface reachable with a credential that (unlike room/presenter codes)
   didn't require already having *another* credential to obtain, so it
   deserves the same explicit security-review pass 031 flagged for its own
   unauthenticated-setup-window idea (§Q1/4.2b) — this is a sibling case of
   the same problem, not a new class of it.

## What this requires from 031's Option B

This proposal cannot be built on top of today's singleton `session.ts`
without first doing the multi-room re-keying 031 described:

- `session`, `participants`, `stepStatus`, `errorReports` → all become
  `Map<roomCode, ...>`, keyed by room code (031's own recommendation).
- Every `server.ts` handler resolves "which room" from `socket.data.roomCode`
  (set once at join time), same pattern `socket.data.participantId` already
  uses.
- `DASHBOARD_ROOM` → `` `dashboard:${roomCode}` `` per session, *plus* one
  more room above that: a `dashboard:home` room for the presentation-list/
  session-list view itself, which is genuinely new (031 didn't need a
  "list of sessions" view, only per-session dashboards).
- `getJoinQrDataUrl`'s one-Promise-per-process cache → one per room (031's
  addendum already flagged this).
- `uploadsDir`'s `mkdtempSync` → one per room, not per process (031's
  addendum already flagged this too).
- `pendingConnections` (keyed by raw socket id, no room info today) needs a
  room hint added at connection time — 031's addendum called this out as an
  open wire-contract question; this proposal makes it a forced decision
  rather than a someday one, since without it two simultaneous sessions
  can't tell "someone's here but hasn't joined" apart.

None of this is new work invented by this proposal — it's 031's own
inventory, now load-bearing instead of optional.

## New server responsibilities (genuinely new, not in 031)

- **Filesystem discovery** of presentations under a configured root.
- **Process management**: spawn, readiness-probe, log capture (at least
  stderr, for surfacing "this deck failed to start" instead of a silent
  timeout), stop, and reap-on-crash for Flow A's child processes.
- **Port allocation** for spawned decks (ephemeral, checked-free before
  spawn — two Presentations started back-to-back must not collide).
- **Connect-key issuance/validation** for Flow B, as its own small module
  parallel to `auth.ts`'s existing room/presenter-code checks, not folded
  into it — different lifecycle (single-use + TTL vs. long-lived-until-
  restart) deserves its own code path even though the "compare a shared
  secret" shape looks similar.
- **A home dashboard view** above the existing per-session dashboard:
  Presentation list (Flow A) + Session list (both flows) + "Connect a
  deck" action (Flow B). The existing per-session dashboard
  (`public/dashboard/index.html`) becomes what you land on *after* picking
  or starting a session, not the only screen.

## Security notes (read before implementing, not after)

- **Never accept a filesystem path from a request.** Flow A's Present
  action must take a Presentation *id* resolved server-side against the
  discovered list, exactly like `getSlidePath` was hardened in plan 010 —
  the discovery root is a config value, not client input, full stop.
- **`spawn`, never `exec`/shell strings**, for the same reason plan 006
  already fixed this pattern elsewhere in the codebase — a folder name or
  deck config is not something to interpolate into a shell command.
- **The connect key is a new unauthenticated-adjacent surface** — reachable
  with a credential that (unlike the room/presenter codes) is mintable by
  anyone who can already reach the dashboard as presenter, but the
  *registration* endpoint itself sits in front of session creation, before
  any session-level auth exists yet. Rate-limit attempts, burn on first
  failure past a tiny retry budget, and TTL it aggressively. This is the
  same category of risk 031 flagged for its own bootstrap idea — treat both
  with the same level of review before shipping either.
- **Resource exhaustion**: spawning arbitrary numbers of `slidev dev`
  processes from a dashboard is a new way to run the host out of ports/
  memory that didn't exist when this was "one operator manually starts one
  process." Cap concurrent spawned sessions (a config value, not a magic
  number) and reject Present requests past the cap with a clear error
  rather than degrading silently.
- **Orphaned processes on server crash/restart**: a spawned child survives
  its parent unless explicitly killed on shutdown — wire `SIGTERM`/`SIGINT`
  handlers in `index.ts` to kill every tracked child before exiting, or a
  server restart leaves zombie `slidev dev` processes bound to ports the
  new server instance then can't reuse.

## Recommended sequencing

| # | Item | Depends on | Effort | Notes |
|---|------|------------|--------|-------|
| 032a | Multi-room re-keying (031's Option B, now required) | — | L | Prerequisite for everything below; touches `session.ts`/`server.ts` almost entirely, per 031's own estimate |
| 032b | Home dashboard: presentation discovery + session list (read-only) | 032a | M | No process spawning yet — just list folders and list live Sessions |
| 032c | Flow A: spawn/stop/reap lifecycle for server-launched decks | 032b | L | The process-management piece; highest new-code volume |
| 032d | Flow B: connect-key issuance + `/api/register` | 032a | M | Independent of 032c — can be built in parallel once multi-room exists |
| 032e | Security-review pass on 032c (spawn surface) + 032d (connect-key surface) | 032c, 032d | S-M | Do not skip — see Security notes above |

032b/032d together are the smallest path to something demoable (list
existing manually-started sessions + let a deck register itself) without
yet touching process spawning at all — worth considering as a first
milestone if the owner wants to de-risk the multi-room refactor before
committing to the larger process-launcher piece.

## Open questions for the owner

1. **Presentation discovery root**: one fixed configured directory (each
   subfolder = one deck, e.g. `demo/`-style layout), or should the server
   also accept an explicit list (config file) of paths instead of scanning?
   A scan is simpler to operate; an explicit list avoids surprising a
   presenter with folders they didn't intend to expose.
2. **Flow A process mode**: `slidev dev` (hot-reload, matches today's local
   quick-start) or `slidev build && slidev preview` (closer to a production
   static export, per `muan-companion.md` §1's own unverified-static-export
   caveat)? `dev` is the safer default given that caveat is explicitly
   "not yet verified end-to-end" — recommend `dev` unless there's a reason
   to prefer built output.
3. **Cap on concurrent spawned sessions**: a specific number, or should it
   just be a config value the owner sets per-deployment with a sane default
   (e.g. 4)?
4. **Does Flow B's registering deck need to be shown *before* the presenter
   confirms it** (i.e., a pending/approve step), or should registration
   with a valid key be sufficient on its own, same as how `participant:join`
   with a valid room code needs no separate approval today? Recommend the
   latter for consistency with the existing auth model, but flagging since
   it's a real trust decision, not just an implementation detail.
