# slidev-addon-workshop-tracker

A Slidev addon that syncs the presenter's current slide to every connected
participant in real time, over the companion
[`workshop-tracker-server`](../workshop-tracker-server). This is **M1 of the
workshop-tracking initiative** — slide sync only, no participant identity,
step tracking, error reporting, presence, or auth yet. See
[`plans/026-workshop-tracker-m1-slide-sync.md`](../../plans/026-workshop-tracker-m1-slide-sync.md)
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

Then run the sync server (`pnpm --filter workshop-tracker-server dev`)
alongside the Slidev dev server. By default the addon connects to
`http://localhost:3710`; override with `VITE_WORKSHOP_TRACKER_SERVER_URL`.

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

## Known security gap (by design, until plan 029)

**Any connected client can act as "the presenter."** There is no
authentication in M1 — a participant's browser navigating to a
`/presenter/:no` route will emit `presenter:setSlide` just like the real
instructor's would, moving everyone else's slide. This is an accepted,
explicitly-tracked gap; plan
[029](../../plans/029-workshop-tracker-m4-presence-auth.md) (M4) adds a join
code that gates who's allowed to be "the presenter." Do not treat this addon
as workshop-ready before 029 lands.
