# Plan 029: Workshop Tracker M4 — presence tracking + presenter/dashboard auth

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Source doc**: [`plans/prd-workshop-tracking.md`](./prd-workshop-tracking.md)
> §9, §10, §11 (presence column), §12 (Auth, Resilience partially), §13 (M4).
> Builds on [027](./027-workshop-tracker-m2-step-tracking.md) (participant
> registry, dashboard) and closes the "no auth" gap explicitly flagged as a
> known, tracked limitation in [026](./026-workshop-tracker-m1-slide-sync.md)
> and [027](./027-workshop-tracker-m2-step-tracking.md).

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (auth is the highest-consequence surface in this whole
  initiative — get the presenter/dashboard gate wrong and the PRD's explicit
  requirement in §12 — "do not ship the dashboard open to anyone who guesses
  the URL" — is violated)
- **Depends on**: 027
- **Category**: feature / security
- **Planned at**: commit `a8d8ff71`, 2026-08-26

## Why this matters

Two things land together here because they're both about *who is in the
room and what they're allowed to do*: presence (is this participant actually
watching) and auth (is this connection actually the presenter/instructor).
Landing them together also means this plan is the one that finally closes
the security gap 026 and 027 both explicitly deferred and documented rather
than hid — do not consider this initiative production-ready for a real
workshop until this plan is done, even though M1-M3 are independently
demoable.

## Current state (after 027/028)

- `presenter:setSlide`, dashboard access, and `presenter:resolveError` are
  all currently un-gated — any socket connection can emit them (documented
  `NOTE(security)` comments in 026/027/028's code).
- Participants join via `participant:join { name }` with no shared
  room/session code (PRD §12 calls for "a shared room/session code, matching
  `slidev-addon-sync`'s existing pattern" — not yet implemented; M1-M3 use
  the implicit singleton session from PRD §14's accepted v1 scope).
- No visibility/heartbeat tracking exists; `Participant.connected` (027) is
  only ever `true` while a socket is open — no `visibility` field, no
  `lastSeen`-driven staleness detection.

## Commands you will need

Same as prior plans; no new commands beyond exercising the auth flow
manually (join code / password prompts) and, ideally, a scripted multi-tab
visibility test if the browser automation tooling is available in the
session (`claude-in-chrome` skill) — optional, manual `visibilitychange`
testing (switch tabs, watch the dashboard) is sufficient to close this plan.

## Scope

**In scope**:
- **Presence**: `visibility: 'visible' | 'hidden' | 'closed'` on
  `Participant` (PRD §9), `participant:visibility { state }` on the Page
  Visibility API's `visibilitychange`, `participant:heartbeat { stepId }`
  every ~5s (PRD §10), server-side staleness detection (a participant whose
  heartbeat goes silent for some multiple of the interval — document the
  chosen multiple, e.g. 3× — is marked disconnected even without a clean
  socket `disconnect` event, which matters for flaky workshop wifi).
- **Auth**: a join/room code participants must supply (extends
  `participant:join` to `{ name, roomCode }`), and a separate,
  higher-privilege presenter/dashboard credential (session password or
  presenter-only code per PRD §12) gating `presenter:*` events and the
  dashboard route/page itself.
- Dashboard: presence column (viewing now / away / closed / never joined,
  PRD §11), and the credential-gate UI/flow for opening it.

**Out of scope** (deferred):
- Reconnect *resuming* a participant's own identity across a full page
  reload (030) — this plan's presence work covers "is this connection still
  alive/watching", not "did this browser close and reopen as the same
  person"; 030 is where `sessionStorage`'s stored `participantId` (seeded in
  027) actually gets used to rejoin as the same participant rather than a
  new one.
- Load-testing presence/heartbeat traffic at 50-100 participants (030).
- Multi-session/multi-room support beyond a single shared join code (PRD
  §14 leaves this open; a single code for a single active session is
  sufficient for v1 per §4's non-goals).

## Git workflow

- Branch: `feat/workshop-tracker-m4-presence-auth`.
- Conventional commits, e.g.:
  - `feat(workshop-tracker-server): join code + presenter credential gate`
  - `feat(addon-workshop-tracker): visibility + heartbeat reporting`
  - `feat(workshop-tracker-server): dashboard presence column`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Auth — close the gap first, before adding more privileged surface area

Decide and implement (document the choice in the server's README):
- A **participant join code**: a short string the operator sets (env var,
  e.g. `WORKSHOP_ROOM_CODE`), required in `participant:join { name,
  roomCode }`; reject/disconnect on mismatch. Low friction — participants
  already need *some* out-of-band way to find the server URL, so handing
  out a code alongside it is no extra burden.
- A **presenter/dashboard credential**, separate from the participant join
  code (PRD §12 distinguishes "presenter routes/dashboard require a session
  password or presenter-only join code" from the participant join flow —
  don't conflate the two: a participant knowing the room code must not be
  able to move everyone's slides or open the dashboard). Simplest correct
  shape: a `WORKSHOP_PRESENTER_CODE` env var, required either as a socket
  auth payload (`io(url, { auth: { presenterCode } })`, verified server-side
  in the `connection` handler before allowing `presenter:*` events) or as a
  simple query param / HTTP Basic gate on the dashboard's static route —
  pick one mechanism per surface, don't mix a query-param scheme for one and
  a socket-auth scheme for the other without reason.
- Retrofit `presenter:setSlide` (026) and `presenter:resolveError` (028) to
  check the presenter credential before acting, replacing the
  `NOTE(security)` comments with the actual gate — remove the comments once
  closed, don't leave stale "not secure yet" notes once they're false.

**Verify**: a socket presenting the wrong/missing presenter code cannot move
the slide (its `presenter:setSlide` emission is rejected/ignored, verified
via a temporary log or the fact that no other client's slide moves); the
dashboard route refuses to render/serve its data without the credential; a
participant with a valid room code but no presenter code still can't do
either.

### Step 2: Presence — client-side reporting

In `packages/addon-workshop-tracker/setup/main.ts` (or a small dedicated
composable/component alongside the join screen from 027), wire:
- `document.addEventListener('visibilitychange', () => socket.emit('participant:visibility', { state: document.visibilityState }))`
  — maps directly to PRD §10's `'visible' | 'hidden'` states; `'closed'` is
  inferred server-side from socket disconnect (Step 3), not sent by the
  client (a closing tab can't reliably emit one more event).
- A `setInterval` heartbeat every ~5s emitting `participant:heartbeat
  { stepId }` (current step, from the same frontmatter source
  `<StepCommand>` uses) — clear the interval on unmount/disconnect.

**Verify**: switching browser tabs away from the deck flips that
participant's dashboard row to "away" within ~5s (PRD §15's presence
bullet); switching back flips it to "viewing now".

### Step 3: Presence — server-side staleness + dashboard column

Server tracks `lastSeen` on every heartbeat and every `participant:*` event
generally (not just the dedicated heartbeat — any activity counts as
liveness). A periodic sweep (e.g. every 5s, matching the heartbeat interval)
marks a participant `closed` if `lastSeen` is older than the documented
multiple of the heartbeat interval **and** its socket is no longer
connected; a clean Socket.io `disconnect` event can also immediately mark
`closed` without waiting for the sweep (Socket.io already knows the
difference between a graceful hard close and a hung, an eventually-timed-out
transport — use both signals, don't rely on the sweep alone since it adds
unnecessary latency for the common clean-close case).

Dashboard presence column renders: never joined (no `Participant` row
exists at all — distinguish this from `closed`, which implies they did join
once), viewing now (`visibility: 'visible'`, connected), away
(`visibility: 'hidden'`, connected), closed (`connected: false`).

**Verify**: closing a participant's browser tab entirely (not just
backgrounding it) flips their dashboard row to "closed" within ~5s of the
disconnect being detected, matching all four states PRD §15 requires the
presence column to distinguish, each updating within ~5s.

## Test plan

- `workshop-tracker-server` vitest additions: a socket without the correct
  presenter credential cannot trigger a slide change or resolve an error; a
  socket without the correct room code is rejected at join; a participant's
  `lastSeen` updates on heartbeat and the staleness sweep correctly flips
  `connected`/presence after a simulated timeout (use fake timers, don't
  sleep-wait in the test).
- Manual: the visibility/close walkthroughs in Steps 2-3, and the auth
  rejection cases in Step 1.

## Done criteria

- [ ] Participant join requires a correct room code; wrong/missing code is
      rejected
- [ ] `presenter:setSlide` and `presenter:resolveError` both require a valid
      presenter credential, distinct from the participant room code; all
      `NOTE(security)` gap-comments from 026/027/028 are resolved/removed
- [ ] Dashboard route/data requires the presenter credential to access
- [ ] Presence states (`visible`/`hidden` from the client, `closed` inferred
      server-side) update the dashboard within ~5s for all four states PRD
      §15 lists (never joined / viewing / away / closed)
- [ ] Heartbeat + staleness sweep correctly detects a hung connection (not
      just a clean `disconnect`) without introducing significant extra
      latency over the clean-close path
- [ ] New vitest coverage for auth rejection and staleness detection
      (fake-timer based, no real sleeps)
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` all pass
- [ ] Only in-scope paths modified/added (`git status`)
- [ ] `plans/README.md` status row for 029 updated

## STOP conditions

Stop and report if:

- The chosen auth mechanism can't actually prevent a participant who
  inspects client-side JS/network traffic from extracting the presenter
  credential and self-escalating (e.g. if it's naively embedded in a public
  bundle rather than only ever transmitted from an operator-controlled
  input at connect time) — this is the one place in the whole initiative
  where "good enough for a LAN workshop" still has a floor; report the
  actual threat model achieved rather than asserting it's secure.
- Heartbeat traffic at even a moderate simulated participant count (10-20)
  already shows the server struggling to keep the staleness sweep timely —
  flag before 030's real load test, since this plan's sweep design is what
  030 will be stress-testing.

## Maintenance notes

- Once this plan lands, 026/027/028's "no auth yet" comments should all be
  gone from the codebase — if a reviewer finds one still present, that's a
  signal this plan wasn't fully applied, not that the comment is stale
  documentation to just delete.
- The distinction between room code (participant-level) and presenter code
  (instructor-level) is intentional and PRD-driven (§12) — don't collapse
  them into one shared secret even if it seems simpler; that would let any
  participant become a presenter.
