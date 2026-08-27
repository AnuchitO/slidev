# slidev-addon-muan-companion

A Slidev addon that syncs the presenter's current slide to every connected
participant in real time, lets participants identify themselves and
acknowledge hands-on steps, report an error — text and/or a captured
screenshot — reports each participant's presence, gates presenter/dashboard
actions behind a credential, and resumes a participant's own identity across
a refresh or brief network drop, over the companion
[`muan-companion-server`](../muan-companion-server). Implements the full
initiative — **M1 (slide sync), M2 (participant identity + step tracking),
M3 (error reporting), M4 (presence + auth), and M5 (reconnect/resume +
load-tested hardening)**. See
[`plans/026-workshop-tracker-m1-slide-sync.md`](../../plans/026-workshop-tracker-m1-slide-sync.md),
[`plans/027-workshop-tracker-m2-step-tracking.md`](../../plans/027-workshop-tracker-m2-step-tracking.md),
[`plans/028-workshop-tracker-m3-error-reporting.md`](../../plans/028-workshop-tracker-m3-error-reporting.md),
[`plans/029-workshop-tracker-m4-presence-auth.md`](../../plans/029-workshop-tracker-m4-presence-auth.md),
[`plans/030-workshop-tracker-m5-hardening.md`](../../plans/030-workshop-tracker-m5-hardening.md),
and [`plans/prd-workshop-tracking.md`](../../plans/prd-workshop-tracking.md).

## Usage

Add it to a deck's headmatter. The docs' local-path form
([`docs/guide/theme-addon.md`](../../docs/guide/theme-addon.md)) —
`addons: [../../packages/addon-muan-companion]` — does **not** work from
inside this monorepo; see "Known issue: local relative-path resolution"
below. Use a `workspace:*` devDependency + plain package name instead (see
[`demo/muan-companion`](../../demo/muan-companion) for the working
example):

```json
// package.json
{
  "devDependencies": {
    "slidev-addon-muan-companion": "workspace:*"
  }
}
```

```md
---
theme: default
addons:
  - slidev-addon-muan-companion
---
```

(A deck outside this monorepo, consuming the addon as a real published or
`file:`-linked dependency, is unaffected — see below.)

Then run the sync server (`pnpm --filter muan-companion-server dev`,
configured with `MUAN_COMPANION_ROOM_CODE`/`MUAN_COMPANION_PRESENTER_CODE` — see that
package's README) alongside the Slidev dev server. By default the addon
connects to `http://localhost:3710`; override with
`VITE_MUAN_COMPANION_SERVER_URL`.

**Presenter code**: load the presenter's own window with
`?presenterCode=<the MUAN_COMPANION_PRESENTER_CODE value>` appended to the URL
(e.g. `http://localhost:3030/presenter/1?presenterCode=...`) — see "Auth"
below for why it has to be supplied this way rather than any config file.
**Room code**: participants type it into the join screen alongside their
name (no URL param needed, though `JoinScreen.vue`'s stored `localStorage`
value means it's only typed once per browser — resuming across a closed
tab, and even a restarted browser, not just a same-tab reload).

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
  `demo/muan-companion/slides.md` with no explicit import. `command` is
  optional; the Done button is always available (PRD §8). Reads the active
  step's key via `resolveStepId` (`src/stepId.ts`): the slide's `stepId`
  frontmatter, falling back to the slide index. Button visual state
  (`src/stepCommandStatus.ts`, unit tested) only confirms Copy/Done once the
  server acks — not an optimistic "clicked = done".
- **`<JoinScreen>`** (`components/JoinScreen.vue`) — a full-screen name-entry
  overlay, gated on "have we received a `participant:join` ack yet", not on
  slide rendering. Persists `{ participantId, name }` to `localStorage` so a
  reload — same tab, or a closed-and-reopened tab — rejoins as the same
  participant without re-prompting. The room code is deliberately **not**
  part of what's persisted (see "Real gap found: room code no longer needs
  to be stored client-side" below) — a resume of an already-known identity
  doesn't need it at all.
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

- **`<ErrorReportWidget>`** (`components/ErrorReportWidget.vue`, plan 028) —
  a small floating "⚠️ Report a problem" button (bottom-right, every slide)
  that expands into a form: a text box (always available, the required
  PRD §10/§12 fallback) and a "Capture screen" button shown only when
  `canCaptureScreen` (`src/errorReportCapability.ts`, unit tested) is
  true — explicit feature detection (`navigator.mediaDevices?.getDisplayMedia`
  exists **and** the origin is `https:` or `localhost`), not
  try/catch-and-hope, so a participant on a browser/context lacking the API
  never sees a button that would only fail when clicked. Capture uses the
  standard "one `<video>` frame → `<canvas>` → `Blob`" technique and stops
  every track immediately after grabbing the frame (so the browser's
  "sharing your screen" indicator disappears right away, not only once the
  form is submitted). Submission is exactly one of two paths, matching the
  server's split responsibility (see the server's README):
  - A captured screenshot → `POST /api/screenshot` (REST, multipart body
    built by `src/errorReportSubmission.ts`, unit tested).
  - Text-only → the WS `participant:error { stepId, text }` event on the
    same shared socket `<StepCommand>` uses.

  Reads the current participant from `src/participantIdentity.ts`'s shared
  `currentParticipant` ref (a module-scope singleton, same pattern as
  `client.ts`'s shared socket) — `<JoinScreen>` sets it on a successful
  `participant:join` ack; both components now read/write participant
  identity through this one module instead of each keeping its own copy
  (a small refactor `JoinScreen.vue` picked up alongside this widget, see
  that file's own comment). Hidden on the presenter route
  (`useNav().isPresenter`) — error reporting is a participant action.

`<JoinScreen>`, `<StepReporter>`, `<ErrorReportWidget>`, and
`<PresenceReporter>` are all mounted via [`global-top.vue`](./global-top.vue)
— Slidev's documented **Global Layers** extension point
(<https://sli.dev/features/global-layers>,
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
`muan-companion-server`'s README for the server-side half. Don't
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
`syncDirections` to presenter-only-send once a `muan-companion` server is
in play — but out of scope for M1.

## Auth (plan 029 / PRD §12)

`presenter:setSlide`/`presenter:setStep` now require a `presenterCode`,
verified server-side (`muan-companion-server`'s `src/auth.ts`); a
participant's browser navigating to a `/presenter/:no` route without it has
those events silently rejected, so it can no longer move/relabel everyone
else's slide and step. `participant:join` now similarly requires a
`roomCode` for a fresh join — **not** for a resume of an already-known
identity, a later follow-up fix; see "M5: reconnect/resume" below.

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

The `/dashboard` route (served by `muan-companion-server`) is gated the
same way, at the HTTP layer — see that package's own README for the full
picture (including the honestly-scoped threat model: this is
LAN-workshop-appropriate auth, not brute-force/rate-limit-hardened
SaaS-grade auth). Do not point a real workshop room at this stack without
setting both `MUAN_COMPANION_ROOM_CODE` and `MUAN_COMPANION_PRESENTER_CODE` on the
server — an unset code means the server rejects every join/presenter
action/dashboard connection outright (fail closed).

## M5: reconnect/resume (plan 030 / PRD §12)

`<JoinScreen>` now consumes the `participantId` it already persisted to
`localStorage` (027's down payment; switched from `sessionStorage` in a
follow-on fix — see below): on mount, if one is stored, it emits
`participant:join` with it immediately and shows a lightweight "Resuming
your session…" message instead of the name/room-code form — a refreshing
participant never sees a join prompt, matching PRD §12's "without
re-joining as a 'new' participant." The server's ack now carries a
`resumed: boolean` (see `muan-companion-server`'s README) — the
authoritative signal for whether that specific resume succeeded, rather
than the client comparing ids itself (`resolveJoinAckOutcome`,
`src/participantIdentity.ts`, unit tested).

**Resume-hijacking threat model**: a resumed identity is bound to the
specific `participantId` itself — a 122-bit `crypto.randomUUID()` minted at
original join time that is _never_ broadcast to other participant sockets
(only to the presenter-code-gated dashboard room). That alone functions as
an unguessable bearer resume token scoped to one browser's `localStorage`,
satisfying plan 030's STOP condition on resume hijacking without needing a
separate token scheme. (Originally the room code was _also_ required on
every resume, "two things an attacker can't cheaply obtain together" — a
later follow-up fix dropped that: the room code isn't participant-specific
secret information, every participant in the session already knows it, so
requiring it again on resume added no real protection against hijacking on
top of the id alone, while forcing it to be persisted client-side
indefinitely for no corresponding benefit. See "Follow-on fix: room code no
longer stored client-side" below.)

### Follow-on fix: `sessionStorage` → `localStorage` (closed-tab resume)

A real muan-companion bug report: a participant who closed and reopened
their tab (same browser, same device — not a same-tab refresh) was treated
as brand new, losing their step-status history and showing as a duplicate
row on the dashboard. Root cause: `sessionStorage` is scoped to a single
browser tab and is cleared the instant that tab closes, so a reopened tab
had nothing to read on mount.

Fix: `participantIdentity.ts` now persists to `localStorage` instead —
same-origin, not tab-scoped, so it survives a closed tab (and even a
restarted browser) until explicitly cleared. The resume-hijacking threat
model above is otherwise unaffected; only the storage backend and its
retention duration changed.

**New consequence, and its mitigation**: unlike `sessionStorage`,
`localStorage` doesn't clear itself when a tab closes, so the _same physical
browser_ used later by a different person (a shared/kiosk laptop at the
workshop) would otherwise silently inherit the previous participant's
identity, with no way to say "that's not me." `<JoinScreen>` now shows a
small, low-key "Not you? Join as someone else" button after a successful
resume (bottom-left, subdued — distinct from `<ErrorReportWidget>`'s
bottom-right button) that calls `clearStoredParticipant()` and re-shows the
join form blank. Whether to offer it is decided by the pure function
`shouldOfferJoinAsSomeoneElse` (`src/participantIdentity.ts`, unit tested,
same pattern as `resolveJoinAckOutcome`) — true only for a genuine resume of
an already-known identity, never for a name/room-code just typed for the
first time. The default resume path (same person, same tab or a reopened
one) is unchanged and stays exactly as fast as before this fix.

**When resume fails** (the server no longer recognizes the stored id — e.g.
it restarted mid-workshop, PRD §4/§14's accepted in-memory-reset case), the
join form reappears, pre-filled with the same name so the participant
doesn't have to retype that much, rather than silently minting a "new"
participant behind an unchanged UI. It does _not_ pre-fill a room code
(there isn't one stored — see below) — the participant types it once, the
same as a first-ever join.

### Follow-on fix: room code no longer stored client-side

Raised in review, not a live-use bug report like the others in this section:
persisting the room code in `localStorage` indefinitely (see the
`sessionStorage` → `localStorage` fix above) is unnecessary standing
exposure — it's a workshop-scoped code, not something that needs to outlive
the session on a participant's machine, and (per the threat-model note
above) it wasn't buying any real protection against resume hijacking either.

Fix: `participantIdentity.ts`'s `StoredParticipant` no longer has a
`roomCode` field at all, and `server.ts`'s `participant:join` handler
exempts a resume of an already-known `participantId` from the room-code gate
entirely (see `muan-companion-server`'s README for the server-side
reasoning). The auto-resume call in `<JoinScreen>`'s `onMounted` sends no
room code — it doesn't need one for the common case (same person, this
session) to keep working exactly as before.

The one behavior change is in the _rare_ case: if that auto-resume attempt
gets rejected (the server doesn't recognize the id — e.g. it restarted),
that now looks, on the wire, identical to a plain missing-room-code
rejection. Showing "that room code was not accepted" here would be wrong —
the participant never typed a code, right or wrong. `<JoinScreen>`'s `join()`
tracks whether the in-flight attempt was this silent auto-resume
(`wasAutoResuming`) and, if so, clears the dead id and falls through to the
ordinary join form instead of the error message — the same outcome as
before this fix, just without a room code to pre-fill.

### Real gap found during M5: a failed resume was orphaning a "ghost" participant

`session.ts`'s fallback behavior (a resume attempt against an unknown id
mints a fresh participant, so the _server_ side is always immediately
usable) combined with the client's above decision to _reject_ that fallback
and re-prompt uncovered a real bug during plan 030's own manual
server-restart verification, not a hypothetical: the client's first attempt
was discarding the fallback's newly-minted id entirely and, on the
participant's next click of "Join," asking the server for a **third**
identity — orphaning the fallback's second one. That orphan can never be
cleaned up: at the time this was found, it shared its (singular, pre-follow-
up-fix) `socketId` with the socket that goes on to become the _real_ (third)
participant, so `sweepStaleParticipants`'s "is this socket still connected"
check (`muan-companion-server`'s `presence.ts`) kept finding it alive
forever, and a clean `disconnect` only updated whichever participant
`socket.data.participantId` currently pointed at (the real one) — the
dashboard would show a permanent, un-closeable duplicate row for the rest of
the session. (`socketId` later became `socketIds`, plural, for an unrelated
follow-up fix — see this server's README on multi-tab presence — but the
underlying orphaning mechanism described here is the same either way.)

Fix: `JoinScreen.vue` now remembers the fallback ack's own `participantId`
(`pendingParticipantId`) and resumes _that_ id on the next submit instead of
requesting a fresh one — confirmed live (two-tab + real server-restart
walkthrough) to end with exactly one dashboard row, and the server's own
distinct log lines show the sequence as `resume failed for unknown
participantId ... falling back to a fresh join as ...` immediately followed
by `participant resumed: ...` for that same newly-minted id. Don't
reintroduce a plain "just call `join()` again with no id" retry path here
without re-reading this note.
