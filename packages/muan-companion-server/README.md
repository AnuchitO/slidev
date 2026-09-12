# muan-companion-server

Realtime sync server for [`slidev-addon-muan-companion`](../addon-muan-companion).
Implements the full **M1-M5** workshop-tracking initiative (slide sync,
participant identity + step tracking, error/help reporting, presence +
auth, reconnect/resume + load-tested hardening), plus three post-ship
passes: the **"Ask for Help" redesign** (two-way problem/question reports
with a confirm/reopen loop and presenter↔participant messaging, instead of
a one-shot "resolved"), **self-serve join** (auto-generated room/presenter
codes when unset, plus a shareable join link + QR code on the dashboard),
and **participant management** (pending-connection visibility for
not-yet-joined browsers, plus a presenter "kick" action). See
[`plans/026-workshop-tracker-m1-slide-sync.md`](../../plans/026-workshop-tracker-m1-slide-sync.md)
through
[`plans/030-workshop-tracker-m5-hardening.md`](../../plans/030-workshop-tracker-m5-hardening.md),
[`plans/prd-workshop-tracking.md`](../../plans/prd-workshop-tracking.md),
and [`plans/pr-proposal-muan-companion.md`](../../plans/pr-proposal-muan-companion.md)
(the full current-state writeup) for scope and history. Plan **032a** adds
single-process **multi-room** support on top of that — several concurrent,
fully isolated sessions in one server — see "Multi-room" below. The
cross-room home view that lists them, an in-app session-setup/lobby flow,
and a practice-mode slide remain proposed but unimplemented — see
[`plans/031-muan-companion-session-lifecycle-proposal.md`](../../plans/031-muan-companion-session-lifecycle-proposal.md).

This package is **private** — it's not published, it's the workshop
operator's own backend process, run alongside the Slidev dev server for the
duration of a workshop.

## Usage

```bash
SLIDEV_MUAN_COMPANION_ROOM_CODE=<pick-one> SLIDEV_MUAN_COMPANION_PRESENTER_CODE=<pick-another> \
  pnpm --filter muan-companion-server dev
```

Starts an HTTP + Socket.io server listening on `:3710` (override with the
`PORT` env var). `SLIDEV_MUAN_COMPANION_ORIGIN` sets the CORS origin allowed to
connect (defaults to `*`). The instructor dashboard is served by the same
process at `/dashboard` (see "Dashboard" below), and the cross-room home
view at `/home` (see "Home view (plan 032b)"). Two optional env vars belong
to that home view: `SLIDEV_MUAN_COMPANION_ADMIN_CODE` (its credential —
generated and logged at startup if unset) and
`SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR` (opt-in deck discovery — unset
means the presentation list is simply empty). Four more configure the deck
launcher those discovered decks are started with — see "Deck launcher (plan
032c)" for the table.

`SLIDEV_MUAN_COMPANION_ROOM_CODE` and `SLIDEV_MUAN_COMPANION_PRESENTER_CODE` (see "Auth" below) — if
either is unset, `index.ts` generates a fresh one (`src/codeGeneration.ts`,
plan 031a) and logs it at startup rather than leaving the server
unusable — an explicitly-set env var always overrides generation. Auth
itself (below) is unaffected: every `participant:join`, `presenter:*`
event, and dashboard connection is still checked against whichever code —
generated or configured — is actually live; there's no bypass, just no
requirement that an operator invent the value themselves.

## Auth (plan 029 / PRD §12)

Two separate, operator-chosen secrets, checked with a constant-time compare
(`src/auth.ts`) so a wrong guess doesn't leak timing information. (Plan 032b
adds a **third**, `SLIDEV_MUAN_COMPANION_ADMIN_CODE`, for cross-room
operator actions — see "Home view (plan 032b)" below. It uses the same
comparison primitive, is never accepted by any of the per-room gates listed
here, and none of them changed to accommodate it.)

- **`SLIDEV_MUAN_COMPANION_ROOM_CODE`** — low-privilege. Required in `participant:join
{ name, roomCode }` for a **fresh** join or a resume attempt whose
  `participantId` the server doesn't currently recognize; a wrong/missing
  code is rejected via the join ack (`{ error: 'invalid_room_code' }`, no
  participant created) — the socket stays connected so the client can show
  an inline error and retry rather than being force-disconnected. **Exempt**
  for a resume of an _already-known_ `participantId` (see "Real gap found:
  room code no longer needs to be stored client-side" below) — the room code
  provides no real protection there on top of the id itself, so requiring it
  only forced the addon to persist it indefinitely for no benefit.
- **`SLIDEV_MUAN_COMPANION_PRESENTER_CODE`** — high-privilege. Required, as
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

## Real gap found: room code no longer needs to be stored client-side

Raised in review, not a live-use bug report like the others in this file:
the addon originally persisted the room code in `localStorage` alongside
`participantId`/`name` (plan 029) so a silent resume could re-supply it
without re-prompting. On reflection, that's unnecessary standing exposure —
caching a workshop-scoped code indefinitely in a participant's browser, for
a code that's handed out to an entire room and isn't participant-specific
secret information in the first place.

The actual fix is on this side, not just the addon's: `participant:join`'s
room-code gate is now **skipped entirely for a resume of a `participantId`
the server already has a record for** (`isKnownResume` in `src/server.ts`).
The unguessable `participantId` (a 122-bit `crypto.randomUUID()` minted at
original join time) is itself the resume credential — the room code adds no
additional protection against identity hijacking on top of that, since every
participant already knows it. A resume attempt whose `participantId` the
server does _not_ recognize (unknown/stale — e.g. it restarted) still goes
through the full room-code gate, exactly like a brand-new join, so this
isn't a blanket exemption: it only ever skips the check once the identity
has already been proven once, this session, some other way.

This is what lets the addon's `participantIdentity.ts` stop persisting the
room code at all — see that module's own doc comment for the client-side
half, including how a silent auto-resume that the server can't honor (no
room code to fall back on) degrades to the ordinary join form rather than a
confusing "wrong code" error the participant never actually triggered.

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

- `participant:join { name, roomCode?, participantId? }` → `ack({ participantId, currentSlideIndex } | { error: 'invalid_room_code' })`
  — requires a valid `roomCode` for a fresh join or a resume of an unknown
  id; **not** for a resume of an already-known `participantId` (see "Auth"
  above and "Real gap found: room code no longer needs to be stored
  client-side" below). Creates a new participant, or (if `participantId`
  matches an existing record — see the addon's `JoinScreen.vue`, which
  persists just `{ participantId, name }` to `localStorage`) reuses it
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
- `dashboard:join { presenterCode }` → `ack({ ok, roomCode?, presenterCode?, deckUrl?, joinUrl?, joinQrDataUrl? })`
  (client → server) — requires a valid `presenterCode`. Joins the Socket.io
  `dashboard` room and immediately receives one `state:update` snapshot
  (mirrors `slide:sync`'s late-joiner pattern) only if `ok`. On success also
  echoes back both codes (safe — reaching this line already proved the
  caller holds the higher-privilege one) plus the shareable join link/QR
  code (`buildJoinUrl`/`QRCode.toDataURL`, `src/server.ts`) — `deckUrl` is
  always present (it's just this server's own static config), `joinUrl`/
  `joinQrDataUrl` are `undefined` together whenever no room code is
  configured (there's nothing valid to share yet). Participant sockets
  never emit this.
- `state:update { currentSlideIndex, currentStepId, participants[], pendingConnections[], stepStatus[] }`
  (server → dashboard room only) — sent on every state-affecting event above
  plus `disconnect`/the staleness sweep. Room-scoped, not broadcast to every
  connected socket, so participant clients don't receive the full roster/
  step-status payload on every other participant's keystroke.

**Post-ship: pending connections + kick (participant management)**

Reported from live use: `JoinScreen.vue`'s join-screen overlay is a
client-side UI gate, not a content access control — deleting it via
devtools lets a browser watch the deck without ever calling
`participant:join`. This can't be closed here (nothing server-side can,
short of gating the deck's own static assets — out of scope for this
addon), so instead it's made visible and actionable:

- `participant:connecting` (client → server, no payload, no ack) — emitted
  once by `JoinScreen.vue` on mount, whenever a real participant browser is
  about to show the join form (never by the presenter's own route or the
  dashboard's own socket — see that component's own guard). Adds a
  `PendingConnection { socketId, connectedAt }` (`session.ts`), broadcast in
  `state:update`'s new `pendingConnections[]` field, so the dashboard shows
  an anonymous "someone's here" row immediately.
- A pending connection is removed — and the row transitions in place to a
  real participant row — the moment that same socket's `participant:join`
  succeeds. It's also removed (with a broadcast) if the socket disconnects
  before ever joining.
- `presenter:kickPendingConnection { socketId, presenterCode }` (client →
  server) — requires a valid `presenterCode`. Force-disconnects that socket
  (`io.sockets.sockets.get(socketId)?.disconnect(true)`) and clears its
  pending entry.
- `presenter:kickParticipant { participantId, presenterCode }` (client →
  server) — requires a valid `presenterCode`. **Fully deletes** the
  participant record (`removeParticipant`, `session.ts`) before
  disconnecting every one of their sockets — deliberately a hard delete,
  not the soft `close` a normal disconnect produces: a merely-closed
  participant's id remains a valid resume token (see "Auth" above), so a
  plain disconnect alone would let them silently rejoin without the
  presenter's intervention meaning anything. After a kick, a later
  `participant:join` with the old id finds nothing to resume and falls
  through to an ordinary fresh join (room code required again) — kicking
  someone is not the same as banning them; anyone who still has the room
  code can rejoin as a new participant.
- **The kicked participant's own experience** (feature request from live
  use, not just a server-side concern): both kick handlers disconnect via
  plain `socket.disconnect()`/`.disconnect(true)`, never a custom event —
  Socket.io's client reports a _server-initiated_ disconnect with the
  reason string `'io server disconnect'`, distinct from every other
  disconnect cause (network drop, tab backgrounded, page unload), all of
  which the client's own `reconnection: true` recovers from automatically
  and must _not_ be mistaken for a kick. The addon's `JoinScreen.vue`
  listens for exactly that reason and, only on it, resets to a blank join
  form with a "you were removed" message and reconnects the socket — see
  that component's `onForciblyDisconnected` for the client-side half, and
  its own doc comment for why this reason-string coupling needs
  re-checking if this server ever calls `.disconnect()` on a participant's
  socket from anywhere else. `server.test.ts` asserts the exact reason
  string a kicked client receives, specifically to guard this coupling.

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
  ways: **immediately** on a clean Socket.io `disconnect` (`src/server.ts`,
  via `removeParticipantSocket`), or, for a _hung_ connection that never
  fires one (flaky workshop wifi), by a periodic sweep
  (`sweepStaleParticipants`, `src/presence.ts`) that runs every
  `HEARTBEAT_INTERVAL_MS` and closes a participant once its `lastSeen` is
  stale (> `STALE_AFTER_MS`, 3x the heartbeat interval) **and** none of its
  sockets are still actually connected. Staleness alone is never enough —
  see that function's own doc comment. A participant can have more than one
  live socket at once (`Participant.socketIds`, plural) — see "Real gap
  found: multi-tab presence" below.

**M3 (error reporting), extended by the post-ship "Ask for Help" redesign**

`ErrorReport` (`src/session.ts`) now carries a `kind: 'problem' | 'question'`
tag, a four-state `status: 'open' | 'awaiting_confirmation' | 'resolved' |
'reopened'` (replacing the original bare `resolved: boolean`), and an
append-only `thread: { from: 'participant' | 'presenter', text, ts }[]` —
the redesign's core change: **marking something resolved no longer closes
it outright.** It only offers a resolution; the reporting participant has
the final say via `participant:confirmResolution` below.

Every free-text field accepted below — an `ErrorReport`'s `text`
(`participant:error`, `POST /api/screenshot`'s `text` field) and any
`thread` message (`presenter:resolveError`/`sendMessage`'s `message`/`text`,
`participant:confirmResolution`/`addMessage`'s `message`/`text`) — is
truncated server-side at `MAX_TEXT_LENGTH` (4000 characters, `src/session.ts`)
before being stored. A holder of a valid room/presenter code is still only
authenticated, not trusted with unbounded input: nothing stops a scripted
client from bypassing the addon's own textareas (which impose no
`maxlength` of their own) and pushing an arbitrarily large string straight
into this process's unbounded, in-memory, append-only `errorReports` array,
with no eviction. Truncation, not rejection, so an oversized submission is
still recorded (just cut off) rather than silently dropped on a path with
no ack to report an error back through.

- `participant:error { stepId, text?, kind? }` (client → server) — the
  **text-only** report/question path (PRD §10, `kind` added by the
  redesign). `kind` defaults to `'problem'` if omitted (only the addon's
  "Ask a question" tab ever sends `'question'` explicitly). No-ops
  (silently) if the socket hasn't called `participant:join` yet, same rule
  as `participant:copy`/`done`.
- `presenter:resolveError { errorId, presenterCode, message? }` (client →
  server) — requires a valid `presenterCode` (invalid/missing is a silent
  no-op, same shape as `presenter:setSlide`/`setStep`). Moves the report to
  `'awaiting_confirmation'` (**not** a final resolved state) and, if
  `message` is given, appends it to `thread` as a presenter message.
  Notifies the reporting participant's own socket(s) via
  `participant:errorResolved { errorId, stepId, status, message? }`.
  Unknown `errorId` (with a valid code) is a no-op, not an error.
- `presenter:sendMessage { errorId, presenterCode, text }` (client →
  server) — a plain reply on a report's thread that does **not** change
  `status` (e.g. "still looking into it", answering a question without
  resolving it). Requires a valid `presenterCode`. Pushes
  `participant:message { errorId, stepId, text }` to the reporting
  participant's socket(s).
- `participant:confirmResolution { errorId, confirmed, message? }` (client →
  server) — the participant's answer to an `'awaiting_confirmation'` offer:
  `confirmed: true` → `'resolved'` (the true end state); `confirmed: false`
  → `'reopened'`, back in the presenter's queue but distinguishable from a
  fresh `'open'` report. Restricted to the socket that owns the report
  (`socket.data.participantId` must match `ErrorReport.participantId`) —
  unlike most events here, this can't be satisfied by presenting a valid
  code, since an `errorId` isn't a secret the way `participantId` is.
- `participant:addMessage { errorId, text }` (client → server) — lets a
  participant add a follow-up to their own report's thread without waiting
  for a resolution offer. Same ownership restriction as
  `participant:confirmResolution`.
- `state:update` carries `errors: ErrorReport[]` (full shape above,
  including `kind`/`status`/`thread`) — folded into the existing event
  rather than a new one, per plan 028 Step 1's original decision: error/help
  reports are rare compared to step-status churn, so the combined payload
  isn't a size/frequency problem.
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
- `GET /uploads/:sessionDir/:filename` — serves an uploaded screenshot back.
  Every file is written under a **session-scoped `mkdtemp`-ed directory**
  (as of plan 032a, one per live session rather than one per server
  instance/process — see "Multi-room" below; still never a fixed path in
  the repo) with a server-generated `${randomUUID()}.${ext}` name — the
  multipart client `filename` field is never used to construct a path, so
  there's nothing for a crafted `../`-laden client filename to traverse
  with on the write side. The `:sessionDir` segment is likewise
  server-generated (the `mkdtemp` suffix, **never** the room code, which
  can come from an operator's env var and is a credential besides), and is
  matched against live sessions' own directory names — a segment naming no
  live session is a 404, not a filesystem probe. On the read side,
  `src/uploads.ts`'s `resolveUploadPath` rejects
  any request whose filename doesn't match that exact
  `uuid.(png|jpg|webp)` shape _before_ `sirv` ever touches the filesystem —
  defense-in-depth on top of `sirv`'s own path normalization, mirroring the
  "constrain the shape, then confirm containment" discipline from
  `plans/016-confine-export-output-path.md`. No retention/cleanup policy
  for these files beyond the process's own temp-dir lifetime — no
  requirement in the PRD for cross-restart persistence (§4 non-goals), so
  none was built; flagged as a 030 hardening candidate if disk usage over a
  long session turns out to matter.

## Multi-room (plan 032a)

One process can hold **several concurrent, fully isolated workshop
sessions**. Every piece of per-workshop state (`session`, `participants`,
`stepStatus`, `errorReports`, `pendingConnections`, the join-link QR cache,
the uploads directory) lives on a `RoomState` in `src/session.ts`'s
`Map<roomCode, RoomState>` — keyed by the **room code itself**, deliberately
rather than by a separate internal id (`plans/031-...`'s Q2 recommendation).

- **Creating a session.** `createSession()` (`src/session.ts`) is the only
  way a session comes into existence, boot-time one included: `index.ts` →
  `createMuanCompanionServer` → `createSession`. Codes not supplied by the
  caller are generated (plan 031a's posture, now applied uniformly); an
  already-taken room code throws rather than replacing or merging. A running
  server exposes `createSession`/`destroySession` for launching and ending
  further sessions at runtime.
- **Which session is a socket in?** A Socket.io handshake query parameter,
  `?roomCode=…` — the same parameter name the participant join link already
  uses — read once at connection time onto `socket.data.roomCode` (mirroring
  how `socket.data.participantId` is set once at join). A connection that
  supplies none lands in the server's boot session, which is what keeps every
  pre-032a client (the addon, the dashboard page) working unchanged. The hint
  **is not a credential**: it only selects which session's auth config the
  existing gates check against. `participant:join` still validates the room
  code, and every `presenter:*` event, `dashboard:join`, and the `/dashboard`
  HTTP route still require _that session's_ presenter code — so one
  workshop's codes are worthless against another's.
- **Broadcasts.** `state:update` goes to `dashboard:${roomCode}` and
  `slide:changed` to `participants:${roomCode}`, instead of one global
  dashboard room and a process-wide `io.emit`. A wrong-room payload is never
  sent at all, rather than sent and filtered.
- **`dashboard:home`.** The cross-room feed backing the home view;
  `buildHomeUpdate()` is its payload builder and creating/destroying a
  session is what pushes it. 032a wired the room and left it deliberately
  unjoinable, because its payload lists every live room code — see "Home
  view" below for the credential 032b introduced to gate it.

## Home view (plan 032b)

A second static page at **`/home`**, one level above the per-session
`/dashboard`: it lists every live session on this server plus the Slidev
decks the server can find on disk. 032b built it read-only; plan 032c (below)
made its "Present" and "Stop" buttons live.

### `SLIDEV_MUAN_COMPANION_ADMIN_CODE` — the cross-room credential

A **third** secret, alongside the room and presenter codes, and deliberately
not a reuse of either (`src/adminAuth.ts`):

- The room and presenter codes are scoped to **one workshop**. The home
  view isn't: its session list necessarily carries every live room's code,
  and a room code is the participant-level credential for its session. So
  gating `/home` on any single room's presenter code would let that room's
  presenter enumerate every _other_ workshop on the same server. A
  cross-room view is strictly more privileged than any one dashboard and
  must not be reachable with less.
- The comparison is `auth.ts`'s constant-time `isValidCode`, unchanged and
  reused rather than reimplemented. The credential is new; how a secret is
  checked is not.
- **Unset means generated**, exactly like the two session codes (plan
  031a's posture): `index.ts` logs it at startup, noting whether it came
  from the env var or was generated. Set the env var for a stable `/home`
  bookmark across restarts.
- It gates `/home`, the `home:join` socket event,
  `GET /api/presentations`, the deck launcher (`POST /api/launch`,
  `POST /api/stop` — 032c) and connect-key minting
  (`POST /api/connect-key` — 032d). It confers **nothing**
  inside any single room — it is not accepted by `dashboard:join`, by any
  `presenter:*` event, by `participant:join`, or by the `/dashboard` HTTP
  route. Nothing about the existing per-room gates changed; 032b adds
  surface above them.

### `SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR` — deck discovery (opt-in)

Root directory scanned for presentable decks (`src/presentations.ts`).
**No default**: unset means the presentation list is simply empty and this
whole feature is a no-op, so every deployment that predates 032b behaves
identically. A root that doesn't exist or isn't readable is treated the same
way — an empty list, never a startup crash or a failed request.

Each **immediate subdirectory** counts as one presentation if it has:

1. a `slides.md` (Slidev's own default entry deck — the one file a folder
   needs for `slidev dev` in it to work at all), **and**
2. the companion addon actually configured, via either `slides.md`'s
   frontmatter `addons:` list (block or inline form; the short
   `muan-companion` and full `slidev-addon-muan-companion` spellings both
   match) or a dependency in the folder's `package.json`.

The addon check exists so folders that _can't_ sync don't show up as falsely
presentable — a deck without the addon would launch fine and then silently
never appear in any session, which is only diagnosable by noticing that
nothing happens. What is deliberately **not** checked: whether the addon
resolves on disk, its version, or Slidev-version compatibility — those have
real answers only at spawn time (032c), and discovery's job is to filter out
the obviously-unpresentable, not to guarantee a successful launch.

Dotfiles, `node_modules`, plain files, nested subdirectories, and
**symlinked directories** are skipped. The symlink exclusion is deliberate:
a symlink's target can be anywhere on the host, which would quietly turn
"one configured directory" into "that directory plus wherever its symlinks
point" — and 032c will `spawn` inside whatever discovery returns.

- **Id** = the subdirectory's basename. Unique by construction (a directory
  can't hold two entries of the same name, and only immediate children are
  scanned), stable across restarts and across machines that mount the deck
  tree at different absolute paths — which a hash of the absolute path
  would not be.
- **Title** = frontmatter `title:` if present, else the folder name.
- **The absolute path never crosses the wire.** `GET /api/presentations`
  returns id + title only; the path is dropped inside `presentations.ts`,
  one layer below the route. Going the other way, `resolvePresentationDir`
  (the seam 032c launches from) resolves an id by **exact match against a
  freshly scanned listing**, never by `join(root, id)` — so a traversal id
  resolves to nothing, with no normalization step to get wrong, because
  there is no path arithmetic at all.

### Wire surface

- **`home:join { adminCode }`** → `{ ok: true, sessions: [...] }` with an
  immediate snapshot (mirroring `dashboard:join`), or `{ ok: false }` and no
  join. The only thing that ever joins `dashboard:home`. Subsequent changes
  arrive as `home:update` broadcasts on session create/destroy.
- **`home:dashboardUrl { adminCode, roomCode }`** → `{ ok: true, url }`, the
  `/dashboard?code=…&roomCode=…` link for one session. This exists because
  `home:update` deliberately carries **no presenter codes** and a working
  dashboard link needs one. An admin-code holder is already entitled to
  every room's presenter code, so withholding them isn't a boundary — but
  putting N of them in a feed that re-broadcasts on every session
  create/destroy is standing exposure with no benefit. One code, fetched on
  an explicit click, is a fraction of that; the page navigates straight to
  the URL and never renders the code into the DOM. The admin code is
  re-checked per event rather than trusting the earlier `home:join`, the
  same way every `presenter:*` event re-checks its own code.
- **`GET /api/presentations?code=<adminCode>`** → an object with a
  `presentations` array of `{ id, title }`. Gated by a `requireAdminCode`
  middleware mounted _ahead_ of
  the handler, so an unauthenticated request triggers no filesystem access
  at all — not even a `readdir` of the configured root.
- **`GET /home?code=<adminCode>`** → the page, served by the same `sirv` +
  gate + CSP shape as `/dashboard`, with the same no-build-step posture
  (one HTML file, inline `<style>`/`<script>`, no framework).

### What the page shows

Presentations (each with a live **Present** button — 032c), live sessions
(room code, deck URL, participant/connected/needs-attention counts, current
slide, and **Open dashboard** / **Stop** actions), and a "Connect a deck"
panel. That last panel **feature-detects** `POST /api/connect-key` — 032d
built it in a parallel workstream and it may not be deployed in a given
build — and shows a clear "not available yet" state rather than a button
that 404s.

## Deck launcher (plan 032c)

Flow A: the operator picks a discovered presentation on `/home` and clicks
Present; the server starts `slidev` for that folder itself, waits for it to
come up, mints a session for it exactly like every other session, and hands
back the presenter and participant URLs. Stop tears it down again.

> **This surface spawns operating-system processes in response to an HTTP
> request, and it needs its own security review** (plan 032's sequencing
> table gives that its own row, 032e, alongside 032d's connect-key
> bootstrap). Everything below is written to be checked, not trusted.

### Wire surface

- **`POST /api/launch`** with `{ presentationId }` → `201` and
  `{ roomCode, presenterCode, presenterUrl, participantUrl }` — field for
  field the same shape `POST /api/register` returns, because both answer the
  same question and `/home` consumes them with the same code path.
  - `404 { error: 'unknown presentation' }` for an id that doesn't resolve —
    **with no spawn attempted**. Also the answer when discovery isn't
    configured at all.
  - `503 { reason: 'at-capacity' }` past the concurrency cap.
  - `502 { reason: 'timeout' | 'exited-early' | 'spawn-failed' }` for a deck
    that wouldn't start, carrying the tail of the child's own output.
- **`POST /api/stop`** with `{ roomCode }` → `200 { stopped: true, hadProcess }`.
  `hadProcess: false` is an ordinary answer, not an error: a Flow-B session
  (032d) is a deck this server didn't start, so there is nothing of ours to
  kill — the session is destroyed and the operator's own `slidev` is left
  alone. `404` for an unknown room.
- Both are **admin-gated**, credential in the
  `x-muan-companion-admin-code` header or `?code=`, checked before the body
  is read, before the filesystem is touched, and before anything is spawned.
- Flat paths with the subject in the body, not `/api/presentations/:id/launch`:
  it matches every other JSON route here (there is no path parameter anywhere
  in this server), it keeps identifiers out of access logs, and it avoids
  living under the `/api/presentations` prefix whose `requireAdminCode` mount
  reads only `?code=`.

### How the deck is actually started

- **`child_process.spawn`, never `exec`, never a shell string.** Command and
  arguments are separate argv entries and there is no `shell` option — the
  injectable `SpawnDeckProcess` type doesn't even have one to pass.
- **The directory comes only from `resolvePresentationDir`.** The launcher
  never sees an id; the route resolves it, and an unresolvable id 404s before
  any spawn. There is no `join(root, id)` anywhere in the feature.
- **Argv is flags only — there is no `slidev dev` subcommand.** The CLI's dev
  server is its _default_ command (`packages/slidev/node/cli.ts`); a literal
  `dev` would be parsed as the `[entry]` deck file. So:
  `--port=<allocated> --open=false --log=warn` (plus `--remote=` when opted
  in). `--open=false` as one token, not `--open false` — yargs would read the
  spaced form as a bare flag plus a positional, and that positional is the
  entry file.
- **The binary is the deck's own.** `resolveSlidevBinary` walks
  `node_modules/.bin/slidev` from the deck folder up to the filesystem root —
  the same resolution a shell running `pnpm exec slidev` in that folder
  performs — so a deck pinned to an older Slidev isn't started by a newer
  binary. Falls back to `PATH`, which yields a clean `ENOENT` (reported as
  `spawn-failed`) rather than a mystery timeout.
  `SLIDEV_MUAN_COMPANION_SLIDEV_BIN` overrides all of it. Not Windows-capable
  (`slidev.CMD` needs `shell: true`, which this deliberately never uses).
- **Ports are kernel-assigned.** Bind `:0`, read the port back, close, pass it
  to `--port=`. Two launches back-to-back cannot collide. The TOCTOU window
  between closing the probe and the child binding is real and **accepted**:
  it's the same approach the rest of this ecosystem uses, and `--port=` makes
  the CLI set Vite's `strictPort`, so a lost race fails loudly into the
  captured output instead of silently listening somewhere else.
- **Readiness is an HTTP poll**, not stdout scraping: any HTTP response on
  the allocated port means ready. Vite's "ready" line is ANSI-formatted,
  version-dependent, and suppressed entirely at `--log=warn` — tying launch
  success to its wording would make a routine Slidev upgrade break every
  launch. 30s timeout (a cold dependency-optimizer run is genuinely slow),
  and the probe aborts early if the child exits, so a broken deck fails in
  milliseconds rather than after the full wait.
- **stdout and stderr are captured** into a 4 KiB ring-buffered tail, which
  is what a failed launch reports. Both streams are consumed (not just
  stderr) because an unread pipe eventually blocks the child.

### Environment

| Variable                                  | Default                  | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLIDEV_MUAN_COMPANION_PUBLIC_URL`        | `http://localhost:$PORT` | Where _this_ server is reachable **from a participant's browser**. Injected into every spawned deck as `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL`, which is how the addon finds its way back with no change to `client.ts`. Vite inlines `VITE_*` into the _browser_ bundle, so this must be the externally-reachable URL, not something loopback-derived. Its scheme+host is also the origin a launched deck's own URL is built from (child's port substituted). The localhost default is the same deliberately-local-but-well-formed posture as `SLIDEV_MUAN_COMPANION_DECK_URL`. |
| `SLIDEV_MUAN_COMPANION_MAX_SPAWNED_DECKS` | `4`                      | Concurrency cap, counting launches still waiting on readiness. Past it, `POST /api/launch` returns 503 rather than degrading silently. 4 is sized to what a Vite dev server costs (a few hundred MB each) on the 2 GB class of host this ships to. A non-numeric or non-positive value falls back to the default rather than becoming `NaN` — which every `>=` would be false for, i.e. no cap at all.                                                                                                                                                                           |
| `SLIDEV_MUAN_COMPANION_SPAWN_REMOTE`      | unset (off)              | `true` adds `--remote=` so spawned decks bind every interface instead of `localhost`. **A real workshop needs this on** — the participant URL is only reachable from other devices if the deck listens on a reachable interface — but "a dashboard click silently opens a port on every interface" is an operator's decision to make knowingly. Only the exact string `true` enables it.                                                                                                                                                                                         |
| `SLIDEV_MUAN_COMPANION_SLIDEV_BIN`        | unset                    | Explicit CLI path; see above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### Lifecycle

Every child is tracked in a module-level registry keyed by its session's room
code (plus a holding set for launches that have spawned but don't have a
session yet — those count against the cap and are killable too).

- **Crash/kill-from-outside** → the child's `exit` tears down its session
  through the _same_ `destroySession` + `home:update` broadcast pairing a
  deliberate stop uses, so an open `/home` sees the row disappear either way.
  Plan 032: "don't leave a Session pointing at a dead process."
- **Stop** → `SIGTERM`, escalating to `SIGKILL` after 5s, then destroy the
  session. A deliberate stop is flagged so its own `exit` isn't mistaken for
  a crash.
- **`SIGTERM`/`SIGINT`** → `index.ts` kills every tracked child before
  exiting, so a restart doesn't leave zombie `slidev` processes holding ports
  the new instance can't reuse. `process.once`, so a second Ctrl-C still hits
  Node's default handler; `process.exit(128 + signum)`, because registering
  any handler suppresses the default terminate-on-signal and a
  cleanup-only handler would leave the server running.

### What this does _not_ do

**Launching a deck is arbitrary code execution by design, not by accident.**
A Slidev deck is a Vite project: `vite.config.ts`, `setup/*.ts`, a local
theme and npm dependencies all run as this server's user the moment `slidev`
starts. Nothing here sandboxes that, and nothing could without a
container/user boundary this package doesn't own. The real trust boundary is
**the discovery root plus the admin code** — an operator who points
`SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR` at a directory someone else can
write to has handed that person code execution on this host.

Flow A also assumes the spawned deck's port is directly reachable at the same
host as this server. A deployment terminating TLS at a reverse proxy will get
a deck URL of `https://proxy-host:<ephemeral port>` that the proxy isn't
forwarding; use Flow B (032d) there, where the operator supplies the deck's
real URL.

## Real gap found: multi-tab presence (follow-up fix)

Reported from live use, not a hypothetical: a participant opens a second
browser tab to the same deck (the `localStorage`-backed resume — see the
addon's `participantIdentity.ts` — means the second tab resumes the _same_
participant identity, not a new one). They close the second tab. The
dashboard immediately shows them `closed` — even though the _first_ tab is
still open, connected, and actively being watched — and only recovers if
that first tab happens to refresh.

Root cause: `Participant` used to carry a single `socketId: string`.
`joinParticipant`'s resume path **overwrote** it on every join, so the
second tab's join silently made the first tab's socket unreachable for
presence purposes — closing the second tab's socket then looked
indistinguishable from "the participant's only socket disconnected," and
`presenter:resolveError`'s targeted notification (see the M3 events above)
had the same bug for a different reason: it would only ever reach whichever
tab most recently joined, never an earlier still-open one.

Fix: `Participant.socketIds` is now an array, not a single string.
`joinParticipant` **adds** to it on join/resume rather than replacing it;
`removeParticipantSocket` (new, `src/session.ts`) removes just the
disconnecting socket and only flips the participant to
`closed`/`connected: false` once the array is empty — closing one of several
tabs is correctly a no-op for presence (and doesn't even trigger a
`state:update` broadcast, since nothing user-visible changed).
`sweepStaleParticipants`'s "is this still connected" check and
`presenter:resolveError`'s notification both now consider _every_ socket in
the array, not just one.

## Dashboard

A small static page at `/dashboard` (served from `public/dashboard/` via
`connect` + `sirv`, mounted on the _same_ `httpServer` Socket.io attaches
to — see `src/server.ts`'s comment on why that ordering matters and why it's
safe), gated on the presenter code (see "Auth" above). Same origin as the
Socket.io server, so no CORS configuration is needed. Loads Socket.io's own
client bundle (`/socket.io/socket.io.js`, served by Socket.io by default)
and renders `state:update` payloads — no build step, no polling.

Shows, top to bottom: a **"Share this workshop" panel** (the join link +
QR code from `dashboard:join`'s ack above — hidden entirely when no room
code is configured), live counts (joined, viewing now, done-this-step/total,
current slide/stepId, and a "needs attention" count — `open` + `reopened`
reports, deliberately excluding `awaiting_confirmation` since those are
already actioned and just waiting on the participant), a participant table
(name, **presence** — viewing now / away / closed, driven by `visibility` +
`connected` rather than `connected` alone — status for the _current_ step,
joined at, and a **"Remove" button** per row wired to
`presenter:kickParticipant`/`presenter:kickPendingConnection`, see "Post-ship:
pending connections + kick" above), interleaved with anonymous **pending
connection** rows (someone's socket connected and announced itself via
`participant:connecting` but hasn't joined yet — sorted into the same table
by connection/join time, transitioning in place to a named row once they
join rather than appearing as a separate entry), and the **"Help requests"
feed**: each card shows a `kind` tag
(problem/question), a colored `status` chip (open/reopened share the
"needs attention" red; `awaiting_confirmation` is blue/"in flight";
`resolved` is green/dimmed), the original text and/or a screenshot
thumbnail (click for a full-size lightbox), the `thread` rendered as a
compact chat strip, and — for any non-`resolved` card — a composer with
"Send" (`presenter:sendMessage`, no status change) and, for `open`/
`reopened` cards only, "Send & mark resolved" (`presenter:resolveError`).
Resolved reports stay visible (dimmed, sorted last) rather than
disappearing — a dashboard reload still reflects full status/thread
history, which lives server-side in `ErrorReport`, not client-side UI
state. PRD §11/§15's "never joined" presence state has no dedicated row:
there's no roster of expected participants in this single-session model,
so it's represented by simple absence from the table. Don't expand this
into a full SPA without re-reading plan 027's Step 3 trade-off note.

Access to the dashboard (both the HTTP route and its `dashboard:join` socket
call) requires the presenter code — see "Auth" above. There is no separate
"known security gap" section anymore: that gap was accepted-and-tracked
through M1–M3 and closed by M4 (this merge wires `presenter:resolveError`,
plan 028's addition, into the same presenter-credential gate as every other
`presenter:*`/dashboard-facing handler — see `src/server.ts`'s comment on
that handler for why it needed fixing up as part of merging M3 and M4
together).

Every response this process serves carries `X-Content-Type-Options: nosniff`
and `X-Frame-Options: DENY` (`src/server.ts`'s global CORS/headers
middleware) — nothing here is meant to be embedded in a frame, and nothing
should be interpreted as anything other than its declared content type.
`/dashboard` additionally gets a `Content-Security-Policy`
(`dashboardContentSecurityPolicy`) scoped to exactly what its own inline
`<style>`/`<script>` and same-origin Socket.io client bundle + QR code
`data:` image need — permitting the inline execution this no-build-step page
already relies on (`'unsafe-inline'` on `script-src`/`style-src`) while still
blocking any _external_ script/style/connection a future XSS gap on this
page might try to pull in. Defense-in-depth, not a response to a found bug —
this page has no known XSS gap today; every dynamic value it renders already
goes through `escapeHtml()`.

## Testing

```bash
pnpm --filter muan-companion-server test
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
`GET /uploads/:sessionDir/:filename` contract (valid upload, unknown
`participantId`, missing/oversized/unsupported-type file, and
path-traversal rejection), plus plan 032a's multi-room isolation over real
sockets (two concurrent sessions in one process: neither dashboard sees the
other's roster/pending connections/help requests, neither room's presenter
code works against the other, slide moves don't cross, resume tokens don't
cross, and uploads land in — and are only servable from — their own
session's directory). It
also covers the multi-tab presence fix above directly: two sockets joined as
the same participant, closing the second one leaves them `connected` (and
doesn't even broadcast), only closing the _last_ one flips them `closed`;
and a `presenter:resolveError` notification reaching every open tab, not
just the most recently joined one. `src/auth.test.ts` unit-tests `auth.ts`'s
constant-time code comparison, `src/presence.test.ts` unit-tests
`presence.ts`'s staleness sweep including the "stale but one socket among
several is still alive" case (fake timers, no real sleeps), and
`src/session.test.ts` (including `removeParticipantSocket`'s own unit
coverage) / `src/uploads.test.ts` cover the pure store/path logic directly.
Left in place for 030 to extend rather than starting from scratch.
