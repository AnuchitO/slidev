# workshop-tracker-server

Realtime sync server for [`slidev-addon-workshop-tracker`](../addon-workshop-tracker).
This is **M1 of the workshop-tracking initiative**: it holds one in-memory
`{ currentSlideIndex }` session and rebroadcasts slide changes to every
connected client over Socket.io. See
[`plans/026-workshop-tracker-m1-slide-sync.md`](../../plans/026-workshop-tracker-m1-slide-sync.md)
and [`plans/prd-workshop-tracking.md`](../../plans/prd-workshop-tracking.md)
for the full scope and roadmap (M2–M5).

This package is **private** — it's not published, it's the workshop
operator's own backend process, run alongside the Slidev dev server for the
duration of a workshop.

## Usage

```bash
pnpm --filter workshop-tracker-server dev
```

Starts an HTTP + Socket.io server listening on `:3710` (override with the
`PORT` env var). `WORKSHOP_TRACKER_ORIGIN` sets the CORS origin allowed to
connect (defaults to `*`).

## Events (M1)

- `presenter:setSlide { index }` (client → server) — rebroadcast to everyone
  as `slide:changed { index }`, and stored as the session's current slide.
- `slide:changed { index }` (server → all clients) — a slide change happened.
- `slide:sync { index }` (server → the newly-connected client only) — sent
  immediately on connect so a participant who joins/reloads mid-session lands
  on the presenter's current slide rather than slide 1. This isn't in the
  PRD's §10 event list verbatim; it's the minimum addition needed to make
  `slide:changed` (a rebroadcast-only event) useful to late joiners, and is a
  deliberate, documented decision — not scope creep. Don't remove it without
  updating plan 026's status.

## Known security gap (by design, until plan 029)

**There is no authentication in M1.** Any socket that connects can emit
`presenter:setSlide` and move every connected participant's slide — there is
no check that the sender is actually the instructor. This is an accepted,
explicitly-tracked gap: plan
[029](../../plans/029-workshop-tracker-m4-presence-auth.md) (M4) adds a join
code that gates who is allowed to act as "the presenter". Do not point this
server at a real workshop room, and do not treat it as secure, before 029
lands.

## Testing

```bash
pnpm --filter workshop-tracker-server test
```

`src/server.test.ts` spins up a real `socket.io-client` pair against an
in-process server on an ephemeral port and asserts the `slide:sync` /
`presenter:setSlide` → `slide:changed` event contract above. It's a thin
harness deliberately left in place for plans 027+ to extend with the
participant/step/error/presence events, rather than starting from scratch.
