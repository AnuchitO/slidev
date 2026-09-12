# Plan 031 (proposal): Session lifecycle, self-serve codes, multi-room, and practice mode

> **Status of this document**: a PROPOSAL, not an executor-ready plan like
> 026-030. It answers four architecture questions the owner (AnuchitO) asked
> directly, with a recommendation and a concrete design for each — but
> nothing here should be implemented until the owner picks a scope/order.
> Once agreed, the "Recommended sequencing" section's items should each
> become their own real plan file (032, 033, ...) in this same style.
>
> **Source doc**: [`plans/prd-workshop-tracking.md`](./prd-workshop-tracking.md)
> — specifically §4's non-goal ("Multi-room / multi-workshop concurrency
> ... design the data model so it's not painful to add later") and §14's
> open question #1 ("does the instructor need to spin up multiple concurrent
> sessions? Affects whether Session needs to be a first-class, creatable
> entity"). This proposal is the answer to that open question, three plan
> numbers and a full initiative (026-030) later than it was originally asked.

## Status

- **Priority**: owner-driven — this doc exists to let the owner set it
- **Effort**: see per-item estimates below (S for 4.2a, L for everything else)
- **Risk**: MED-HIGH for the auth-bootstrap piece of 4.2 specifically (see
  its own section) — everything else is additive to the existing model
- **Depends on**: 026-030 (done), and indirectly on whichever of the
  "Ask for Help" redesign / join-link-QR / rename work has landed by the
  time this is read
- **Category**: architecture proposal

## The four questions, answered

### Q1 (the user's "4.2"): can the presenter generate codes instead of an operator hardcoding env vars?

Yes, and it splits cleanly into two pieces of very different size:

**4.2a — auto-generate at boot when unset (small, recommended now).** Today
`index.ts` treats a missing `SLIDEV_MUAN_COMPANION_ROOM_CODE`/
`PRESENTER_CODE` as "fail closed, nothing works until an operator sets
them" (see its own startup-warning comment). Instead: if either is unset,
generate a random one (e.g. a short unambiguous alphanumeric string —
avoid `0/O/1/I` confusion, this gets read aloud in a room) and use that,
same as if it had been supplied — env vars still win when present, for
scripted/repeatable setups (CI, a fixed demo). This alone removes "hardcode
a value" entirely for the common case: an operator just runs `pnpm dev`
with no env vars, and the startup log (already prints both codes and every
URL) is now also where the codes *come from*, not just where they're
echoed back. No auth model change, no new client work, fully backward
compatible. This is a same-day change — worth shipping regardless of what
happens with the rest of this proposal.

**4.2b — an in-app "generate/regenerate" action, reachable before knowing
any code (large, security-sensitive).** This is what "presenter has a way
to generate ... before clicking start present" really implies: a screen
the presenter can reach with *zero* pre-shared secret, see/copy the current
codes, and hit regenerate if they don't like them, before anyone has
joined. The hard part isn't the generation — it's the access model. Every
privileged surface today (`presenter:*`, `dashboard:join`, the `/dashboard`
HTTP route) is deliberately fail-closed on a credential that has to already
exist somewhere for anyone to supply it (`auth.ts`). A screen reachable with
*no* credential is a new, narrower exception to that rule, not a
relaxation of it everywhere else. Recommended shape:

- The server always has codes (4.2a ensures that), but starts in a new
  `status: 'setup'` state (see Q3 below — this reuses the same status field
  the lobby needs) in which the dashboard's landing page is reachable
  *without* `?code=` and shows "here are your codes" + a regenerate button
  + a "Start Presenting" button.
- The moment `status` leaves `'setup'` (via "Start Presenting"), the
  unauthenticated path closes for good for that process's lifetime — every
  existing gate (`requireDashboardCode`, `isValidPresenterCode`) applies
  exactly as it does today, no change to their logic. The exception window
  is bounded to "before the session has actually started," not "always."
- Extra hardening worth strongly considering: restrict the unauthenticated
  setup screen to loopback/localhost connections only (`req.socket.
  remoteAddress`), so it's usable on the presenter's own machine before
  they've shared anything, but not reachable by someone who stumbles onto
  the port on the workshop's LAN before the presenter has locked in codes.
  This is the one part of this whole proposal that should get a real
  security-review pass before shipping, not just tests — it's a deliberate,
  if narrow and time-boxed, hole in an otherwise fail-closed model.

### Q2 (the user's "4.3"): can one server run multiple concurrent sessions for different groups?

**Two different answers depending on what "concurrent sessions" needs to mean:**

**Option A — already possible today, zero code changes.** Nothing in this
codebase assumes there's only one `muan-companion-server` process on the
machine/network. Run two: different `PORT`s, different
`SLIDEV_MUAN_COMPANION_ROOM_CODE`/`PRESENTER_CODE` pairs, and two Slidev
deck processes (each with its own slides, each `VITE_SLIDEV_MUAN_COMPANION_
SERVER_URL` pointed at its own server instance). Two instructors running
two different workshops for two different groups at the same time, each
with their own dashboard/URLs, works right now. The only thing this
"lacks" versus true multi-tenancy is a single shared dashboard/URL space —
which the PRD never actually asked for (§4 non-goal is about *the server*
supporting concurrency, not about an operator running N of them). **This
is the recommended answer unless there's a specific reason one shared
always-on deployment (rather than "spin up a process per session") is
required** — e.g. a hosted, always-on instance multiple instructors log
into, as opposed to a laptop running one workshop at a time.

**Option B — true single-process multi-room support (large).** If Option A
genuinely isn't enough, this requires re-keying nearly every singleton in
`session.ts` (`session`, `participants`, `stepStatus`, `errorReports`) into
`Map<roomCode, RoomState>`, and every handler in `server.ts` resolving
"which room" a given socket belongs to (set once at `participant:join`/
`presenter:*`/`dashboard:join` time on `socket.data.roomCode`, mirroring
how `socket.data.participantId` already works) before touching any state.
The dashboard-broadcast room mechanism already in `server.ts`
(`DASHBOARD_ROOM`) is exactly the right primitive to extend — instead of
one `'dashboard'` room, each session gets `` `dashboard:${roomCode}` ``, and
`broadcastStateUpdate` targets the specific room instead of a global one.
Recommend using the **room code itself** as the map key rather than
inventing a separate internal `roomId` — it's already required to be
unique per session by construction (the presenter picks/generates a fresh
one each time via 4.2), and a second parallel identifier would only add
translation overhead everywhere. Screenshot uploads' `mkdtempSync`
temp-dir-per-process pattern (`server.ts`) already isolates per-process; a
multi-room single process would need one such dir *per room* instead,
which is a small extension of the same pattern, not a redesign.

Size estimate: comparable to redoing the server-side surface of M1-M4
combined (session.ts + server.ts + every one of their test files touch
almost every line). Recommend treating this as its own multi-week
milestone series, not a quick add-on to 4.2/5/6 below — and only starting
it once Option A has actually been outgrown in practice, per the PRD's own
"design the data model so it's not painful to add later" framing (Option A
already satisfies "not painful" — nothing has to be undone to build Option
B later; the singletons don't leak into any external contract participants
or the addon depend on).

**Addendum (post-review, found by a later architecture pass — not present
when this section was first written)**: two things have landed on top of
the singleton inventory above since this plan was drafted, both small,
neither invalidating the estimate, but both need folding into whoever
actually scopes Option B:
- `pendingConnections` (`Map<socketId, PendingConnection>`, the "someone's
  here but hasn't joined yet" dashboard-visibility feature) is keyed by raw
  socket id, populated by a `participant:connecting` event that carries
  **no room information at all** — there's nothing to key it by yet, since
  the whole point is "before any identity/room membership exists." Multi-room
  would need that event (or the initial handshake) to carry a room hint up
  front, which is a small wire-contract addition this plan didn't need to
  consider before this feature existed — worth deciding explicitly (a query
  param at connection time? a field on `participant:connecting` itself?)
  rather than rediscovering it mid-implementation.
- The join-URL/QR-code cache (`server.ts`'s `getJoinQrDataUrl`) is one
  `Promise` closed over one process-wide `roomCode`. Multi-room needs one
  cached promise per room, not per process — the same shape of fix already
  called out above for `uploadsDir`'s `mkdtempSync` ("a small extension of
  the same pattern, not a redesign"), just a second instance of it that
  didn't exist when this section was written.

### Q3 (the user's "5"): a waiting room / lobby before "Start Presenting", participants can still join later

This turns out to be **more independent of Q1/Q2 than it first looks** —
it can ship on top of today's env-var-configured-codes auth model
unchanged, needing only 4.2a (nice-to-have, not required) rather than the
harder 4.2b bootstrap problem. Design:

- `WorkshopSession` (`session.ts`) gains `status: 'lobby' | 'live'`,
  starting at `'lobby'`.
- Participants can `participant:join` during `'lobby'` exactly as today —
  the room-code gate doesn't change. What changes is what they *see*: a
  new `session:status { status }` event (pushed alongside the existing
  `slide:sync` late-joiner sync) tells the addon whether to render the
  normal synced deck or a new "waiting for the presenter to start…"
  screen. The dashboard's participant table already shows joined
  participants live via the existing `state:update` broadcast — a filling
  waiting room *is* today's roster view, no new dashboard mechanics needed.
- New presenter action: `presenter:startSession { presenterCode }` (gated
  identically to every other `presenter:*` event) flips `status` to
  `'live'` and broadcasts `session:status { status: 'live' }` — every
  waiting participant transitions off the waiting screen onto the actual
  current slide, the same mechanism `slide:sync`/`slide:changed` already
  use.
- **Late joiners after `'live'` need no special-casing** — they just join
  normally and land on whatever the current slide is, exactly like today.
  This is the "still allow others to join later" requirement, satisfied by
  the existing late-join path with no new code.

Estimate: moderate, self-contained — one new session field, one new event
pair, one new addon-side screen state. This is the most tractable of the
four items and could reasonably be the *first* real plan file out of this
proposal, independent of the Q1/Q2 decisions.

### Q4 (the user's "6"): a practice slide/mode before the real content, skippable both at setup and at runtime

**Key simplification: practice mode is naturally just "what the lobby
screen offers," not a separate slide-index or sync mechanism.** While
`status === 'lobby'` (Q3), nobody is being synced to anything yet — that's
inherent to the lobby existing at all, not something practice mode has to
build. So instead of a bare "waiting for the presenter" message, the lobby
screen can offer an interactive practice sandbox using the addon's
*existing*, slide-content-agnostic components — `<StepCommand>`'s
Copy/Done buttons and the "Ask for Help" widget already work standalone,
tied only to whatever `stepId` is in scope, not to any specific slide.
Two concrete design choices to make explicit (recommend deciding, not
silently picking one):

1. **Do practice interactions touch the real session's data at all?**
   Simplest: yes — let practice Copy/Done/Ask-for-Help clicks go through
   the exact same events and land on the real dashboard, just tagged with
   an obviously-practice `stepId` (e.g. `'practice'`) so an instructor
   glancing at the dashboard isn't confused by it appearing alongside real
   step data. This needs zero new server-side concepts. The alternative —
   a fully sandboxed practice mode whose actions never reach the server at
   all — needs a client-side-only mock of the same interactions, which is
   more code for arguably no real benefit (a few practice clicks in the
   dashboard's history are harmless, and "prove the connection actually
   works before the real thing starts" is itself a decent side benefit of
   the events being real).
2. **Skip toggles, exactly as asked**: a session-level `practiceEnabled`
   boolean, set once at the same setup screen 4.2b introduces ("skip it
   during create" — if 4.2b isn't built yet, this can default to
   env-var-configurable instead), and a participant-facing "Skip practice
   →" button/link on the lobby screen itself ("skip it during practice")
   that just transitions that one participant's local view straight to
   the plain "waiting for the presenter" state without disabling practice
   for anyone else.

Estimate: small once Q3's lobby exists — this is mostly addon-side UI
(a practice-sandbox screen reusing existing components) plus one boolean
flag, not new sync-server data-model work.

## Recommended sequencing

| # | Item | Depends on | Effort | Notes |
|---|------|------------|--------|-------|
| 031a | Auto-generate codes at boot when unset | — | S | Ship independently, anytime, no risk |
| 031b | Session lifecycle: lobby/live + Start Presenting | — | M | Most tractable of the four; independent of 4.2b/4.3 |
| 031c | Practice mode in the lobby, with both skip toggles | 031b | S-M | Mostly addon UI once 031b exists |
| 031d | In-app code generate/regenerate with unauthenticated setup bootstrap | 031a | M-L | The one item needing a real security-review pass |
| 032 | True single-process multi-room (`Map<roomCode, RoomState>`) | none technically, but pointless before outgrowing Option A | L (initiative-sized) | Only pursue if running N processes genuinely isn't workable |

Recommend confirming scope/order with the owner before writing any code
for 031b onward — 031a is small and uncontroversial enough to just ship.

## Open questions for the owner

1. Is "concurrent sessions" actually about one always-on shared deployment
   (→ pursue 032), or about running the same workshop twice in a day /
   two instructors at once (→ Option A already covers it, document and
   move on)?
2. For 031d's unauthenticated setup window: is restricting it to
   localhost-only connections an acceptable UX tradeoff (presenter must be
   on the same machine as the server to do first-time setup), or does the
   workshop's real usage pattern need setup to happen from a different
   device than the one running the server (which would need a different,
   harder-to-make-safe bootstrap mechanism)?
3. For 031c's practice interactions: is it acceptable for a few practice
   Copy/Done/Ask-for-Help clicks to appear in the real dashboard tagged
   `stepId: 'practice'`, or is a fully client-side-only sandbox (no server
   events at all) worth the extra code to keep the dashboard's real data
   completely clean during setup?
