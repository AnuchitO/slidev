# workshop-tracker-server

Realtime sync server for [`slidev-addon-workshop-tracker`](../addon-workshop-tracker).
Currently implements **M1 (slide sync), M2 (participant identity + step
tracking + a minimal dashboard), M3 (error reporting: text + screenshot
upload), and M4 (presence tracking + presenter/dashboard auth)** of the
workshop-tracking initiative. See
[`plans/026-workshop-tracker-m1-slide-sync.md`](../../plans/026-workshop-tracker-m1-slide-sync.md),
[`plans/027-workshop-tracker-m2-step-tracking.md`](../../plans/027-workshop-tracker-m2-step-tracking.md),
[`plans/028-workshop-tracker-m3-error-reporting.md`](../../plans/028-workshop-tracker-m3-error-reporting.md),
[`plans/029-workshop-tracker-m4-presence-auth.md`](../../plans/029-workshop-tracker-m4-presence-auth.md),
and [`plans/prd-workshop-tracking.md`](../../plans/prd-workshop-tracking.md)
for the full scope and roadmap (M5 — reconnect/resume hardening + load
testing is the only milestone still ahead).

This package is **private** — it's not published, it's the workshop
operator's own backend process, run alongside the Slidev dev server for the
duration of a workshop.

## Usage

```bash
WORKSHOP_ROOM_CODE=<pick-one> WORKSHOP_PRESENTER_CODE=<pick-another> \
  pnpm --filter workshop-tracker-server dev
```

Starts an HTTP + Socket.io server listening on `:3710` (override with the
`PORT` env var). `WORKSHOP_TRACKER_ORIGIN` sets the CORS origin allowed to
connect (defaults to `*`). The instructor dashboard is served by the same
process at `/dashboard` (see "Dashboard" below).

`WORKSHOP_ROOM_CODE` and `WORKSHOP_PRESENTER_CODE` (see "Auth" below) — if
either is unset, the server still starts (so `pnpm build`/CI don't need
secrets configured) but logs a startup warning and **rejects every
`participant:join`, `presenter:*` event, and dashboard connection** until
both are set. Fail closed, not open.

## Auth (plan 029 / PRD §12)

Two separate, operator-chosen secrets, checked with a constant-time compare
(`src/auth.ts`) so a wrong guess doesn't leak timing information:

- **`WORKSHOP_ROOM_CODE`** — low-privilege. Required in every
  `participant:join { name, roomCode }`; a wrong/missing code is rejected via
  the join ack (`{ error: 'invalid_room_code' }`, no participant created) —
  the socket stays connected so the client can show an inline error and
  retry rather than being force-disconnected.
- **`WORKSHOP_PRESENTER_CODE`** — high-privilege. Required, as
  `presenterCode`, in every `presenter:setSlide`/`presenter:setStep` payload
  and in `dashboard:join { presenterCode }`. **Deliberately never derivable
  from the room code** — a participant who knows the room code still cannot
  move slides or open the dashboard. Invalid/missing `presenterCode` on
  `presenter:*` is a silent no-op (matches those events' pre-existing
  no-ack shape); on `dashboard:join` it acks `{ ok: false }` instead of
  joining the dashboard room.
- **`/dashboard`'s static HTTP route** is separately gated by a
  `requireDashboardCode` middleware (`src/server.ts`) checking a `?code=`
  query param against the same presenter code, mounted _before_ `sirv` so an
  invalid/missing code never reaches the static file handler — a 401 is
  returned instead. `public/dashboard/index.html`'s own script reads that
  same `?code=` back out of `location.search` to authenticate its
  `dashboard:join` call, so the operator only ever has to hand out one URL
  (e.g. `http://host:3710/dashboard?code=<presenterCode>`) for the whole
  flow to work.

**Threat model actually achieved**: neither code is ever embedded in any
served JS bundle (participants and the presenter load the _same_ addon
bundle — see `getPresenterCodeFromUrl` in the addon package's own README for
why that rules out any build-time env var for the presenter code). Both
codes only ever travel (a) typed by a human into the join screen / appended
to a URL by the operator, and (b) over this server's own Socket.io/HTTP
connections. This is **LAN-workshop-appropriate, not SaaS-grade**: there is
no rate-limiting on join/presenter-code attempts (a scriptable client could
brute-force a short code over many attempts), no TLS is provided by this
package itself (run behind a TLS-terminating proxy for any non-`localhost`
deployment, or the codes travel in the clear), and the codes are static for
the whole session (no rotation, no per-participant tokens). Choose codes
with enough entropy to resist casual guessing for your session's size/
duration; don't reuse a workshop's room code as a password anywhere else.

## Events

**M1 (slide sync)**

- `presenter:setSlide { index, presenterCode }` (client → server) —
  requires a valid `presenterCode` (see "Auth" above; invalid/missing is a
  silent no-op). Rebroadcast to everyone as `slide:changed { index }`, and
  stored as the session's current slide.
- `slide:changed { index }` (server → all clients) — a slide change happened.
- `slide:sync { index }` (server → the newly-connected client only) — sent
  immediately on connect so a participant who joins/reloads mid-session lands
  on the presenter's current slide rather than slide 1. This isn't in the
  PRD's §10 event list verbatim; it's the minimum addition needed to make
  `slide:changed` (a rebroadcast-only event) useful to late joiners, and is a
  deliberate, documented decision — not scope creep. Don't remove it without
  updating plan 026's status.

**M2 (participant identity + step tracking)**

- `participant:join { name, roomCode, participantId? }` → `ack({ participantId, currentSlideIndex } | { error: 'invalid_room_code' })`
  — requires a valid `roomCode` (see "Auth" above). Creates a new
  participant, or (if `participantId` matches an existing record — see the
  addon's `JoinScreen.vue`, which persists it to `sessionStorage`) reuses it
  instead of creating a duplicate. A client-supplied `participantId` is only
  ever used to _look up_ an existing record, never trusted as the id of a
  new one.
- `participant:copy { stepId }` / `participant:done { stepId }` → `ack({ stepId, state })`
  — records `stepStatus[participantId:stepId] = 'copied' | 'done'` and
  broadcasts `state:update` to the dashboard room. No-ops (silently) if the
  socket hasn't called `participant:join` yet.
- `presenter:setStep { stepId, presenterCode }` (client → server) — requires
  a valid `presenterCode`. Sets the session's `currentStepId`, broadcast to
  the dashboard via `state:update`. **Not** the same event as
  `presenter:setSlide`, and not in PRD §10's literal list — see the addon's
  `StepReporter.vue` for why the presenter's _slide index_ and its
  frontmatter-derived _stepId_ need separate reporting mechanisms (a real,
  empirically-discovered gap in the milestone's original plan, not a
  hypothetical one).
- `dashboard:join { presenterCode }` → `ack({ ok: boolean })` (client →
  server) — requires a valid `presenterCode`. Joins the Socket.io
  `dashboard` room and immediately receives one `state:update` snapshot
  (mirrors `slide:sync`'s late-joiner pattern) only if `ok`. Participant
  sockets never emit this.
- `state:update { currentSlideIndex, currentStepId, participants[], stepStatus[] }`
  (server → dashboard room only) — sent on every state-affecting event above
  plus `disconnect`/the staleness sweep. Room-scoped, not broadcast to every
  connected socket, so participant clients don't receive the full roster/
  step-status payload on every other participant's keystroke.

**M4 (presence)**

- `participant:visibility { state: 'visible' | 'hidden' }` (client → server)
  — sent by the addon's `PresenceReporter.vue` on the Page Visibility API's
  `visibilitychange`. Only these two values are trusted from a client; a
  `'closed'` report is ignored (that state is only ever inferred
  server-side — see below).
- `participant:heartbeat { stepId }` (client → server) — sent every
  `HEARTBEAT_INTERVAL_MS` (5s, `src/presence.ts`). Refreshes `lastSeen`; no
  `state:update` broadcast on its own (a bare liveness tick doesn't change
  anything the dashboard renders).
- A participant is marked `visibility: 'closed'`, `connected: false` in two
  ways: **immediately** on a clean Socket.io `disconnect` (`src/server.ts`),
  or, for a _hung_ connection that never fires one (flaky workshop wifi), by
  a periodic sweep (`sweepStaleParticipants`, `src/presence.ts`) that runs
  every `HEARTBEAT_INTERVAL_MS` and closes a participant once its `lastSeen`
  is stale (> `STALE_AFTER_MS`, 3x the heartbeat interval) **and** its
  socket is no longer actually connected. Staleness alone is never enough —
  see that function's own doc comment.

**M3 (error reporting)**

- `participant:error { stepId, text }` (client → server) — the **text-only**
  error-report path (PRD §10). No-ops (silently) if the socket hasn't called
  `participant:join` yet, same rule as `participant:copy`/`done`.
- `presenter:resolveError { errorId, presenterCode }` (client → server) —
  requires a valid `presenterCode` (see "Auth" above; invalid/missing is a
  silent no-op, same shape as `presenter:setSlide`/`setStep`). Marks that
  `ErrorReport.resolved = true` and broadcasts `state:update`. Unknown
  `errorId` (with a valid code) is a no-op, not an error.
- `state:update` now also carries `errors: ErrorReport[]` — folded into the
  existing event (PRD §10's literal `state:update { currentSlideIndex,
participants[], errors[] }` shape) rather than a new event, per plan 028
  Step 1's decision: error reports are rare compared to step-status churn,
  so the combined payload isn't a size/frequency problem, and the dashboard
  client needs no restructuring beyond rendering a new field.
- `POST /api/screenshot` (multipart: `participantId`, `stepId`, `text?`,
  `screenshot`) — the **screenshot** error-report path (PRD §10's REST
  upload). Deliberately the _only_ path that accepts a screenshot; a request
  with no `screenshot` file is rejected with 400 pointing at the WS
  `participant:error` event instead — the two paths never duplicate the
  identical text-only responsibility. Validates `participantId` against the
  registry (unknown ids are rejected, 400) and caps the uploaded file at
  **5MB** (`UPLOAD_MAX_BYTES`, `src/uploads.ts`) — a `busboy`
  (`streamsearch` is its only transitive dep) multipart parser, added fresh
  since nothing in the existing `socket.io`/`connect`/`sirv` dependency
  footprint covers file uploads. Responds `201 { id, screenshotUrl }` on
  success.
- `GET /uploads/:filename` — serves an uploaded screenshot back. Every file
  is written under a **session-scoped `mkdtemp`-ed directory** (a fresh
  temp dir per server instance/process, not a fixed path in the repo) with
  a server-generated `${randomUUID()}.${ext}` name — the multipart client
  `filename` field is never used to construct a path, so there's nothing
  for a crafted `../`-laden client filename to traverse with on the write
  side. On the read side, `src/uploads.ts`'s `resolveUploadPath` rejects
  any request whose filename doesn't match that exact
  `uuid.(png|jpg|webp)` shape _before_ `sirv` ever touches the filesystem —
  defense-in-depth on top of `sirv`'s own path normalization, mirroring the
  "constrain the shape, then confirm containment" discipline from
  `plans/016-confine-export-output-path.md`. No retention/cleanup policy
  for these files beyond the process's own temp-dir lifetime — no
  requirement in the PRD for cross-restart persistence (§4 non-goals), so
  none was built; flagged as a 030 hardening candidate if disk usage over a
  long session turns out to matter.

## Dashboard

A small static page at `/dashboard` (served from `public/dashboard/` via
`connect` + `sirv`, mounted on the _same_ `httpServer` Socket.io attaches
to — see `src/server.ts`'s comment on why that ordering matters and why it's
safe), gated on the presenter code (see "Auth" above). Same origin as the
Socket.io server, so no CORS configuration is needed. Loads Socket.io's own
client bundle (`/socket.io/socket.io.js`, served by Socket.io by default)
and renders `state:update` payloads — no build step, no polling.

Shows: live counts (joined, viewing now, done-this-step/total, current
slide/stepId, open errors); a participant table (name, **presence** —
viewing now / away / closed, driven by `visibility` + `connected` rather
than `connected` alone — status for the _current_ step, joined at); and an
**error feed**: participant name, step, timestamp, text and/or a screenshot
thumbnail (click for a full-size lightbox — a plain image-swap overlay, no
new dependency), and a "Mark resolved" button wired to
`presenter:resolveError { errorId, presenterCode }`. Resolved reports stay
visible (dimmed, sorted after open ones) rather than disappearing — the
point is a dashboard reload still reflects resolved state, which lives in
the server's `ErrorReport.resolved` field, not client-side UI state. PRD
§11/§15's "never joined" presence state has no dedicated row: there's no
roster of expected participants in this single-session model, so it's
represented by simple absence from the table. Don't expand this into a full
SPA without re-reading plan 027's Step 3 trade-off note.

Access to the dashboard (both the HTTP route and its `dashboard:join` socket
call) requires the presenter code — see "Auth" above. There is no separate
"known security gap" section anymore: that gap was accepted-and-tracked
through M1–M3 and closed by M4 (this merge wires `presenter:resolveError`,
plan 028's addition, into the same presenter-credential gate as every other
`presenter:*`/dashboard-facing handler — see `src/server.ts`'s comment on
that handler for why it needed fixing up as part of merging M3 and M4
together).

## Testing

```bash
pnpm --filter workshop-tracker-server test
```

`src/server.test.ts` spins up real `socket.io-client` pairs (connected over
`transports: ['websocket']` — the default polling-then-upgrade handshake was
an observed source of intermittent multi-second stalls under this suite's
socket churn in sandboxed CI-like environments), and real `fetch()` multipart
requests, against an in-process server on an ephemeral port, and asserts the
full event contract above: room-scoped `state:update`, both auth-rejection
paths (wrong/missing room code, wrong/missing presenter code on each of
`presenter:setSlide`/`presenter:setStep`/`presenter:resolveError`/
`dashboard:join`), the presence events, and the `POST /api/screenshot` /
`GET /uploads/:filename` contract (valid upload, unknown `participantId`,
missing/oversized/unsupported-type file, and path-traversal rejection).
`src/auth.test.ts` unit-tests `auth.ts`'s constant-time code comparison,
`src/presence.test.ts` unit-tests `presence.ts`'s staleness sweep (fake
timers, no real sleeps), and `src/session.test.ts` / `src/uploads.test.ts`
cover the pure store/path logic directly. Left in place for 030 to extend
rather than starting from scratch.
