# PRD: Slidev Live Workshop Tracking (Client–Server Mode)

> **Provenance**: supplied verbatim by the owner (AnuchitO) on 2026-08-26 as the
> source-of-truth requirements doc for the workshop-tracking initiative. It is
> reference material, not itself an executable plan — see the derived,
> executor-ready plans **[026](./026-workshop-tracker-m1-slide-sync.md)** through
> **[030](./030-workshop-tracker-m5-hardening.md)**, indexed in
> [`plans/README.md`](./README.md#workshop-tracking-initiative-026-030). Do not
> hand-edit this file to reflect implementation decisions — record those in the
> plans instead; only update this copy if the owner revises the PRD itself.

**Owner:** AnuchitO
**Status:** Draft — for implementation via Claude Code
**Last updated:** 2026-08-26

## 1. Summary

Turn [Slidev](https://sli.dev) from a slide tool you present *from* into a live,
two-way workshop platform: when the instructor advances a slide, every
participant's browser follows automatically; each hands-on step can be
acknowledged ("copied the command" → "done") by each participant individually;
the instructor sees a single live dashboard of who's on track, who's stuck, and
who's hit an error — without walking over to anyone's machine.

This requires running Slidev in **client–server mode**: a persistent backend
process (not just a static SPA build) that every participant's browser and the
instructor's dashboard stay connected to for the duration of the session.

## 2. Problem statement

Running a hands-on technical workshop (e.g. a QA/CI tooling session) with
Slidev today gives the instructor no visibility into the room. They can't tell:

- Whether everyone is still on the current slide, or has fallen behind.
- Whether a participant has actually run the command being taught, or is just
  staring at a blank terminal.
- Who is stuck on an error, until that person raises their hand or the
  instructor happens to walk past their screen.
- Who has the slides open at all, versus who dropped off.

For remote/hybrid workshops, none of this is visible at all.

## 3. Goals

1. **Slide sync** — instructor's current slide pushes to every connected
   participant in real time.
2. **Step acknowledgment** — a step with a command shows a *Copy* button;
   clicking it marks that participant "in progress" on that step. A *Done*
   button marks it "complete." Both states are visible per participant, per
   step, on the instructor's dashboard.
3. **Error reporting** — a participant can report a problem on the current
   step by pasting error text and/or capturing a screenshot of their screen;
   it appears on the instructor's dashboard immediately, tied to that
   participant and step.
4. **Presence tracking** — the dashboard shows, per participant: joined /
   not joined, actively viewing vs. tab backgrounded ("away"), and
   disconnected/closed.
5. Ship as a **self-hostable client–server app** — a persistent Node backend
   plus the Slidev frontend — not a static export, since static hosting can't
   support any of the above.

## 4. Non-goals (v1)

- Video/audio conferencing (assume a separate call tool — Zoom/Meet/Teams —
  runs alongside this).
- Grading, scoring, or certification.
- Multi-room / multi-workshop concurrency (single active session is enough
  for v1; design the data model so it's not painful to add later).
- Persisting history across server restarts (in-memory state is acceptable
  for v1 — see §9).
- Mobile-native apps — participant view is a responsive web page.

## 5. Personas

- **Instructor / Presenter** — runs the session, controls slide navigation,
  is the sole consumer of the dashboard. One per session.
- **Participant** — joins with a name, follows the synced slides on their own
  device, acknowledges steps, reports errors. Many per session (design for
  ~50–100 concurrent; note if that changes).

## 6. Existing foundation — what NOT to build from scratch

Slidev's own built-in Presenter Mode only synchronizes the presenter's
notes/timer window with the main slide window **within the same browser** — it
is not designed for syncing across separate participant devices.

There is already community prior art for the cross-device piece worth
building on rather than re-inventing:

- **[slidev-addon-sync](https://github.com/Smile-SA/slidev-addon-sync)** — a
  Slidev addon that syncs slide navigation (and drawing/annotation state)
  across connected devices over SSE or WebSocket, using a shared room code.
  It only handles navigation sync — no participant identity, no
  step-acknowledgment, no error reporting, no dashboard.
- **[slidev-sync-server](https://github.com/Smile-SA/slidev-sync-server)** —
  the companion backend the addon above talks to.

**Recommendation:** fork/extend `slidev-addon-sync` +
`slidev-sync-server` (or write a new addon following the same pattern —
[Slidev's "Writing Addons" guide](https://sli.dev/guide/write-addon) covers
the extension points: custom Vue components, layouts, and Vite/build config)
rather than building slide-sync transport from zero. Layer the new
requirements — participant registry, step status, error reports, presence —
on top of that transport, since none of it exists upstream today.

Also note: [Slidev's own build/hosting model](https://sli.dev/guide/hosting)
compiles to a **static SPA** with no backend. That static-export path is
incompatible with everything in this PRD — the deployed artifact here must be
the Node dev/serve process kept running for the session's duration, not a
`slidev build` static bundle.

A **standalone Node/Socket.io prototype already exists** (delivered
separately in this conversation) that validates the full event model this PRD
describes — slide-change broadcast, copy/done step tracking, text + screenshot
error reports, and presence states — end to end, with a working dashboard UI.
It is *not* built on Slidev; treat it as a reference implementation for the
event contract and dashboard UX (§10–§11), to be reimplemented natively inside
the Slidev addon + sync-server stack rather than shipped as-is.

## 7. Proposed architecture

```
┌─────────────────────────┐        WebSocket/SSE        ┌──────────────────────────┐
│  Participant browsers    │ <──────────────────────────>│                          │
│  (Slidev SPA + addon)    │                              │   Sync/Tracking Server   │
└─────────────────────────┘                              │   (Node, extends         │
                                                            │   slidev-sync-server)    │
┌─────────────────────────┐        WebSocket/SSE          │                          │
│  Instructor slide view    │ <────────────────────────────>│  - room/session state   │
│  (Slidev SPA, presenter)  │                              │  - participant registry │
└─────────────────────────┘                              │  - step status store    │
                                                            │  - error report store   │
┌─────────────────────────┐        WebSocket/SSE          │                          │
│  Instructor Dashboard     │ <────────────────────────────>│                          │
│  (new: dashboard route/   │                              └──────────────────────────┘
│   app served by same      │                    ▲
│   Node server)             │                    │ POST /api/screenshot (multipart)
└─────────────────────────┘                    (participant → server)
```

Key pieces to build:

1. **`slidev-addon-workshop-tracker`** (new Slidev addon) — adds:
   - A `<StepCommand>` Vue component for use in slide markdown: renders a
     command block with a Copy button and a Done button, wired to the sync
     client.
   - A join screen (name entry) shown to participants before the deck loads.
   - An error-report widget (text box + "capture screen" button) always
     accessible from the participant view.
   - Presence heartbeat + Page Visibility API hooks.
2. **Extended sync server** (fork of `slidev-sync-server` or new Node/Express
   + `ws`/`socket.io` service) — adds the participant/step/error/presence
   state described in §9–§10 on top of the existing slide-navigation sync.
3. **Instructor dashboard** — a new web route (can reuse the standalone
   prototype's dashboard UI, ported to talk to the extended sync server)
   showing live participant status, per-step progress, and the error feed.
4. **Persistent server process** — replaces `slidev build`'s static output
   for this use case; run via `slidev dev` (or a small custom Node
   entrypoint that mounts Slidev's Vite middleware) kept alive for the
   session, reachable by all participants on the same network/VPN or a small
   cloud host.

## 8. Slide-authoring conventions

Slides remain plain Slidev markdown. Steps that need tracking are marked with
frontmatter + the new component, e.g.:

```md
---
stepId: install-deps
---

# Step 2 — Install dependencies

<StepCommand command="cd workshop-repo && npm install" />
```

- `stepId` (per-slide frontmatter) is the stable key used across the
  dashboard, so re-ordering slides later doesn't corrupt historical
  progress data. Falls back to the slide index if omitted.
- `<StepCommand>` can appear zero or more times per slide (some slides won't
  have a command; the Done button should still be available so participants
  can acknowledge "read/understood" steps too).

## 9. Data model (in-memory for v1; keep swappable for Redis/DB later)

- **Session** — `{ id, currentSlideIndex, createdAt }`
- **Participant** — `{ id, name, joinedAt, lastSeen, connected: bool, visibility: 'visible'|'hidden'|'closed', currentSlideIndex }`
- **StepStatus** — keyed by `(participantId, stepId)` → `'idle' | 'copied' | 'done'`
- **ErrorReport** — `{ id, participantId, participantName, stepId, text, screenshotUrl, ts, resolved: bool }`

## 10. Event / API contract

WebSocket (or SSE + POST, matching the existing sync-server's transport):

**Instructor → server**
- `presenter:setSlide { index }` → rebroadcast as `slide:changed { index }` to all participants.
- `presenter:resolveError { errorId }`

**Participant → server**
- `participant:join { name }` → returns participant id + current state.
- `participant:copy { stepId }`
- `participant:done { stepId }`
- `participant:error { stepId, text }`
- `participant:visibility { state }` (on `visibilitychange`)
- `participant:heartbeat { stepId }` (every ~5s, doubles as "still connected" signal)

**Participant → server (REST, for file upload)**
- `POST /api/screenshot` (multipart: `participantId`, `stepId`, `text?`, `screenshot`) — captured via
  `navigator.mediaDevices.getDisplayMedia` in-browser; requires HTTPS or
  `localhost`, and a Chromium/Firefox desktop browser (documented limitation —
  always offer the text-paste path as a fallback since screen capture isn't
  universally supported).

**Server → instructor dashboard**
- `state:update { currentSlideIndex, participants[], errors[] }` on every
  relevant change.

## 11. Instructor dashboard requirements

- Slide controls: prev/next, jump-to-step.
- Live counts: joined, online, viewing now, done-this-step / total, open
  errors.
- Participant table: name, presence (viewing now / away / closed), which
  slide they're actually on (flag if behind the instructor's current slide),
  status for the *current* step (not started / in progress / done), last
  seen.
- Error feed: participant, step, timestamp, error text and/or screenshot
  thumbnail (click to enlarge), mark-resolved action.
- No polling from the dashboard side — all updates push over the same
  socket connection used for slide sync.

## 12. Non-functional requirements

- **Self-hosted, LAN/VPN or small cloud VM reachable by all participants** —
  no dependency on a public SaaS.
- **Latency:** slide-change broadcast and step-status updates visible on the
  dashboard within ~1 second under normal workshop-room network conditions.
- **Scale:** support at least 50 concurrent participants without degrading
  sync latency; note this in testing.
- **Auth:** presenter routes/dashboard require a session password or
  presenter-only join code — do not ship the dashboard open to anyone who
  guesses the URL. Participants join via a shared room/session code, matching
  `slidev-addon-sync`'s existing pattern.
- **Resilience:** a participant's browser refresh or brief network drop
  should reconnect and resync current slide + their own step statuses
  without re-joining as a "new" participant (session token in
  `sessionStorage`, keyed to participant id).
- **Browser support:** latest Chrome/Edge/Firefox desktop for full feature
  set (screen capture); graceful degradation (text-only error reporting) on
  anything else, including mobile.

## 13. Milestones

1. **M1 — Slide sync only:** stand up the extended sync server + addon with
   just `presenter:setSlide` / `slide:changed`, validated against a real
   Slidev deck, multi-device. (De-risks the Slidev integration itself before
   layering on tracking.)
2. **M2 — Step tracking:** `<StepCommand>` component, copy/done events,
   dashboard participant table with step-status column.
3. **M3 — Error reporting:** text + screenshot capture, dashboard error feed.
4. **M4 — Presence:** visibility + heartbeat + disconnect handling, dashboard
   presence column, join-code/auth gate.
5. **M5 — Hardening:** reconnect/resume, load-test at target participant
   count, basic auth on presenter routes.

## 14. Open questions

- Single fixed workshop room, or does the instructor need to spin up
  multiple concurrent sessions (e.g. running the same workshop twice in one
  day)? Affects whether "Session" needs to be a first-class, creatable
  entity in v1 or can stay a singleton.
- Should participant step-status persist if the *instructor's* server
  restarts mid-workshop, or is "state resets on restart" acceptable for v1
  (matches the standalone prototype's current behavior)?
- Any requirement to export the final per-participant completion report
  after the workshop (e.g. CSV of who finished which steps)?

## 15. Acceptance criteria (v1)

- Instructor changes slide → all connected participants' views update within
  ~1s, without a manual refresh.
- Participant clicks Copy on a step's command → dashboard shows that
  participant as "in progress" on that step within ~1s.
- Participant clicks Done → dashboard shows "done" for that participant/step.
- Participant submits an error (text and/or screenshot) → it appears in the
  dashboard's error feed, attributed to the right participant and step,
  without the instructor doing anything on that participant's machine.
- Dashboard presence column correctly distinguishes: never joined, actively
  viewing, backgrounded tab, and closed/disconnected, updating within ~5s of
  the underlying state change.
- The whole stack runs as a persistent server process reachable by every
  participant's browser over the workshop's network — not a static
  `slidev build` export.

## Sources

- [Writing Addons — Slidev](https://sli.dev/guide/write-addon)
- [slidev-addon-sync — GitHub](https://github.com/Smile-SA/slidev-addon-sync)
- [Building and Hosting — Slidev](https://sli.dev/guide/hosting)
