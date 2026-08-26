# workshop-tracker-server

Realtime sync server for [`slidev-addon-workshop-tracker`](../addon-workshop-tracker).
Currently implements **M1 (slide sync) and M2 (participant identity + step
tracking + a minimal dashboard)** of the workshop-tracking initiative. See
[`plans/026-workshop-tracker-m1-slide-sync.md`](../../plans/026-workshop-tracker-m1-slide-sync.md),
[`plans/027-workshop-tracker-m2-step-tracking.md`](../../plans/027-workshop-tracker-m2-step-tracking.md),
and [`plans/prd-workshop-tracking.md`](../../plans/prd-workshop-tracking.md)
for the full scope and roadmap (M3–M5).

This package is **private** — it's not published, it's the workshop
operator's own backend process, run alongside the Slidev dev server for the
duration of a workshop.

## Usage

```bash
pnpm --filter workshop-tracker-server dev
```

Starts an HTTP + Socket.io server listening on `:3710` (override with the
`PORT` env var). `WORKSHOP_TRACKER_ORIGIN` sets the CORS origin allowed to
connect (defaults to `*`). The instructor dashboard is served by the same
process at `/dashboard` (see "Dashboard" below).

## Events

**M1 (slide sync)**

- `presenter:setSlide { index }` (client → server) — rebroadcast to everyone
  as `slide:changed { index }`, and stored as the session's current slide.
- `slide:changed { index }` (server → all clients) — a slide change happened.
- `slide:sync { index }` (server → the newly-connected client only) — sent
  immediately on connect so a participant who joins/reloads mid-session lands
  on the presenter's current slide rather than slide 1. This isn't in the
  PRD's §10 event list verbatim; it's the minimum addition needed to make
  `slide:changed` (a rebroadcast-only event) useful to late joiners, and is a
  deliberate, documented decision — not scope creep. Don't remove it without
  updating plan 026's status.

**M2 (participant identity + step tracking)**

- `participant:join { name, participantId? }` → `ack({ participantId, currentSlideIndex })`
  — creates a new participant, or (if `participantId` matches an existing
  record — see the addon's `JoinScreen.vue`, which persists it to
  `sessionStorage`) reuses it instead of creating a duplicate. A
  client-supplied `participantId` is only ever used to _look up_ an existing
  record, never trusted as the id of a new one.
- `participant:copy { stepId }` / `participant:done { stepId }` → `ack({ stepId, state })`
  — records `stepStatus[participantId:stepId] = 'copied' | 'done'` and
  broadcasts `state:update` to the dashboard room. No-ops (silently) if the
  socket hasn't called `participant:join` yet.
- `presenter:setStep { stepId }` (client → server) — sets the session's
  `currentStepId`, broadcast to the dashboard via `state:update`. **Not** the
  same event as `presenter:setSlide`, and not in PRD §10's literal list —
  see the addon's `StepReporter.vue` for why the presenter's _slide index_
  and its frontmatter-derived _stepId_ need separate reporting mechanisms
  (a real, empirically-discovered gap in the milestone's original plan, not
  a hypothetical one).
- `dashboard:join` (client → server) — joins the Socket.io `dashboard` room
  and immediately receives one `state:update` snapshot (mirrors
  `slide:sync`'s late-joiner pattern). Participant sockets never emit this.
- `state:update { currentSlideIndex, currentStepId, participants[], stepStatus[] }`
  (server → dashboard room only) — sent on every state-affecting event above
  plus `disconnect`. Room-scoped, not broadcast to every connected socket,
  so participant clients don't receive the full roster/step-status payload
  on every other participant's keystroke.

## Dashboard

A small static page at `/dashboard` (served from `public/dashboard/` via
`connect` + `sirv`, mounted on the _same_ `httpServer` Socket.io attaches
to — see `src/server.ts`'s comment on why that ordering matters and why it's
safe). Same origin as the Socket.io server, so no CORS configuration is
needed. Loads Socket.io's own client bundle (`/socket.io/socket.io.js`,
served by Socket.io by default) and renders `state:update` payloads — no
build step, no polling.

Shows: live counts (joined, done-this-step/total, current slide/stepId) and
a participant table (name, connected, status for the _current_ step, joined
at). Counts and an error feed beyond this are 028/029's job — don't expand
this into a full SPA without re-reading plan 027's Step 3 trade-off note.

## Known security gap (by design, until plan 029)

**There is no authentication.** Any socket that connects can emit
`presenter:setSlide`/`presenter:setStep` and move/relabel everyone's
current slide/step — there is no check that the sender is actually the
instructor. The `/dashboard` route is equally open to anyone who
knows/guesses the URL. This is an accepted, explicitly-tracked gap: plan
[029](../../plans/029-workshop-tracker-m4-presence-auth.md) (M4) adds a join
code that gates who is allowed to act as "the presenter" and who can open
the dashboard. Do not point this server at a real workshop room, and do not
treat it as secure, before 029 lands.

## Testing

```bash
pnpm --filter workshop-tracker-server test
```

`src/server.test.ts` spins up real `socket.io-client` pairs against an
in-process server on an ephemeral port and asserts the full event contract
above, including that `state:update` is genuinely room-scoped (a connected
socket that never calls `dashboard:join` never receives it). Left in place
for 028+ to extend with the error/presence events rather than starting from
scratch.
