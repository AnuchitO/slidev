# Plan 028: Workshop Tracker M3 — error reporting (text + screenshot)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Source doc**: [`plans/prd-workshop-tracking.md`](./prd-workshop-tracking.md)
> §9, §10 (REST section), §11 (error feed), §13 (M3). Builds on
> [027](./027-workshop-tracker-m2-step-tracking.md) — participant identity
> and the dashboard already exist; this plan adds a new report type and feed.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED (first file-upload/REST surface alongside the WS transport;
  browser screen-capture API has real compatibility limits to respect, not
  paper over)
- **Depends on**: 027
- **Category**: feature
- **Planned at**: commit `a8d8ff71`, 2026-08-26

## Why this matters

Error reporting (PRD Goal 3) is the instructor's earliest signal that
someone's stuck — the whole point of the dashboard is catching this without
a participant having to raise a hand. It's scoped separately from M2 because
it introduces a genuinely different transport (multipart POST for the
screenshot, per PRD §10) alongside the WS event stream, and a browser API
(`getDisplayMedia`) with real capability/consent limits that need honest
fallback behavior, not a happy-path-only implementation.

## Current state (after 027)

- `packages/workshop-tracker-server/` has a Socket.io server with
  participant/step state and a room-scoped `state:update` broadcast to
  dashboard clients; it's WS-only so far — no HTTP route handling exists
  beyond Socket.io's own `/socket.io/` path.
- `packages/addon-workshop-tracker/` has `<StepCommand>` and a join screen;
  no error-reporting UI exists yet.
- Dashboard is a small static page served by the sync server (027 Step 3,
  option 1) — same origin as any new REST endpoint this plan adds, so no
  CORS work needed for the upload.

## Commands you will need

Same as 026/027, plus:

| Purpose | Command | Expected |
|---------|---------|----------|
| Manual multipart smoke test | `curl -F participantId=p1 -F stepId=s1 -F text=hi -F screenshot=@test.png http://localhost:3710/api/screenshot` | 2xx, response includes a screenshot URL |

## Scope

**In scope**:
- `packages/workshop-tracker-server/`: `ErrorReport` store (§9), `POST
  /api/screenshot` multipart handler, static serving of uploaded
  screenshots, `participant:error` WS handler (text-only path),
  `presenter:resolveError` handler, error data folded into `state:update`
  (or a separate `errors:update` event — decide in Step 1, see note).
- `packages/addon-workshop-tracker/`: an always-accessible error-report
  widget (text box + optional "capture screen" button), feature-detecting
  `getDisplayMedia` and hiding/disabling the capture path when unsupported
  rather than showing a broken button (PRD §10, §12 browser-support note).
- Dashboard: error feed (participant, step, timestamp, text/screenshot
  thumbnail, mark-resolved).

**Out of scope** (deferred):
- Presence-aware error attribution beyond "which participant, which step"
  (029 adds presence state generally; an error report already carries
  `participantId`/`stepId` per §9, independent of presence tracking).
- Any storage retention/cleanup policy for uploaded screenshots beyond "keep
  them in memory/disk for the session" — no requirement in the PRD for
  cross-restart persistence (§4 non-goals), so don't build it.
- Rate-limiting/abuse-hardening of the upload endpoint beyond basic size
  limits — note it as a 030 hardening candidate if it feels underdone, but
  don't scope-creep this plan chasing it.

## Git workflow

- Branch: `feat/workshop-tracker-m3-error-reporting`.
- Conventional commits, e.g.:
  - `feat(workshop-tracker-server): error report store + screenshot upload`
  - `feat(addon-workshop-tracker): error report widget with screen capture`
  - `feat(workshop-tracker-server): dashboard error feed`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Server — `ErrorReport` store + REST upload endpoint

Extend state (PRD §9 shape, adding `resolved`):

```ts
export interface ErrorReport {
  id: string
  participantId: string
  participantName: string
  stepId: string
  text?: string
  screenshotUrl?: string
  ts: number
  resolved: boolean
}
export const errorReports: ErrorReport[] = []
```

Decide and document the update-broadcast shape here (not implicitly): either
fold `errors` into the existing `state:update` payload (simplest, matches
PRD §10's literal `state:update { currentSlideIndex, participants[],
errors[] }` shape) or use a separate event. **Use the PRD's literal shape**
(`state:update` carrying all three) unless Step 1's own measurement shows
the combined payload is a problem at realistic error-report volumes (it
won't be — error reports are rare compared to step-status churn) — this
also means 027's dashboard client code needs no restructuring, just a new
field to render.

Add an HTTP layer alongside Socket.io on the same `http.Server` (reuse the
`createServer` instance from 026/027, don't stand up a second server/port).
Use a minimal multipart parser appropriate to the existing dependency
footprint — check whether `socket.io`'s transitive deps already pull in
something usable (e.g. `engine.io` doesn't help here) before adding a new
dependency; a small, well-maintained multipart library (e.g. `busboy` or
`formidable`) is reasonable to add fresh since none of this repo's existing
catalog covers file uploads.

```ts
// POST /api/screenshot  (multipart: participantId, stepId, text?, screenshot)
// - validate participantId exists in the registry (reject unknown ids)
// - cap upload size (document the chosen limit, e.g. 5MB, in the README)
// - write to disk under a session-scoped temp/uploads dir, or hold in
//   memory if small enough — pick one and document it (disk is safer for
//   the target 50-100 participant scale; don't hold arbitrary screenshots
//   in process memory indefinitely)
// - push an ErrorReport, broadcast state:update, respond 201 with the
//   report's id + screenshotUrl
```

Serve uploaded screenshots back via a static route (e.g. `/uploads/:id.png`)
scoped so a request can't path-traverse outside the uploads dir — this repo
has prior art for exactly this class of bug (`plans/016-confine-export-output-path.md`,
`plans/014`/`015` referenced in `plans/README.md`'s "Security cluster");
apply the same discipline here rather than reintroducing the pattern this
repo has already been hardening elsewhere.

**Verify**: the `curl` command above returns 2xx with a `screenshotUrl`;
fetching that URL returns the image; a crafted `stepId`/filename containing
`../` is rejected or safely normalized, not written outside the uploads dir.

### Step 2: Addon — error-report widget

`packages/addon-workshop-tracker/components/ErrorReportWidget.vue` —
persistent, low-chrome UI (e.g. a small floating button that expands to a
form) available regardless of which slide is showing, per PRD §7 addon
deliverable list item 3:
- Text box, always available (the required fallback per PRD §10/§12).
- "Capture screen" button, shown only when `navigator.mediaDevices?.
  getDisplayMedia` exists **and** the page is on `https:` or `localhost`
  (PRD §10's stated requirement) — feature-detect explicitly, don't just
  try/catch and hope; a participant on a browser lacking the API should see
  a widget that never implies screen capture was an option.
- On submit: if a screenshot was captured, `POST /api/screenshot` (Step 1's
  endpoint) with the current `participantId` (from 027's join state) and
  the current `stepId` (from the active slide's frontmatter, same source
  `<StepCommand>` uses); if text-only, either also hit the REST endpoint
  (without a file field) or use the WS `participant:error { stepId, text }`
  event from PRD §10 — pick one path for text-only and document it; don't
  implement both a WS and a REST path for the identical text-only case.

**Verify**: submitting text-only from a participant window produces an
error-feed row on the dashboard within ~1s (PRD §15, fourth bullet);
submitting with a captured screenshot (on a supporting browser) produces a
row with a viewable thumbnail; on a browser/context where
`getDisplayMedia` is unavailable, the capture control is absent (not
present-but-broken) and the text path still works.

### Step 3: Dashboard — error feed

Add a feed section to the dashboard (027 Step 3's static page): rows of
participant name, step, timestamp, text and/or screenshot thumbnail
(click to view full-size — a plain `<img>` `onclick` swap/lightbox is
enough, no new dependency needed), and a "mark resolved" button wired to
`presenter:resolveError { errorId }`.

**Verify**: clicking mark-resolved updates that row's state on the dashboard
(e.g. visually dimmed/moved to a "resolved" section) and persists across a
dashboard page reload for the remainder of the session (i.e. resolved state
lives server-side in the `ErrorReport`, not just client-side UI state).

## Test plan

- Extend the `workshop-tracker-server` vitest suite: posting to
  `/api/screenshot` with a valid participant creates an `ErrorReport` and
  triggers `state:update`; an unknown `participantId` is rejected; a
  path-traversal attempt in any user-controlled filename component is
  rejected/normalized (mirrors the discipline in plans 014-016).
- Manual: the widget + dashboard walkthroughs in Steps 2-3.

## Done criteria

- [ ] `ErrorReport` store + `POST /api/screenshot` implemented with upload
      size cap and path-traversal-safe storage/serving
- [ ] `participant:error` (text) and the screenshot REST path both work and
      don't duplicate each other's responsibility
- [ ] Error widget feature-detects `getDisplayMedia` correctly and never
      shows a non-functional capture control
- [ ] Dashboard error feed shows participant/step/timestamp/text/thumbnail
      and mark-resolved works and persists server-side
- [ ] New vitest coverage for the upload endpoint, including the
      path-traversal case
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` all pass
- [ ] Only in-scope paths modified/added (`git status`)
- [ ] `plans/README.md` status row for 028 updated

## STOP conditions

Stop and report if:

- The chosen multipart library pulls in a dependency tree that conflicts
  with `pnpm-workspace.yaml`'s `trustPolicy`/`resolutions` settings — report
  the conflict rather than working around trust policy.
- `getDisplayMedia` behaves inconsistently enough across the target browsers
  (PRD §12: latest Chrome/Edge/Firefox desktop) that the feature-detection
  in Step 2 can't be made reliable without per-browser special-casing beyond
  a simple capability check — report findings, don't ship silent breakage.

## Maintenance notes

- The upload size cap and storage location (disk vs memory) chosen in Step 1
  are load-bearing for 030's load-testing at 50-100 participants — if 030
  finds disk I/O or memory pressure from screenshots is the bottleneck,
  that's this plan's choice to revisit, not a from-scratch redesign.
