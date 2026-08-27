# PR proposal: `feat/muan-companion` → `main`

> This file is a ready-to-paste GitHub PR description. Copy everything below
> the `---` into the PR body.

---

## Suggested PR title

`feat: live workshop tracking for Slidev (muan companion)`

## Summary

This branch turns Slidev from a slide tool you present *from* into a live,
two-way workshop platform. It adds a new Slidev addon and a companion
Node/Socket.io server — **muan companion** — that keeps every participant's
browser in sync with the presenter's slide, lets participants acknowledge
hands-on steps, ask for help (report an error or ask a question, with
screenshot capture), and gives the instructor a single live dashboard of who's
in the room, who's on track, and who's stuck — all self-hosted, no SaaS
dependency.

## Motivation

Running a hands-on technical workshop with Slidev today gives the instructor
zero visibility into the room. They can't tell whether everyone is still on
the current slide or has fallen behind, whether a participant actually ran the
command being taught or is staring at a blank terminal, who's silently stuck
on an error until they raise a hand or the instructor happens to walk past
their screen, or who even still has the slides open versus who dropped off.
For remote/hybrid sessions none of this is visible at all. `plans/prd-workshop-tracking.md`
captures this problem statement in full; this branch is the implementation of
that PRD, milestones M1 through M5, plus one post-ship UX iteration driven by
dogfooding the tool in a real session.

## What's included

**M1 — Slide sync.** The presenter's current slide pushes to every connected
participant's browser in real time over Socket.io, including a late-joining
or refreshed participant landing on the presenter's current slide rather than
slide 1. This stands up the whole transport (a new `slidev-addon-muan-companion`
addon talking to a new standalone `muan-companion-server`) before any tracking
logic is layered on top, de-risking the Slidev integration itself first.

**M2 — Step tracking.** A `<StepCommand>` component embeds a copyable command
in slide markdown; clicking Copy marks a participant "in progress" on that
step, and a Done button marks it complete — both visible per participant, per
step, on a new instructor dashboard's participant table. Steps are keyed by a
stable `stepId` (slide frontmatter, falling back to slide index) so
re-ordering slides later doesn't corrupt historical progress.

**M3 — Error reporting.** Participants get an always-available "report a
problem" widget: free-text description, plus an optional captured screenshot
(via `getDisplayMedia`, with automatic fallback to text-only on browsers/
contexts that don't support screen capture). Reports appear on the dashboard's
error feed immediately, attributed to the right participant and step, with
click-to-enlarge screenshot thumbnails.

**M4 — Presence + auth.** The dashboard now distinguishes, per participant,
between actively viewing, tab backgrounded ("away"), and disconnected/closed —
driven by the Page Visibility API plus a heartbeat/staleness sweep that also
catches a hung connection that never fires a clean disconnect (e.g. flaky
workshop wifi). This milestone also closes the security gap M1–M3 shipped
with by design: participants now join with a room code, and every
presenter/dashboard action requires a separate, higher-privilege presenter
code, checked with a constant-time comparison.

**M5 — Hardening (reconnect/resume + load test).** A participant's page
refresh or brief network drop now resumes their existing identity and step
history instead of rejoining as a new person — backed by a resume credential
persisted client-side, with a graceful fallback to a clean join if the server
no longer recognizes it (e.g. it restarted). A dedicated, checked-in load test
validates the PRD's concurrency target (see Testing below). Multiple real bugs
surfaced during this milestone's own live-workshop dogfooding are fixed along
the way: a `sessionStorage`→`localStorage` switch so a closed-and-reopened tab
still resumes correctly, a "Join as someone else" escape hatch for shared/
kiosk machines, an orphaned-participant bug on failed resume, and a multi-tab
presence bug where closing a second tab incorrectly marked a still-present
participant as closed.

**Post-ship: "Ask for Help" redesign.** Direct feedback from running a real
session drove two more passes. First, a Material Design UI pass on both the
participant-facing widget and the dashboard's error feed, for a more
legible, professional-looking tool in front of a room. Second, and more
substantially, the one-shot "report a problem → presenter marks resolved"
flow was redesigned into a genuine two-way conversation: reports now carry a
`kind` (problem or question) and a four-state status (open → awaiting
confirmation → resolved, or reopened), plus an append-only message thread.
The presenter can reply without resolving, and — critically — resolving a
report no longer unilaterally closes it: the participant gets the final say,
confirming "yes, that fixed it" or reopening with "still need help." This
closes a real gap in the original design, where the instructor could mark
something resolved that, from the participant's side, wasn't actually fixed.

**Post-ship: shareable join link + QR code, and self-generating codes.**
Two more follow-ups from actually running this. First, the dashboard now
shows a "Share this workshop" panel with a ready-to-copy join link
(`<deck-url>?roomCode=<code>`, paste it into Teams/Zoom/Slack) and a QR
code encoding it — scanning or clicking it takes a participant straight to
the join screen with the room code prefilled, so they still explicitly
join, they just never have to ask or mistype the code. Second, the room
code and presenter code no longer have to be hand-picked: if an operator
doesn't set the two env vars, the server generates a fresh, readable code
pair (excluding visually-ambiguous characters like `0`/`O`/`1`/`I`) on every
startup and prints them — an explicit env var still overrides generation
for a fixed/repeatable setup. This directly narrows one of this PR's
originally-listed limitations (see "Known limitations" below).

**On the rename:** partway through this work the project was renamed from
"workshop-tracker" to "muan-companion" (packages, env vars, localStorage keys,
CSS class prefixes, and a follow-up pass that also dropped a redundant
`slidev-` prefix from the server package's own name). This was a pure,
scripted, case-aware text substitution — no behavior changed, and both test
suites passed identically (378/378) before and after. The historical plan
documents (`plans/026`–`030`, the PRD) deliberately keep the old name, since
they're a frozen record of what was decided and built at the time.

## Architecture at a glance

```
Participant browsers (Slidev SPA + addon)  <──WS──>
Instructor slide view (Slidev SPA, presenter route)  <──WS──>   Sync/Tracking Server
Instructor Dashboard (served by the same Node server)  <──WS──>  (room state, participant
                                          <──POST /api/screenshot──   registry, step status,
                                                                       error/help reports)
```

Three pieces:

1. **`slidev-addon-muan-companion`** (`packages/addon-muan-companion`) — a
   Slidev addon adding the join screen, `<StepCommand>`, the Ask-for-Help
   widget, and presence/reconnect plumbing, all wired to a shared
   `socket.io-client` connection.
2. **`muan-companion-server`** (`packages/muan-companion-server`) — a
   standalone Node + Socket.io service holding session/participant/step/error
   state and exposing the event contract, plus a `POST /api/screenshot`
   upload endpoint.
3. **Instructor dashboard** — a dependency-free static page served by that
   same Node process at `/dashboard`, styled in Material Design, pushed to
   live via the same socket (no polling).

This follows the PRD's own §6 recommendation not to force-fit the
community prior art it surveyed (`slidev-addon-sync` / `slidev-sync-server`
only handle slide navigation, with no participant identity, step tracking,
error reporting, or dashboard) and instead build a purpose-built sync layer
with those requirements as first-class concerns. It matches the architecture
diagram the PRD proposes in §7 — addon + extended sync server + dashboard,
all behind one persistent Node process rather than a `slidev build` static
export.

## Testing

Run just now against this branch:

```
$ pnpm --filter muan-companion-server test -- --run
 Test Files  7 passed (7)
      Tests  123 passed (123)

$ pnpm --filter slidev-addon-muan-companion test -- --run
 Test Files  7 passed (7)
      Tests  41 passed (41)

$ pnpm eslint packages/muan-companion-server packages/addon-muan-companion
(no output — clean)
```

164 tests pass across both packages, no lint findings.

`packages/muan-companion-server/src/server.test.ts` spins up real
`socket.io-client` connections and real multipart `fetch()` requests against
an in-process server, covering the full event contract, both auth-rejection
paths, presence transitions, and the screenshot upload/serve contract
(including path-traversal rejection). Pure logic (auth comparison, presence
staleness sweep, session store, upload path resolution, participant identity
resume/join-outcome helpers) has dedicated unit coverage on the addon side
too (`participantIdentity.test.ts`, `stepCommandStatus.test.ts`,
`presenterCode.test.ts`, etc.).

A dedicated, checked-in load test
(`packages/muan-companion-server/scripts/load-test.ts`, documented in that
package's README, re-runnable via `pnpm --filter muan-companion-server
load-test`) validates the PRD §12 concurrency target directly: at both 50 and
100 concurrent simulated participants, slide-change and step-status
propagation latency stayed under ~11ms — well inside the PRD's ~1s target —
with presenter/room-code auth re-verified as not having a concurrency-
dependent hole under that load. Results are recorded in
`packages/muan-companion-server/scripts/load-test-results.md`.

**Not covered by automated tests**: the dashboard's `public/dashboard/index.html`
and the addon's Vue components (`ErrorReportWidget.vue`, `JoinScreen.vue`,
etc.) have no dedicated automated UI tests — these were verified manually
(live two-window/two-tab walkthroughs, described in the packages' READMEs and
commit messages) rather than by a test suite. Treat UI-level regressions in
those files as a manual-testing responsibility until/unless component tests
are added.

## Explicitly deferred / non-goals honored from the PRD

- **Multi-session / multi-room concurrency** — PRD §4 non-goal and §14 open
  question. This ships a single global session by design; see
  [`plans/031-muan-companion-session-lifecycle-proposal.md`](./031-muan-companion-session-lifecycle-proposal.md)
  for a proposed direction (in-app code generation with a real setup
  bootstrap, a presenter-configurable "waiting room" lobby before Start
  Presenting, true single-process multi-room support, and a practice-mode
  slide) — none of it implemented yet, pending a scope/priority decision.
- **Cross-restart state persistence** — PRD §4/§9/§14 accept in-memory-only
  state for v1; this branch does not add a database or durable store.
- **Grading / scoring / certification** — out of scope per PRD §4, not
  touched here.

## Known limitations / risks for a reviewer to weigh

- **In-memory-only state.** A server restart mid-workshop loses all
  participant/step/report data. Participants must rejoin, though identity
  resume via `localStorage` softens this for the common refresh/reconnect
  case — a restart specifically (not just a refresh) still resets everyone's
  server-side history.
- **Codes are fixed for the process's lifetime, and regenerating them means
  restarting.** Both codes are now generated automatically if not set via
  env var (see above), so an operator no longer has to hand-pick anything —
  but there's still no way to rotate a code on a *running* server, or for
  the presenter to regenerate one from within the app without a restart. No
  per-participant tokens either — the room code is one shared secret for
  everyone.
- **Single global session only.** The server supports exactly one active
  workshop at a time; it can't run two independent concurrent sessions off
  one process yet (see "multi-session concurrency" above).
- **LAN-workshop-appropriate auth, not SaaS-grade.** No rate-limiting on
  join/presenter-code attempts, and no TLS is provided by the server itself
  (run behind a TLS-terminating proxy for any non-`localhost` deployment).
  This is a documented, deliberate scope boundary, not an oversight — see
  `packages/muan-companion-server/README.md`'s "Auth" section for the full
  threat model.

## How to try it

Two terminals, same as a real workshop:

```bash
# Terminal 1 — the sync server
SLIDEV_MUAN_COMPANION_ROOM_CODE=<pick-one> \
SLIDEV_MUAN_COMPANION_PRESENTER_CODE=<pick-another> \
  pnpm --filter muan-companion-server dev

# Terminal 2 — the demo deck
pnpm --filter slidev-demo-muan-companion dev
```

Open the presenter URL with `?presenterCode=<the presenter code>` appended,
share the plain deck URL with participants (they type the room code once on
the join screen), and open `/dashboard?code=<the presenter code>` on a second
screen. See **`instructor.md`** at the repo root for the full instructor-
facing walkthrough — the three URLs, what the dashboard shows, common
problems, and where to go next.

## Screenshots / demo

**[Attach a screenshot of the instructor dashboard here]**

**[Attach a short screen recording of slide sync across two browser windows here]**

**[Attach a screenshot of the "Ask for Help" widget (both the "Report a
problem" and "Ask a question" tabs) here]**

**[Attach a screenshot of the confirm/reopen card a participant sees after
the presenter marks their report resolved]**

I can't capture real screenshots or recordings myself — these are placeholders
for whoever opens this PR to fill in before requesting review.
