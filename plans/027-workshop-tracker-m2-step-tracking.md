# Plan 027: Workshop Tracker M2 — participant identity + step tracking

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Source doc**: [`plans/prd-workshop-tracking.md`](./prd-workshop-tracking.md)
> §8, §9, §10, §11, §13 (M2). Builds directly on
> [026](./026-workshop-tracker-m1-slide-sync.md) — read that plan first; this
> one assumes its server/addon skeleton and event transport already exist.

## Status

- **Priority**: P1
- **Effort**: M-L
- **Risk**: MED (first persistent per-participant state; first UI surface —
  the dashboard — beyond the slide deck itself)
- **Depends on**: 026
- **Category**: feature
- **Planned at**: commit `a8d8ff71`, 2026-08-26

## Why this matters

Step acknowledgment (PRD Goal 2) is the second core promise of the PRD and
the thing that turns this from "slide sync" into "workshop tracking" — it's
also the milestone that *requires* participant identity to exist at all
(step status is keyed by `(participantId, stepId)`, PRD §9), so this plan
bundles identity + step tracking rather than splitting them: there's no
useful intermediate state where participants have names but no step status,
or step status with no name to attach it to.

## Current state (after 026)

- `packages/workshop-tracker-server/src/session.ts` holds only
  `{ id, currentSlideIndex, createdAt }` — no participant registry yet.
- `packages/workshop-tracker-server/src/index.ts` has one Socket.io
  `connection` handler wiring `presenter:setSlide` → `slide:changed`
  (+ `slide:sync` on connect).
- `packages/addon-workshop-tracker/setup/main.ts` drives router navigation
  off the same socket; no participant-facing UI exists yet — everything so
  far is invisible plumbing.
- No dashboard route/app exists yet.
- Slide markdown frontmatter parsing is Slidev core's (`@slidev/parser`); a
  new `stepId` frontmatter key needs no core changes — Slidev already passes
  arbitrary frontmatter through to `route.meta.slide.frontmatter` (seen in
  `packages/client/logic/slides.ts:109`,
  `currentFrontmatter = currentSlideRoute.currentSlideRoute.meta.slide.frontmatter`),
  so `<StepCommand>` can read `stepId` via the current slide's frontmatter
  without any parser changes. Confirm this empirically in Step 1 before
  relying on it further.

## Commands you will need

Same as plan 026, plus:

| Purpose | Command | Expected |
|---------|---------|----------|
| Run the dashboard (dev) | `pnpm --filter workshop-tracker-server dev` (dashboard is served by the same process — see Step 3) | dashboard route reachable at e.g. `http://localhost:3710/dashboard` |

## Scope

**In scope**:
- `packages/workshop-tracker-server/`: participant registry, `StepStatus`
  store, `state:update` broadcast, join/copy/done event handlers.
- `packages/addon-workshop-tracker/`: join screen component, `<StepCommand>`
  component, wiring both to the socket.
- A minimal dashboard: participant table + per-step status column, served as
  a small static/Vue page by the sync server itself (simplest self-contained
  option — see Step 3 for the alternative considered and why it's deferred).
- `demo/workshop-tracker/slides.md`: extend with `stepId` frontmatter +
  `<StepCommand>` usage on 1-2 slides, so the dashboard has something to show.

**Out of scope** (deferred):
- Error reporting (028).
- Presence beyond "connected socket exists" (029) — no visibility/heartbeat
  states yet; the dashboard's presence column can show a placeholder or be
  omitted until 029.
- Any auth/join-code gating who can open the dashboard (029) — same
  documented gap as 026's presenter auth; carry the same NOTE(security)
  pattern forward.
- Reconnect resuming a *specific* participant's identity/step-status after a
  tab close+reopen (030) — 027 only needs to survive an in-page reconnect
  (socket.io auto-reconnect), not a fresh page load resuming the same
  participant.

## Git workflow

- Branch: `feat/workshop-tracker-m2-step-tracking`.
- Conventional commits, e.g.:
  - `feat(workshop-tracker-server): participant registry + step status store`
  - `feat(addon-workshop-tracker): join screen and StepCommand component`
  - `feat(workshop-tracker-server): minimal instructor dashboard`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Confirm frontmatter passthrough, then extend server state (PRD §9)

Before writing `<StepCommand>`, confirm in a throwaway slide that an
arbitrary frontmatter key (e.g. `stepId: foo`) is readable client-side via
the current slide route's frontmatter (`useNav().currentFrontmatter` inside
an actual component's `setup()` — this is safe here, unlike 026's
`setup/main.ts`, because `<StepCommand>` is a real mounted component with
full injection context). If this doesn't work as expected, treat it as a
STOP condition (see below) rather than improvising a parser change.

Extend `src/session.ts`:

```ts
export type StepState = 'idle' | 'copied' | 'done'

export interface Participant {
  id: string
  name: string
  joinedAt: number
  lastSeen: number
  connected: boolean
}

// Keyed as `${participantId}:${stepId}`
export const stepStatus = new Map<string, StepState>()
export const participants = new Map<string, Participant>()
```

Add event handlers in `src/index.ts`:

- `participant:join { name }` → create/find a `Participant`, `socket.data.participantId = id`, ack back `{ participantId, currentSlideIndex }`.
- `participant:copy { stepId }` / `participant:done { stepId }` → set
  `stepStatus.set(\`${participantId}:${stepId}\`, 'copied' | 'done')`, then
  broadcast `state:update` (see below) to dashboard sockets.
- On any state change relevant to the dashboard, emit
  `state:update { currentSlideIndex, participants: [...], stepStatus: [...] }`
  to a dedicated Socket.io room (e.g. `io.to('dashboard').emit(...)`) so
  participant clients don't receive the full roster on every keystroke of
  every other participant — join the dashboard page to that room on connect.

**Verify**: with two participant sockets connected (e.g. via a small script
or two browser tabs) and a dashboard tab open, emitting `participant:copy`
from one participant tab produces a `state:update` on the dashboard tab
within ~1s.

### Step 2: `<StepCommand>` component + join screen (addon)

`packages/addon-workshop-tracker/components/StepCommand.vue` — props:
`command` (string, required per PRD §8 example), reads `stepId` from the
current slide's frontmatter (fallback: slide index, per PRD §8's "Falls back
to the slide index if omitted"). Renders:
- The command in a `<code>` block with a **Copy** button (copies to
  clipboard via `navigator.clipboard.writeText`, then emits
  `participant:copy { stepId }`).
- A **Done** button, always visible even with no `command` prop (PRD §8:
  "some slides won't have a command; the Done button should still be
  available"), emitting `participant:done { stepId }`.
- Local visual state (idle/copied/done) driven by the socket's own ack /
  echo, not by a naive "clicked = done" — if the server round-trip is slow,
  the button should reflect pending state honestly rather than lying.

Register it as a global component so slide markdown can use it bare
(`<StepCommand ... />`) — follow how `create-theme/template/components/`
components get auto-registered (check `packages/slidev/node` component
auto-import mechanism, likely via `unplugin-vue-components` scanning
`components/` in themes/addons) rather than assuming; confirm in Step 2's
own verification (a slide using `<StepCommand>` renders without an explicit
import).

`packages/addon-workshop-tracker/components/JoinScreen.vue` (or similar) — a
name-entry gate shown before the deck content, per PRD §7 addon deliverable
list item 2. Simplest correct approach for M2: a full-screen overlay
component mounted via the addon's `setup/main.ts` (e.g. `app.component()` +
a small root-level teleport/overlay pattern), gating on "have we received a
`participant:join` ack yet" rather than gating actual slide rendering
(participants can still *see* synced slides before naming themselves, per
026 — M2 just also asks for a name and starts attaching step actions to it;
don't regress 026's ungated slide-follow behavior for the sake of this
gate). Persist the assigned `participantId` + name to `sessionStorage` now
even though full resume semantics are 030's job — cheap to do now, and 030
builds on it rather than introducing storage from scratch.

**Verify**: loading the demo deck prompts for a name once per browser
session; after naming, using Copy/Done on a `<StepCommand>`-bearing slide
updates that participant's state server-side (confirm via a temporary
`console.log` or the dashboard from Step 3).

### Step 3: Minimal instructor dashboard

Two options, pick the first unless it proves impractical:

1. **Serve a small static Vue/vanilla page from the sync server itself**
   (e.g. `packages/workshop-tracker-server/public/dashboard/index.html` +a
   bundled small JS file, served via `node:http` static handler or a tiny
   `serve-static`-style middleware) that connects to the same Socket.io
   server, joins the `dashboard` room, and renders `state:update` payloads
   into a table. Self-contained, no new package, no CORS complexity (same
   origin as the server).
2. A separate `packages/workshop-tracker-dashboard/` Vite/Vue app — more
   "proper" but adds a second dev server, second build, and cross-origin
   socket config for zero functional gain at this milestone's scope. Only
   go this route if the static-page option in (1) turns out too limiting
   once error-report thumbnails etc. land in 028 — re-evaluate then, don't
   pre-optimize now.

Minimal M2 dashboard contents (PRD §11, subset — counts and error feed are
028/029's job):
- Participant table: name, current step status (idle/copied/done for
  whichever `stepId` is currently active on the presenter's slide).
- Live counts: joined, done-this-step / total (both computable from
  `state:update`'s payload already).

**Verify**: with the demo deck open in 2+ participant windows (each joined
with a distinct name) and the dashboard open in a third window, clicking
Copy/Done in each participant window updates that participant's row on the
dashboard within ~1s, matching PRD §15's second and third acceptance
bullets.

## Test plan

- Extend (or create, if 026 skipped it) a `vitest` suite in
  `workshop-tracker-server` covering: `participant:join` assigns a stable id
  and the same name reconnecting with the same stored id doesn't create a
  duplicate participant row; `participant:copy`/`participant:done` update
  `stepStatus` and trigger a `state:update` broadcast.
- Manual: the 3-window walkthrough in Step 3's verification.

## Done criteria

- [ ] Frontmatter `stepId` passthrough confirmed working (Step 1)
- [ ] Server tracks participants and per-`(participantId, stepId)` status,
      broadcasting `state:update` to dashboard listeners only
- [ ] `<StepCommand>` renders, copies to clipboard, and both Copy/Done emit
      the right events with honest pending/confirmed visual state
- [ ] Join screen collects a name once per browser session without blocking
      026's ungated slide-follow behavior
- [ ] A working dashboard shows live participant + step-status updates
      within ~1s, no polling (PRD §11 last bullet)
- [ ] Demo deck (`demo/workshop-tracker/slides.md`) uses `<StepCommand>` on
      at least one real step, with `stepId` set
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build`, and the new vitest suite
      all pass
- [ ] Same documented-gap pattern as 026 applied to the dashboard (no auth
      yet — anyone who finds the URL can open it; flagged, not hidden)
- [ ] Only in-scope paths modified/added (`git status`)
- [ ] `plans/README.md` status row for 027 updated

## STOP conditions

Stop and report if:

- Frontmatter passthrough for a custom key like `stepId` doesn't reach the
  client the way `logic/slides.ts` suggests (e.g. it's stripped, or only
  works for known/reserved keys) — this is load-bearing for the whole
  `stepId` design in PRD §8 and needs a different approach (e.g. a dedicated
  addon-side frontmatter schema extension) rather than a workaround.
- Global component auto-registration for addon `components/` doesn't work
  the way theme templates suggest — falls back to requiring explicit
  `<script setup>` imports per slide, which changes PRD §8's authoring
  ergonomics; confirm which is actually true and report before assuming.
- `state:update` payload size/frequency at even small participant counts
  (dev-test with ~5-10 simulated clients) already shows visible lag —
  flag before 029/030 make it worse; the room-scoped broadcast in Step 1 is
  meant to prevent this but verify it actually is room-scoped and not
  accidentally global.

## Maintenance notes

- The dashboard's "static page served by the sync server" choice (Step 3,
  option 1) is deliberate for now — don't let 028/029 silently balloon it
  into a full SPA without re-reading the trade-off note above.
- `sessionStorage`-persisted `participantId` (Step 2) is a down payment on
  030's reconnect/resume work — when 030 lands, confirm it actually reads
  this same key rather than introducing a second identity mechanism.
