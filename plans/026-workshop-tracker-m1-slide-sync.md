# Plan 026: Workshop Tracker M1 — slide sync (addon + sync server skeleton)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result. If anything in "STOP
> conditions" occurs, stop and report. When done, update the status row in
> `plans/README.md`.
>
> **Source doc**: [`plans/prd-workshop-tracking.md`](./prd-workshop-tracking.md)
> §6, §7, §10, §13 (M1). This plan implements *only* the M1 slice: real-time
> slide sync from presenter to participants, with no participant identity,
> step-tracking, error reporting, presence, or auth yet — those are plans
> [027](./027-workshop-tracker-m2-step-tracking.md)–[030](./030-workshop-tracker-m5-hardening.md).

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED (new workspace packages, new runtime deps, first integration
  point between Slidev's client router and an external realtime server)
- **Depends on**: none
- **Category**: feature / new-package
- **Planned at**: commit `a8d8ff71`, 2026-08-26

## Why this matters

This is the foundation the whole PRD sits on (§13: "de-risks the Slidev
integration itself before layering on tracking"). Everything in M2–M5 —
participant identity, step status, error reports, presence, auth — is layered
on top of the same client↔server transport and the same addon package this
plan stands up. Getting the transport and the addon's hook into Slidev's
router right, with the least state possible, means M2 onward is additive
(new events, new UI) rather than re-architecture.

## Current state

- This repo (`packages/*`) is Slidev core itself, not a slide deck. Addons are
  standalone npm packages consumed via deck headmatter (`docs/guide/write-addon.md`);
  none exist in `packages/*` today (confirmed: no `slidev-addon-*` package in
  the workspace).
- `pnpm-workspace.yaml` packages glob is `packages/*`, `demo/*`,
  `cypress/fixtures/*`, `docs` — a new `packages/*` member and a new `demo/*`
  member are both picked up automatically, no workspace config changes needed.
- Addon/theme app-level hooks: `setup/main.ts` exporting
  `defineAppSetup(({ app, router }) => { ... })` (`@slidev/types`) — see
  `docs/custom/config-vue.md` and `packages/client/main.ts:1-13`. This runs
  **before** `app.mount()`, outside any component's setup context — Vue Router
  injection-based composables (`useNav()`, `useSlideContext()`) are not
  guaranteed to resolve correctly there since `useSlideContext` uses
  `inject()`; only the `router` object passed as an argument is safe to use.
- Route path format is fixed by `packages/client/logic/slidePath.ts:9`:
  `` presenter ? `/presenter/${no}` : `/${no}` `` (`no` is the slide's route
  alias or slide number). No other formats exist for normal navigation.
- Build tooling conventions (see `packages/parser/package.json`,
  root `package.json`): `tsdown` for library builds, `tsx` for running
  TypeScript directly in dev, `vitest` for tests, `pnpm -r --filter="./packages/**"` /
  `--filter="./demo/**"` for cross-package scripts. `pnpm-workspace.yaml` has
  `catalogMode: prefer` — prefer `catalog:*` versions for deps that are
  already catalogued; new deps this plan introduces (`socket.io`,
  `socket.io-client`) aren't in the catalog, so pin them as direct versions in
  the new packages' own `package.json` (do not touch the shared catalog in
  this plan — that's a separate decision for the maintainer if these become
  broadly used).
- Demo decks live under `demo/*` as their own small pnpm packages (see
  `demo/starter/package.json`) with a `dev` script that runs `slidev
  ./slides.md`.

## Commands you will need

| Purpose | Command | Expected |
|---------|---------|----------|
| Install after adding packages | `pnpm install` | resolves the two new workspace packages |
| Run the sync server | `pnpm --filter workshop-tracker-server dev` | logs `listening on :3710` (or chosen port) |
| Run the demo deck | `pnpm --filter slidev-demo-workshop-tracker dev` | Slidev dev server opens, deck loads |
| Typecheck | `pnpm typecheck` | passes (vue-tsc across the repo) |
| Lint | `pnpm lint` | passes |
| Build | `pnpm build` | new packages build via `tsdown` alongside existing ones |

## Scope

**In scope**:
- `packages/workshop-tracker-server/` — new private Node package: a Socket.io
  server holding one in-memory `{ currentSlideIndex }` and rebroadcasting
  slide changes.
- `packages/addon-workshop-tracker/` — new Slidev addon package
  (`slidev-addon-workshop-tracker`): a `setup/main.ts` that connects to the
  server and drives `router` navigation.
- `demo/workshop-tracker/` — a demo deck (a handful of slides) that uses the
  addon locally, for manual multi-device verification.
- `plans/README.md` — status row update (done at the end, per every plan).

**Out of scope** (explicitly deferred to later plans):
- Participant identity / join screen (027).
- `<StepCommand>`, step status, dashboard UI (027).
- Error reporting, screenshot upload (028).
- Presence, heartbeat, room/join codes, presenter auth (029).
- Reconnect/resume of *tracking* state, load testing (030) — note M1 still
  needs the connection itself to survive a refresh (see Step 3), just not
  richer resume semantics.

## Git workflow

- Branch: `feat/workshop-tracker-m1-slide-sync`.
- Conventional commits, e.g.:
  - `feat(workshop-tracker-server): scaffold socket.io sync server`
  - `feat(addon-workshop-tracker): scaffold addon, sync slide navigation`
  - `docs: add workshop-tracker demo deck`
- Do NOT push/PR unless instructed.

## Steps

### Step 1: Scaffold `packages/workshop-tracker-server/`

```
packages/workshop-tracker-server/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        # entrypoint: creates http server + Socket.io, starts listening
│   └── session.ts       # in-memory { currentSlideIndex } + get/set
└── README.md
```

`package.json` (name `workshop-tracker-server`, `"private": true` — this is
not published, it's the workshop operator's backend process):

```json
{
  "name": "workshop-tracker-server",
  "private": true,
  "type": "module",
  "version": "0.0.0",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsdown",
    "start": "node dist/index.mjs"
  },
  "dependencies": {
    "socket.io": "^4.8.0"
  },
  "devDependencies": {
    "tsx": "catalog:dev",
    "tsdown": "catalog:dev",
    "@types/node": "catalog:types"
  }
}
```

(Confirm the exact latest `socket.io` major/minor via `pnpm info socket.io
version` before pinning — use the resolved version, don't guess further.)

`src/session.ts` — the full M1 state model (§9 gives the eventual `Session`
shape; M1 only needs `currentSlideIndex`):

```ts
export interface WorkshopSession {
  id: string
  currentSlideIndex: number
  createdAt: number
}

// Singleton in-memory session (multi-session is out of scope — PRD §14/§4).
export const session: WorkshopSession = {
  id: 'default',
  currentSlideIndex: 1,
  createdAt: Date.now(),
}
```

`src/index.ts` — server + the two M1 events from PRD §10:

```ts
import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { session } from './session'

const PORT = Number(process.env.PORT ?? 3710)

const httpServer = createServer()
const io = new Server(httpServer, {
  cors: { origin: process.env.WORKSHOP_TRACKER_ORIGIN ?? '*' },
})

io.on('connection', (socket) => {
  // Sync the newly-connected client to current state immediately — needed
  // for M1's own acceptance bar (a participant who loads *after* the
  // presenter has already moved past slide 1 must still land on the right
  // slide). This event isn't in PRD §10's list; it's the minimum addition
  // needed to make `slide:changed` (a rebroadcast-only event) useful to
  // late joiners, and is a deliberate, documented addition — not scope creep.
  socket.emit('slide:sync', { index: session.currentSlideIndex })

  socket.on('presenter:setSlide', ({ index }: { index: number }) => {
    // NOTE(security): M1 has no auth — any connected socket can emit this and
    // move everyone's slide. That's an accepted, explicitly-tracked gap; plan
    // 029 (M4) adds a join code that gates who's allowed to be "the
    // presenter". Do not treat this as done/secure before 029 lands.
    session.currentSlideIndex = index
    io.emit('slide:changed', { index })
  })

  socket.on('disconnect', () => {})
})

httpServer.listen(PORT, () => {
  console.log(`workshop-tracker-server listening on :${PORT}`)
})
```

**Verify**: `pnpm --filter workshop-tracker-server dev` starts and logs the
listening line; `curl -i http://localhost:3710/socket.io/` returns a
Socket.io handshake response (not a connection error).

### Step 2: Scaffold `packages/addon-workshop-tracker/`

```
packages/addon-workshop-tracker/
├── package.json
├── setup/
│   └── main.ts
├── src/
│   └── client.ts   # thin socket.io-client wrapper, server URL resolution
└── README.md
```

`package.json` — follow the addon conventions from
`docs/guide/write-addon.md` (name prefix `slidev-addon-`, `keywords` include
`slidev-addon` and `slidev`):

```json
{
  "name": "slidev-addon-workshop-tracker",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "keywords": ["slidev-addon", "slidev"],
  "dependencies": {
    "socket.io-client": "^4.8.0"
  },
  "devDependencies": {
    "@slidev/types": "workspace:*",
    "vue": "catalog:frontend",
    "vue-router": "catalog:frontend"
  }
}
```

`src/client.ts` — resolve the server URL from an env var (simplest option for
M1; revisit headmatter-driven config later if operators need per-deck
override without env vars — not needed to hit M1's acceptance bar):

```ts
import { io, type Socket } from 'socket.io-client'

export function createWorkshopSocket(): Socket {
  const url = import.meta.env.VITE_WORKSHOP_TRACKER_SERVER_URL ?? 'http://localhost:3710'
  return io(url, { autoConnect: true, reconnection: true })
}
```

`setup/main.ts` — the router-driven sync, per `defineAppSetup(({ app, router
}) => ...)`. **Do not** use `useNav()`/`useSlideContext()` here (see "Current
state" above on injection-context risk) — parse the route path directly,
matching `slidePath.ts`'s own format:

```ts
import { defineAppSetup } from '@slidev/types'
import { createWorkshopSocket } from '../src/client'

const SLIDE_PATH_RE = /^\/(?:presenter\/)?(\d+)/

function slideNoFromPath(path: string): number | undefined {
  const m = SLIDE_PATH_RE.exec(path)
  return m ? Number(m[1]) : undefined
}

function isPresenterPath(path: string): boolean {
  return path.startsWith('/presenter/')
}

export default defineAppSetup(({ router }) => {
  const socket = createWorkshopSocket()
  let applyingRemoteChange = false

  socket.on('slide:sync', ({ index }: { index: number }) => {
    if (!isPresenterPath(router.currentRoute.value.path))
      navigateTo(index)
  })

  socket.on('slide:changed', ({ index }: { index: number }) => {
    if (!isPresenterPath(router.currentRoute.value.path))
      navigateTo(index)
  })

  function navigateTo(index: number) {
    applyingRemoteChange = true
    router.push(`/${index}`).finally(() => { applyingRemoteChange = false })
  }

  router.afterEach((to) => {
    if (applyingRemoteChange || !isPresenterPath(to.path))
      return
    const index = slideNoFromPath(to.path)
    if (index != null)
      socket.emit('presenter:setSlide', { index })
  })
})
```

**Verify**: with `pnpm typecheck`, this file resolves `@slidev/types`'
`defineAppSetup` signature without error.

### Step 3: Scaffold `demo/workshop-tracker/` and validate multi-device

```
demo/workshop-tracker/
├── package.json
├── slides.md
```

`slides.md` headmatter loads the addon locally (per
`docs/guide/theme-addon.md`'s "Use an Addon" — local path form):

```md
---
theme: default
addons:
  - ../../packages/addon-workshop-tracker
---

# Workshop Tracker — M1 slide-sync demo

---

# Slide 2

---

# Slide 3
```

`package.json` mirrors `demo/starter/package.json`'s shape (name
`slidev-demo-workshop-tracker`, `private: true`, `dev` script running
`slidev ./slides.md`).

**Verify (manual, two browser windows/devices on the same LAN)**:
1. `pnpm --filter workshop-tracker-server dev` in one terminal.
2. `pnpm --filter slidev-demo-workshop-tracker dev -- --open=false` in
   another; note the printed network URL (not just `localhost`) if testing
   from a second device.
3. Open the deck in two browser windows. In window A, open `/presenter/1`
   (presenter route). In window B, open `/1` as a plain participant.
4. In window A, advance to slide 2/3 (arrow keys or on-screen controls).
   **Expected**: window B follows within ~1s, without a manual refresh —
   this is M1's acceptance criterion (PRD §15, first bullet).
5. Reload window B mid-session. **Expected**: it reconnects and lands on
   whatever slide the presenter is currently on (via the `slide:sync` event
   sent on connect), not slide 1.
6. Confirm window B navigating on its own does **not** move window A (only
   the presenter route drives the broadcast).

## Test plan

- No unit-test framework needed for the server's ~30 lines of glue in M1;
  the manual two-window walkthrough above is the acceptance test, matching
  this plan's own scope (thin skeleton, not business logic).
- If time permits, add a `vitest` test in `workshop-tracker-server` asserting
  that emitting `presenter:setSlide` on one connected client socket causes a
  second connected client socket to receive `slide:changed` with the same
  index (a real `socket.io-client` pair talking to an in-process server on an
  ephemeral port). Not required to close this plan, but leave the harness in
  place for 027+ to extend rather than starting from scratch.

## Done criteria

- [ ] `packages/workshop-tracker-server/` exists, builds, and its `dev`
      script starts a listening Socket.io server
- [ ] `packages/addon-workshop-tracker/` exists, is a valid local Slidev
      addon (loads via `addons: [../../packages/addon-workshop-tracker]`)
- [ ] `demo/workshop-tracker/` deck loads with the addon active
- [ ] Manual two-window verification (Step 3) passes: presenter slide change
      reaches the participant window within ~1s, and a late/reloaded
      participant lands on the current slide rather than slide 1
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm build` all pass repo-wide
- [ ] The M1 security gap (no presenter auth — anyone can emit
      `presenter:setSlide`) is documented in the new packages' READMEs, not
      silently shipped
- [ ] Only in-scope paths modified/added (`git status`)
- [ ] `plans/README.md` status row for 026 updated

## STOP conditions

Stop and report if:

- `defineAppSetup`'s `router` argument turns out **not** to be a live,
  navigable `vue-router` `Router` instance at the point `setup/main.ts` runs
  (e.g. if it's a snapshot, or navigation before `app.mount()` throws) — that
  invalidates this plan's core mechanism and needs a different integration
  point (e.g. a mounted component using `onMounted` + `useRouter()` instead).
  Confirm this works in Step 2's verification before building further on it.
- The local-path addon form (`addons: [../../packages/addon-workshop-tracker]`)
  doesn't resolve from a `demo/*` deck the way it does from an arbitrary
  external deck (path resolution could differ inside the monorepo/workspace
  vs. a real user project) — report and adjust (e.g. `workspace:*` +
  published-shape resolution) rather than silently hacking around it.
- Socket.io's default CORS/handshake behavior is blocked by the workshop
  network's setup in a way that isn't just "set `WORKSHOP_TRACKER_ORIGIN`" —
  flag before spending time on transport-level workarounds.

## Maintenance notes

- The `slide:sync`-on-connect event and the "no auth yet" gap are both
  deliberate, load-bearing decisions for this plan — don't let a later plan
  quietly remove/forget either without updating this file's status.
- Reviewer: confirm `setup/main.ts` never calls `router.push` in a loop (the
  `applyingRemoteChange` guard exists specifically to prevent a
  participant's remote-driven navigation from re-triggering
  `presenter:setSlide`, which would only matter if that participant is ever
  on the presenter route, but keep the guard regardless — cheap and removes
  a whole class of feedback-loop bugs before 027+ adds more traffic on the
  same socket).
