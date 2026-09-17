# Plan 030: Workshop Tracker M5 — reconnect/resume + load testing + hardening

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Source doc**: [`plans/prd-workshop-tracking.md`](./prd-workshop-tracking.md)
> §12 (Resilience, Scale), §13 (M5), §15 (final acceptance pass). Builds on
> [026](./026-workshop-tracker-m1-slide-sync.md)–[029](./029-workshop-tracker-m4-presence-auth.md)
> — all four prior milestones must be done first; this plan doesn't add new
> user-facing features, it makes the existing ones survive real conditions.

## Status

- **Priority**: P3
- **Effort**: M
- **Risk**: LOW-MED (mostly hardening known surfaces, not new architecture —
  but reconnect/resume touches identity handling across every prior plan,
  so regressions here are easy to introduce quietly)
- **Depends on**: 026, 027, 028, 029
- **Category**: hardening / testing
- **Planned at**: commit `a8d8ff71`, 2026-08-26

## Why this matters

This is the "is it actually ready for a real workshop room" pass. PRD §12
sets three concrete bars this initiative has been building toward but not
yet verifying end-to-end: a participant's refresh/network-blip must not
re-join them as a stranger with reset progress; the server must hold up at
the stated 50-100 concurrent participant target without the ~1s/~5s latency
promises (§12, §15) degrading; and the presenter-facing routes need the
auth from 029 confirmed under the same conditions, not just in isolated
manual testing.

## Current state (after 026-029)

- `sessionStorage`-persisted `participantId` was seeded in 027 (Step 2) but
  never consumed on join — every page load currently calls
  `participant:join { name, roomCode }` fresh, creating a new `Participant`
  even if the same browser already had one.
- 029's staleness sweep marks a participant `closed` after a heartbeat gap;
  there's no defined behavior yet for what happens when that same
  participant's browser comes back — does the old `Participant` row get
  revived, or does a new one get created alongside a stale `closed` one?
  This plan defines and implements that.
- No load test has been run against `workshop-tracker-server`; the ~1s/~5s
  latency figures in the PRD are currently untested assumptions, not
  measured facts.
- Presenter auth (029) has been manually verified but not exercised
  concurrently with real participant load.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Load-test tool | `pnpm add -D -w artillery` (or equivalent Socket.io-aware load tool — confirm what's actually available/appropriate before adding; see Step 2) | installs |
| Run load test | (defined in Step 2) | prints latency percentiles for slide-change and step-status propagation |

## Scope

**In scope**:
- Reconnect/resume: consuming the stored `participantId` on
  `participant:join`, server-side logic to "revive" a matching existing
  `Participant` (and its step statuses) rather than creating a duplicate,
  and defining what happens if the stored id refers to a participant the
  server no longer knows about (e.g. server restarted — PRD §4/§14 already
  accept in-memory-only persistence, so this is an expected, handled case,
  not an edge case to crash on).
- A load test against `workshop-tracker-server` at the PRD's stated target
  (50 concurrent minimum, ideally toward 100), measuring slide-change and
  step-status propagation latency, documented with actual numbers.
- A basic-auth (or equivalent) pass specifically confirming 029's presenter
  gate holds under the load-test's concurrent connection count, not just a
  single manual session.
- A final walk of PRD §15's full acceptance-criteria list, end to end, as
  this plan's own closing verification.

**Out of scope**:
- Any new feature surface — if the load test or reconnect work surfaces a
  design flaw in 026-029, fix it within those plans' documented scope, but
  don't use this plan as a vehicle for scope not already in the PRD.
- Redis/DB-backed persistence — PRD §4 explicitly keeps in-memory state a
  v1 non-goal-to-solve; this plan's reconnect work is about *not losing
  state while the server is up*, not surviving a restart.

## Git workflow

- Branch: `feat/workshop-tracker-m5-hardening`.
- Conventional commits, e.g.:
  - `feat(workshop-tracker-server): resume participant identity on rejoin`
  - `test(workshop-tracker-server): load test at 50-100 concurrent participants`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Reconnect/resume

Client (`packages/addon-workshop-tracker`): on join-screen mount, check
`sessionStorage` for a previously-stored `participantId` for this
room/session; if present, send it as part of `participant:join { name,
roomCode, resumeParticipantId? }` instead of (or alongside) prompting for a
name again — PRD §12 says refresh/brief-drop resume should happen "without
re-joining as a 'new' participant", which implies skipping the join-screen
prompt entirely on a same-session resume, not just quietly linking IDs
behind an unchanged UI.

Server: on `participant:join`, if `resumeParticipantId` is present and
matches a known `Participant`, reuse it (update `lastSeen`, mark
`connected: true`, keep its existing `stepStatus` entries and `name`
untouched — even if a different name was somehow supplied, the resumed
identity wins, since name is part of what's being resumed) instead of
creating a new row. If the id is unknown (server restarted, or it's actually
a different session's stale value), fall back to normal fresh-join behavior
— log this distinctly from a normal join so an operator can tell resume
failures from first-time joins during a real session.

**Verify**: join as a participant, do a Copy + Done on a step, hard-refresh
the browser tab. **Expected**: no name prompt, same participant row on the
dashboard (not a duplicate), same step status still marked done. Then
restart `workshop-tracker-server` and refresh the same tab again.
**Expected**: falls back to a fresh join (name prompt reappears) rather than
hanging or erroring — this is the accepted, documented in-memory-state-reset
case from PRD §4/§14, not a bug to fix here.

### Step 2: Load test

Pick a load-testing approach appropriate to Socket.io (a plain HTTP load
tool won't exercise the WS upgrade + event traffic that actually matters
here). `artillery` has a Socket.io engine; alternatively a small custom
script spinning up N `socket.io-client` connections directly against
`workshop-tracker-server`, each simulating a participant (join, occasional
heartbeat, occasional copy/done) is lower-dependency and easier to tailor to
this project's actual event shapes — prefer the custom-script route unless
`artillery`'s Socket.io support turns out to fit cleanly; don't add a new
dependency for this if a ~100-line script does the job.

Measure, with N simulated participants (start at 50, push toward 100 per
PRD §3/§12):
- Time from a `presenter:setSlide` emission to the last simulated
  participant receiving `slide:changed`.
- Time from a simulated participant's `participant:copy`/`done` to that
  update appearing in a `state:update` payload observed by a dashboard-role
  connection.

Record the actual measured numbers (not just pass/fail against the ~1s
target) in this plan's "Done criteria" checklist or a short results note
committed alongside the test script, so a future session doesn't have to
re-run it from scratch to know where headroom is.

**Verify**: at 50 concurrent simulated participants, both measured latencies
stay within ~1s (PRD §12). If they don't, treat it as a STOP condition (see
below) rather than silently shipping a target the PRD explicitly set.

### Step 3: Auth-under-load + final acceptance pass

Re-run 029's auth rejection tests (wrong/missing presenter code, wrong/missing
room code) while the load-test's N simulated participants are connected, to
confirm the gate doesn't have a concurrency-dependent hole (e.g. a race in
how the presenter credential check is applied per-connection).

Then walk PRD §15's full acceptance-criteria list end to end, live, with the
complete stack (demo deck, sync server, dashboard) exactly as a real
workshop would run it, and record the outcome of each bullet:

- Slide-change propagation ≤ ~1s, no manual refresh
- Copy → dashboard "in progress" ≤ ~1s
- Done → dashboard "done"
- Text/screenshot error report → dashboard error feed, correctly attributed
- Presence column distinguishes all four states within ~5s
- Whole stack runs as a persistent server process (not a `slidev build`
  static export) — confirm the actual run command used throughout this
  initiative never was `slidev build` for the tracked-session path

## Test plan

- `workshop-tracker-server` vitest: resume-by-id reuses the existing
  participant and its step statuses; an unknown resume id falls back to
  fresh join cleanly (no error thrown, no partial state).
- The load-test script itself (Step 2) is the primary new "test" this plan
  produces — commit it (e.g. `packages/workshop-tracker-server/scripts/load-test.mjs`
  or a `test/load/` dir) so it's re-runnable, not a one-off throwaway.
- Manual: Step 3's full acceptance walk.

## Done criteria

- [ ] Refresh/brief-drop resumes the same participant identity and step
      status without a re-join prompt or a duplicate dashboard row
- [ ] A resume attempt against an unknown/expired id falls back to a clean
      fresh join (server restart case handled gracefully, matching PRD
      §4/§14's accepted in-memory-reset behavior)
- [ ] Load test committed and re-runnable; measured latency numbers at
      50(+) concurrent simulated participants recorded and within the ~1s
      target for both slide-change and step-status propagation
- [ ] Presenter/room-code auth (029) re-verified as not having a
      concurrency-dependent gap under the load test's connection count
- [ ] Every PRD §15 acceptance bullet walked live against the full stack
      and confirmed, with results noted (not just "looks fine")
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` all pass
- [ ] Only in-scope paths modified/added (`git status`)
- [ ] `plans/README.md` status row for 030 updated (and, since this closes
      the initiative, consider a one-line rollup note in `plans/README.md`
      that M1-M5 are complete, pointing back at this plan)

## STOP conditions

Stop and report if:

- The load test shows latency materially exceeding the ~1s target at 50
  concurrent participants — this means the room-scoped broadcast design
  from 027 (or something else in the transport) needs rework, which is a
  real design change, not a parameter tweak; report the measured numbers
  and don't quietly relax the target instead of the implementation.
- Resume logic can be tricked into hijacking another participant's identity
  (e.g. if `resumeParticipantId` alone is trusted with no other binding to
  the original session/socket) — that's a security regression on top of
  029's work, not an acceptable trade-off for convenience; if the simplest
  resume design has this hole, it needs a fix (e.g. binding resume to the
  same room code, or a short-lived resume token issued at original join
  time) before this plan can close.

## Maintenance notes

- The committed load-test script (Step 2) is this initiative's regression
  guard against future latency regressions — if a later change to the
  server touches the broadcast path, re-run it rather than assuming.
- This plan is the last of the PRD's five milestones (`plans/prd-workshop-tracking.md`
  §13) — once done, the initiative's status in `plans/README.md` should
  reflect that the whole tracked feature set (slide sync, step tracking,
  error reporting, presence, auth, resume, load-verified) is complete, not
  just that five individual plans were checked off.
