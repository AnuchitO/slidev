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
(the full current-state writeup) for scope and history. Multi-session
concurrency, an in-app session-setup/lobby flow, and a practice-mode slide
remain proposed but unimplemented — see
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
process at `/dashboard` (see "Dashboard" below).

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
(`src/auth.ts`) so a wrong guess doesn't leak timing information:

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
`GET /uploads/:filename` contract (valid upload, unknown `participantId`,
missing/oversized/unsupported-type file, and path-traversal rejection). It
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
