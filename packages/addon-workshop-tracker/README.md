# slidev-addon-workshop-tracker

A Slidev addon that syncs the presenter's current slide to every connected
participant in real time, lets participants identify themselves and
acknowledge hands-on steps, and (as of M4) reports each participant's
presence and gates presenter/dashboard actions behind a credential, over the
companion [`workshop-tracker-server`](../workshop-tracker-server). Currently
implements **M1 (slide sync), M2 (participant identity + step tracking), and
M4 (presence + auth)** — error reporting (M3) is still ahead. See
[`plans/026-workshop-tracker-m1-slide-sync.md`](../../plans/026-workshop-tracker-m1-slide-sync.md),
[`plans/027-workshop-tracker-m2-step-tracking.md`](../../plans/027-workshop-tracker-m2-step-tracking.md),
[`plans/029-workshop-tracker-m4-presence-auth.md`](../../plans/029-workshop-tracker-m4-presence-auth.md),
and [`plans/prd-workshop-tracking.md`](../../plans/prd-workshop-tracking.md).

## Usage

Add it to a deck's headmatter. The docs' local-path form
([`docs/guide/theme-addon.md`](../../docs/guide/theme-addon.md)) —
`addons: [../../packages/addon-workshop-tracker]` — does **not** work from
inside this monorepo; see "Known issue: local relative-path resolution"
below. Use a `workspace:*` devDependency + plain package name instead (see
[`demo/workshop-tracker`](../../demo/workshop-tracker) for the working
example):

```json
// package.json
{
  "devDependencies": {
    "slidev-addon-workshop-tracker": "workspace:*"
  }
}
```

```md
---
theme: default
addons:
  - slidev-addon-workshop-tracker
---
```

(A deck outside this monorepo, consuming the addon as a real published or
`file:`-linked dependency, is unaffected — see below.)

Then run the sync server (`pnpm --filter workshop-tracker-server dev`,
configured with `WORKSHOP_ROOM_CODE`/`WORKSHOP_PRESENTER_CODE` — see that
package's README) alongside the Slidev dev server. By default the addon
connects to `http://localhost:3710`; override with
`VITE_WORKSHOP_TRACKER_SERVER_URL`.

**Presenter code**: load the presenter's own window with
`?presenterCode=<the WORKSHOP_PRESENTER_CODE value>` appended to the URL
(e.g. `http://localhost:3030/presenter/1?presenterCode=...`) — see "Auth"
below for why it has to be supplied this way rather than any config file.
**Room code**: participants type it into the join screen alongside their
name (no URL param needed, though `JoinScreen.vue`'s stored
`sessionStorage` value means it's only typed once per browser tab).

## How it works

`setup/main.ts` exports a `defineAppSetup(({ router }) => ...)` (see
[`@slidev/types`](../types)) that:

- Connects a `socket.io-client` socket to the sync server.
- On `slide:sync` (sent once, right after connecting) or `slide:changed`
  (sent on every presenter navigation), navigates a non-presenter route to
  the new slide via `router.push` — but only after `await router.isReady()`,
  so it reads the router's _real_ initial route rather than a possibly
  unresolved default. Skipping this let a fast (near-instant, e.g.
  localhost) socket connection force-navigate the presenter's own window
  away from `/presenter/:no` right after load — caught during plan 026's
  manual verification.
- On every `router.afterEach` navigation that lands on a `/presenter/:no`
  route, emits `presenter:setSlide { index }` to the server — this is what
  drives the broadcast to everyone else. Registered synchronously (_not_
  behind `router.isReady()`, unlike the socket handlers) so it doesn't miss
  the router's own first (initial) navigation — a presenter loading straight
  into `/presenter/N` (N != 1) depends on that first `afterEach` cycle to
  report N to the server at all.

This runs before `app.mount()`, outside any component's setup context —
`useNav()` / `useSlideContext()` are not used here since they rely on
`inject()`, which isn't guaranteed to resolve correctly at this point. Only
the `router` instance passed into `defineAppSetup` is used, matching
`packages/slidev/node/virtual/setups.ts`'s `{ app, router }` context contract
(the router is already a live, installed `vue-router` `Router` — `app.use(router)`
runs before any addon's `setup/main.ts` executes).

## M2: components and Global Layers

- **`<StepCommand command="...">`** (`components/StepCommand.vue`) — a
  global component, auto-registered from this addon's `components/`
  directory the same way theme components are (`packages/slidev/node/vite/components.ts`'s
  `dirs` includes `roots.map(i => join(i, 'components'))`, and `roots`
  includes addon roots) — confirmed by using it bare in
  `demo/workshop-tracker/slides.md` with no explicit import. `command` is
  optional; the Done button is always available (PRD §8). Reads the active
  step's key via `resolveStepId` (`src/stepId.ts`): the slide's `stepId`
  frontmatter, falling back to the slide index. Button visual state
  (`src/stepCommandStatus.ts`, unit tested) only confirms Copy/Done once the
  server acks — not an optimistic "clicked = done".
- **`<JoinScreen>`** (`components/JoinScreen.vue`) — a full-screen name-entry
  overlay, gated on "have we received a `participant:join` ack yet", not on
  slide rendering. Persists `{ participantId, name }` to `sessionStorage` so
  a same-tab reload rejoins as the same participant.
- **`<StepReporter>`** (`components/StepReporter.vue`) — renders nothing;
  reports the presenter's current `stepId` to the server (`presenter:setStep`,
  including the presenter credential — see "Auth" below). See "Real gap
  found during M2" below for why this exists as its own component rather
  than living in `setup/main.ts` alongside `presenter:setSlide`.
- **`<PresenceReporter>`** (`components/PresenceReporter.vue`, plan 029
  Step 2) — renders nothing; reports this participant's
  `participant:visibility` on `visibilitychange` and a
  `participant:heartbeat` every 5s (kept in sync with the server's
  `HEARTBEAT_INTERVAL_MS` — see that component's own comment). Gated on
  `!isPresenter`, same as `<JoinScreen>`.

`<JoinScreen>`, `<StepReporter>`, and `<PresenceReporter>` are all mounted
via [`global-top.vue`](./global-top.vue) — Slidev's documented **Global
Layers** extension point (<https://sli.dev/features/global-layers>,
`packages/slidev/node/virtual/global-layers.ts`): a `global-top.{ts,js,vue}`
file at an addon/theme root is auto-rendered once, persisting across every
slide, with full injection context (`useNav()` works). This is the
mechanism for "a component that's always mounted" — deliberately _not_ the
plan's originally-sketched "`app.component()` + a small root-level
teleport/overlay pattern in `setup/main.ts`", because `setup/main.ts` runs
pre-`app.mount()` outside any component's setup context (see below).

## Real gap found during M2: `setup/main.ts` can't reliably read slide frontmatter

Plan 027 Step 1 asked to empirically confirm frontmatter passthrough
"inside an actual component's setup()" before relying on it further — doing
that surfaced a genuine bug in the milestone's own original design, not
just a hypothetical risk. `useNav().currentFrontmatter` (used inside real
components — `StepCommand.vue`, `StepReporter.vue`) reads
`stepId` correctly. But the plan's original sketch had `setup/main.ts`'s
`router.afterEach` read `to.meta.slide.frontmatter` directly off the
resolved route object to report `stepId` alongside `presenter:setSlide` —
and that was empirically `undefined` at the moment `afterEach` fires, even
though the _same_ slide's frontmatter was correctly populated a moment
later via `useNav()`.

Root cause: `currentSlideRoute` (and therefore `currentFrontmatter`) is
computed from the **reactive `slides` array**
(`packages/client/composables/useNav.ts`:
`currentSlideRoute = computed(() => slides.value[currentSlideNo.value - 1])`),
not from the vue-router route object itself — `to.meta.slide` in
`router.afterEach` is a different, less-reliably-populated-at-that-moment
object. `setup/main.ts` can safely read `to.path` (a plain string,
immediately correct — that's what `presenter:setSlide`'s `index` still uses)
but not `to.meta.slide.frontmatter`.

Fix: `stepId` reporting was pulled out into its own component
(`StepReporter.vue`, a real mounted component using `useNav()`) and its own
server event (`presenter:setStep`, separate from `presenter:setSlide`) — see
`workshop-tracker-server`'s README for the server-side half. Don't
reintroduce frontmatter reads in `setup/main.ts`; use a mounted component
(via Global Layers or a slide-scoped component) instead.

## Known issue: local relative-path addon resolution (core Slidev, not this addon)

Slidev's `resolveAddons()` (`packages/slidev/node/integrations/addons.ts`)
resolves a relative addon path (`name[0] === '.'`) via
`resolve(dirname(importer), name)` in `createResolver` (`resolver.ts`), but
passes `userRoot` — already a _directory_ — as `importer`, not the deck
_file_. `dirname()` on an already-a-directory path strips one directory
level too many, so a relative addon path resolves one level higher than
intended. `resolveTheme` doesn't have this bug — its callers pass `entry`
(the deck file) as `importer`, not `userRoot`. This is a pre-existing latent
bug in Slidev core (reproducible with e.g. the docs' own `addons: [./]`
self-preview pattern once you're more than one path segment away from where
its math assumes), out of scope to fix in this addon/plan — this addon works
around it by resolving via workspace package name instead (see "Usage"
above), which goes through the (correctly working) non-relative
`findPkgRoot` resolution branch.

## Known interaction: Slidev's own built-in nav sync

Slidev's core already ships a **bidirectional** slide-navigation sync
(`packages/client/setup/root.ts`, via `vite-plugin-vue-server-ref`) that's
**on by default** in `slidev dev` (`syncDirections` in
`packages/client/state/storage.ts`, all four directions default `true`,
persisted per-browser in `localStorage['slidev-sync-directions']`). This
syncs _any_ connected client's page/clicks to _any other_ — including a
participant's own navigation moving the presenter's window — independent of
this addon entirely. During plan 026's manual verification this looked like
a bug in this addon (a participant window's own `Left`/`Right` navigation
appeared to drag the presenter along) until isolated by disabling
`syncDirections` via `localStorage`, which confirmed this addon's own
socket-based mechanism is correctly one-way (only a `/presenter/:no` route
broadcasts). With Slidev's built-in sync at its default (all four directions
on), the two mechanisms compound: a participant can _also_ move the
presenter through Slidev's own native channel, on top of the security gap
below. Worth a decision in a later plan — e.g. this addon forcing
`syncDirections` to presenter-only-send once a `workshop-tracker` server is
in play — but out of scope for M1.

## Auth (plan 029 / PRD §12)

`presenter:setSlide`/`presenter:setStep` now require a `presenterCode`,
verified server-side (`workshop-tracker-server`'s `src/auth.ts`); a
participant's browser navigating to a `/presenter/:no` route without it has
those events silently rejected, so it can no longer move/relabel everyone
else's slide and step. `participant:join` now similarly requires a
`roomCode`.

**Why the presenter code is read from the URL (`src/presenterCode.ts`), not
a build-time env var**: Slidev builds one JS bundle per deck, served to
every route (`/N` and `/presenter/N` alike) — there's no separate
"presenter bundle" to embed a secret into. Anything baked in via
`import.meta.env` at build time would ship to every participant's browser
too, which is exactly the failure mode plan 029's STOP condition rules out
("naively embedded in a public bundle"). Reading `?presenterCode=` from
`window.location.search` instead means the value only ever exists in the
one browser tab whose URL the instructor set it on — never in the shipped
bundle.

The `/dashboard` route (served by `workshop-tracker-server`) is gated the
same way, at the HTTP layer — see that package's own README for the full
picture (including the honestly-scoped threat model: this is
LAN-workshop-appropriate auth, not brute-force/rate-limit-hardened
SaaS-grade auth). Do not point a real workshop room at this stack without
setting both `WORKSHOP_ROOM_CODE` and `WORKSHOP_PRESENTER_CODE` on the
server — an unset code means the server rejects every join/presenter
action/dashboard connection outright (fail closed).
