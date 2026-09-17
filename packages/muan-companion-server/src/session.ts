import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'pathe'
import { generateCode } from './codeGeneration'

export interface WorkshopSession {
  /**
   * The room code this session is keyed by. Plan 032a (031 Q2 Option B)
   * deliberately reuses the **room code itself** as the map key rather than
   * minting a separate internal `roomId`: the room code is already unique per
   * session by construction (`createSession` below refuses a duplicate, and
   * generates a fresh one when the caller doesn't supply one), and a second
   * parallel identifier would only add translation overhead at every call
   * site that already has one of the two in hand. Was the literal string
   * `'default'` back when this was a process-wide singleton.
   */
  id: string
  currentSlideIndex: number
  createdAt: number
  /**
   * The stepId of whichever slide the presenter is currently on — reported
   * by the addon's `setup/main.ts` alongside `presenter:setSlide` (see
   * server.ts's NOTE on the `presenter:setSlide` handler). Not in PRD §10's
   * literal event payload; it's the minimum addition needed so the
   * dashboard can show a "current step" status column (plan 027 Step 3)
   * without the server having to parse deck markdown itself. Falls back to
   * the slide index as a string, matching PRD §8's "falls back to the slide
   * index if omitted" — computed client-side by `resolveStepId` (addon's
   * `src/stepId.ts`) and trusted as-is here.
   */
  currentStepId: string
}

export type StepState = 'idle' | 'copied' | 'done'

/**
 * `'visible'`/`'hidden'` are reported directly by the participant's browser
 * on `visibilitychange` (PRD §10's `participant:visibility`); `'closed'` is
 * never sent by a client (a closing tab can't reliably emit one more event)
 * — it's inferred server-side, either immediately on a clean Socket.io
 * `disconnect`, or by `presence.ts`'s `sweepStaleParticipants` for a hung
 * connection that never fires one (plan 029 Step 3).
 */
export type ParticipantVisibility = 'visible' | 'hidden' | 'closed'

export interface Participant {
  id: string
  name: string
  joinedAt: number
  lastSeen: number
  connected: boolean
  visibility: ParticipantVisibility
  /**
   * Every Socket.io socket id currently representing this participant —
   * plural, not singular. The same participant identity can legitimately be
   * open in more than one browser tab at once (the `localStorage`-backed
   * resume — see `participantIdentity.ts` — means a second tab on the same
   * browser resumes the *same* participant rather than minting a new one).
   * A single `socketId` string couldn't represent that: opening a second tab
   * used to overwrite it, so closing that second tab's socket unconditionally
   * marked the whole participant `closed` — and silently misdirected the
   * `presenter:resolveError` notification (`server.ts`) at a dead socket —
   * even though the first tab was still open, connected, and actively
   * viewing. Reported as a real bug from live use, not a hypothetical.
   *
   * `connected`/`visibility` are accurate as long as this array is
   * non-empty; a participant only becomes `closed` once every socket in it
   * has disconnected — see `removeParticipantSocket` below, and
   * `presence.ts`'s staleness sweep (which checks whether *any* of these are
   * still live) for the other place that matters.
   */
  socketIds: string[]
}

/**
 * Keyed as `${participantId}:${stepId}`. Value carries `updatedAt` (not just
 * the raw `StepState`) so `listStepStatus()` can report "how long has this
 * participant been sitting in `'copied'`" — see `StepStatusEntry`'s own doc
 * comment for why that matters.
 */
export interface StepStatusValue {
  state: StepState
  updatedAt: number
}

/**
 * A socket that has connected but not yet completed `participant:join` —
 * the "someone's here but hasn't told us their name yet" visibility the
 * dashboard needs (reported from live use: `JoinScreen.vue`'s join-screen
 * overlay is a client-side UI gate, not a content access control — deleting
 * it via devtools lets a browser watch the deck without ever joining; see
 * that component's own comment for why that's inherent to how a
 * client-rendered SPA works, not fixable purely client-side). This doesn't
 * close that gap — it can't be closed here — it makes the presence visible
 * to the presenter instead, and pairs with `removeParticipant`/the
 * `presenter:kick*` events below to let them disconnect a socket they don't
 * want around.
 *
 * Keyed by socket id, not participant id — there is no participant id yet.
 * Only ever populated for a socket that explicitly announces itself via
 * `participant:connecting` (`server.ts`) — the presenter's own route and
 * the dashboard's own socket never emit that event, so neither shows up
 * here despite both being ordinary Socket.io connections too.
 *
 * Plan 032a: this map now lives on a `RoomState` rather than at module
 * scope, so "which room's dashboard should see this anonymous socket" has an
 * answer. See `server.ts`'s `roomOf` for the room hint that makes that
 * possible at a point in a socket's life where no identity exists yet.
 */
export interface PendingConnection {
  socketId: string
  connectedAt: number
}

/**
 * `ErrorReport` (PRD §9, plan 028 Step 1; extended by the "Ask for Help"
 * UX redesign): a participant's text and/or screenshot report tied to
 * `participantId`/`stepId`. `text`/`screenshotUrl` stay as the *original*
 * submission only — everything sent after that (a presenter reply, a
 * participant's confirm/reopen response, a follow-up question) lives in
 * `thread`, not mixed into these two fields.
 */
export interface ErrorReport {
  id: string
  participantId: string
  participantName: string
  stepId: string
  kind: HelpRequestKind
  text?: string
  screenshotUrl?: string
  ts: number
  status: HelpRequestStatus
  thread: ThreadMessage[]
}

/**
 * Everything one live workshop session owns — plan 032a's whole point.
 * Before this, each of these fields was its own module-level singleton
 * (`session`, `participants`, `stepStatus`, `errorReports`,
 * `pendingConnections`), which is what limited the process to exactly one
 * workshop at a time (031 Q2 Option A: "run a second process instead").
 * Bundling them into one record keyed by room code means a handler resolves
 * "which room" **once** (`server.ts`'s `roomOf`) and then every piece of
 * state it needs is reachable from that one object — rather than five
 * independent lookups that could each silently land in a different room.
 *
 * Deliberately a plain mutable record, not a class: every mutator in this
 * file already operated by in-place mutation on the singletons, and keeping
 * that posture makes this refactor a re-keying rather than a rewrite of the
 * state model itself.
 */
export interface RoomState {
  /** Also this room's key in `rooms` — see `WorkshopSession.id`. */
  roomCode: string
  /**
   * The high-privilege secret for *this room specifically*. Per-room, not
   * per-process: two concurrent sessions must not be interchangeable, so a
   * presenter code that opens room A's dashboard must be worthless against
   * room B. `auth.ts`'s constant-time check is unchanged; what changed is
   * that the `WorkshopAuthConfig` it checks against is now read off the
   * resolved room instead of one process-wide config object.
   */
  presenterCode: string
  /** See `CreateMuanCompanionServerOptions.deckUrl` (`server.ts`). Per-room so 032b/032d can launch different decks side by side. */
  deckUrl: string
  /** See `CreateSessionOptions.presentationTitle`'s own doc comment. */
  presentationTitle?: string
  session: WorkshopSession
  participants: Map<string, Participant>
  stepStatus: Map<string, StepStatusValue>
  errorReports: ErrorReport[]
  pendingConnections: Map<string, PendingConnection>
  /**
   * Absolute path to this room's own `mkdtemp`-ed screenshot directory.
   * Plan 028 Step 1 created one such directory per *process*; 031 Q2 called
   * this out as "a small extension of the same pattern, not a redesign" for
   * multi-room, and this is that extension — one per room, so room A's
   * presenter can never be handed a path that resolves into room B's
   * uploads.
   */
  uploadsDir: string
  /**
   * The last path segment of `uploadsDir` — the segment that appears in a
   * report's `screenshotUrl` (`/uploads/${uploadsDirName}/${filename}`) and
   * that `server.ts`'s `/uploads` route uses to pick which room's directory
   * to serve from. Deliberately the **server-generated `mkdtemp` suffix**,
   * never the room code: the room code can come from an operator's env var
   * (arbitrary bytes, `../` included), and a URL path segment derived from
   * it would be attacker-influenced path input. This one is chosen entirely
   * by `mkdtempSync`, so there is no user-controlled component in the served
   * path at all — the same "constrain the shape rather than blocklist"
   * discipline `uploads.ts`'s filename regex already applies one level down.
   */
  uploadsDirName: string
  /**
   * Cached `Promise` for this room's join-link QR PNG — see `server.ts`'s
   * `getJoinQrDataUrl`. One per room, not one per process (031 Q2's
   * Addendum): the encoded payload is derived from the room code, so a
   * process-wide cache would hand room B's dashboard room A's QR code.
   * Stored here rather than in a closure precisely so it's keyed the same
   * way everything else about the room is.
   */
  joinQrDataUrlPromise?: Promise<string | undefined>
}

/**
 * Every live session in this process, keyed by room code. Replaces the
 * module-level `session`/`participants`/`stepStatus`/`errorReports`/
 * `pendingConnections` singletons (plan 032a / 031 Q2 Option B).
 *
 * Still module-level rather than owned by a `createMuanCompanionServer`
 * instance, matching this package's existing posture (`screenshotUpload.ts`
 * reaches into this module directly, and the whole package is written as
 * module singletons) — what changed is the *arity*, from one implicit
 * session to N explicit ones, not where they live.
 */
export const rooms = new Map<string, RoomState>()

export function getRoom(roomCode: string | undefined): RoomState | undefined {
  return roomCode === undefined ? undefined : rooms.get(roomCode)
}

export function listRooms(): RoomState[] {
  return [...rooms.values()]
}

/**
 * Code lengths for a session whose codes weren't supplied by the caller.
 * Moved here from `index.ts` as part of plan 032a: `createSession` is now the
 * single place a session — and therefore a session's codes — comes into
 * existence, so the lengths belong next to it rather than at one particular
 * caller. `index.ts` still decides whether to *supply* codes (from env vars);
 * it just no longer owns how they're invented when it doesn't.
 *
 * Presenter code is longer than the room code: it's the higher-privilege of
 * the two secrets (see `auth.ts`'s own comment on why they're never
 * derivable from one another), so it gets more entropy for the same
 * "readable/typeable" alphabet. Lengths bumped from the original 6/8 after a
 * security review flagged the room code specifically as thin relative to
 * the README's own "choose codes with enough entropy to resist casual
 * guessing" goal, given this package's explicit no-rate-limiting posture: 6
 * chars from `codeGeneration.ts`'s 31-character alphabet is only ~30 bits
 * (≈887M combinations) — plausible to exhaust via scripted join attempts
 * over a multi-day event, even though a successful guess only grants
 * join-as-a-fake-participant, never presenter/dashboard access. 8/10 chars
 * raise that to ~40/~50 bits (≈8.5×10¹¹ / ≈8.2×10¹⁴ combinations) while
 * keeping the same "resist mishearing when read aloud" alphabet.
 */
export const ROOM_CODE_LENGTH = 8
export const PRESENTER_CODE_LENGTH = 10

/**
 * How many times `createSession` re-rolls a generated room code that happens
 * to collide with a live session's. At 8 characters from a 31-character
 * alphabet a collision is already vanishingly unlikely at workshop scale
 * (dozens of concurrent rooms at the absolute most), so this is a
 * correctness backstop, not a hot path — but silently handing a caller a
 * room code that's already in use would quietly merge two workshops into
 * one, which is exactly the failure this whole plan exists to prevent.
 */
const MAX_CODE_GENERATION_ATTEMPTS = 10

/**
 * The process-wide parent directory every room's own uploads directory is
 * created inside. One `mkdtemp` at module level for the parent (so the OS
 * temp dir doesn't accumulate one loose directory per room at its top
 * level), then one `mkdtemp` *per room* underneath it (`createSession`
 * below). Making the per-room directories siblings under a single root is
 * what lets `server.ts` keep serving `/uploads` from one `sirv` mount:
 * `/uploads/${uploadsDirName}/${filename}` maps directly onto this tree, so
 * no per-room mount or URL rewriting is needed.
 *
 * Lazy (created on the first `createSession`, not at import time) so merely
 * importing this module — which `session.test.ts`, `presence.ts`'s type
 * import, and the addon's type-only imports all do — never touches the
 * filesystem.
 */
let uploadsRootDir: string | undefined

export function getUploadsRootDir(): string {
  if (!uploadsRootDir)
    uploadsRootDir = mkdtempSync(join(tmpdir(), 'slidev-muan-companion-uploads-'))
  return uploadsRootDir
}

export interface CreateSessionOptions {
  /**
   * Where participants should open the deck itself — see
   * `CreateMuanCompanionServerOptions.deckUrl` (`server.ts`). Defaults to
   * the empty string rather than to `DEFAULT_DECK_URL`: this module has no
   * business knowing Slidev's default dev port, and every real caller
   * (`index.ts` via `createMuanCompanionServer`) already resolves it.
   */
  deckUrl?: string
  /**
   * The participant-facing room code. **`undefined` means "generate one"**
   * (031a's posture, now applied to every session rather than only the one
   * `index.ts` boots); any supplied string is used verbatim, including the
   * empty string — see the note in `createSession`'s own doc comment on why
   * `''` is deliberately allowed rather than rejected.
   */
  roomCode?: string
  /** The presenter code. `undefined` means "generate one", exactly as `roomCode` above. */
  presenterCode?: string
  /**
   * Injectable code generator, defaulting to `codeGeneration.ts`'s
   * crypto-backed one — same rationale as `generateCode`'s own `random`
   * parameter: tests can assert exact codes without mocking the crypto
   * module.
   */
  generate?: (length: number) => string
  /**
   * The discovered `Presentation.title` this session was launched from
   * (plan 032c's `POST /api/launch`, via `resolvePresentation` —
   * `presentations.ts`), carried through purely so the home view can label a
   * live session with which deck is actually running (`HomeSessionSummary`
   * in `server.ts`). `undefined` for every session that didn't come from
   * Flow A's discovery — the boot session and any Flow-B (`POST
   * /api/register`) session, neither of which has a `Presentation` behind
   * it — and the home view falls back to the bare `deckUrl` for those rather
   * than inventing a title.
   */
  presentationTitle?: string
}

export interface CreateSessionResult {
  roomCode: string
  presenterCode: string
  room: RoomState
}

/**
 * Creates one fresh, isolated workshop session and registers it in `rooms`.
 *
 * Plan 032a makes this **the only way a session comes into existence** —
 * including `createMuanCompanionServer`'s own boot-time session, which used
 * to be special-cased module-level initialization. 032b (the presentation
 * launcher UI) and 032d call this same function to spin up further sessions
 * at runtime; there is deliberately no second path, so anything true of a
 * session (it has both codes, it has its own uploads directory, it's
 * discoverable in `rooms`, it shows up in the `dashboard:home` feed) is true
 * of *every* session without a caller having to remember to do it.
 *
 * Throws on a duplicate room code rather than replacing or silently reusing
 * the existing room. Replacing would let a second `createSession` wipe a
 * live workshop's roster out from under it; reusing would quietly merge two
 * workshops into one session sharing a participant list. Both are worse than
 * a loud failure the caller has to handle — and for the generated-code case
 * the caller never sees this at all, since collisions are re-rolled below.
 *
 * An empty-string `roomCode` is deliberately *allowed*, not rejected: it's
 * how `createMuanCompanionServer` represents "no room code was configured"
 * (its own `roomCode` option is optional), and `auth.ts`'s `isValidCode`
 * refuses every credential against an empty configured code — so such a room
 * exists but is permanently unreachable: no `participant:join`, no
 * `presenter:*`, no dashboard. That is exactly the fail-closed state this
 * package has always had for an unconfigured server, now expressed as a room
 * nobody can enter rather than as a singleton nobody can use.
 */
export function createSession(options: CreateSessionOptions = {}): CreateSessionResult {
  const generate = options.generate ?? (length => generateCode(length))

  let roomCode: string
  if (options.roomCode !== undefined) {
    if (rooms.has(options.roomCode))
      throw new Error(`[muan-companion-server] a session already exists for room code "${options.roomCode}"`)
    roomCode = options.roomCode
  }
  else {
    roomCode = generateUnusedRoomCode(generate)
  }

  const presenterCode = options.presenterCode ?? generate(PRESENTER_CODE_LENGTH)

  // One `mkdtemp` per room inside the shared root — see `RoomState.uploadsDir`
  // / `getUploadsRootDir` for why the per-room directory's *name* (not the
  // room code) is what ends up in a `screenshotUrl`.
  const uploadsDir = mkdtempSync(join(getUploadsRootDir(), 'room-'))
  const uploadsDirName = uploadsDir.slice(getUploadsRootDir().length + 1)

  const now = Date.now()
  const room: RoomState = {
    roomCode,
    presenterCode,
    deckUrl: options.deckUrl ?? '',
    presentationTitle: options.presentationTitle,
    session: {
      id: roomCode,
      currentSlideIndex: 1,
      createdAt: now,
      currentStepId: '1',
    },
    participants: new Map(),
    stepStatus: new Map(),
    errorReports: [],
    pendingConnections: new Map(),
    uploadsDir,
    uploadsDirName,
  }
  rooms.set(roomCode, room)
  return { roomCode, presenterCode, room }
}

function generateUnusedRoomCode(generate: (length: number) => string): string {
  for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generate(ROOM_CODE_LENGTH)
    if (!rooms.has(candidate))
      return candidate
  }
  // Only reachable with a degenerate injected `generate` (a test stub that
  // always returns the same string) — real generation would have to lose a
  // ~40-bit lottery ten times running. Fail loudly rather than return a
  // colliding code, for the same reason `createSession` throws on an
  // explicit duplicate.
  throw new Error('[muan-companion-server] could not generate an unused room code')
}

/**
 * Removes a session and everything it owned. The symmetric half of
 * `createSession` — plan 032d ("end this session") is its intended caller,
 * and `createMuanCompanionServer` already uses it to tear down its own
 * boot-time session when the http server closes, so a process that stands up
 * a server, closes it, and stands up another under the same room code
 * doesn't trip `createSession`'s duplicate check on a room nothing is
 * serving any more.
 *
 * Does **not** delete the room's `uploadsDir` from disk: uploads have no
 * retention/cleanup policy anywhere in this package (plan 028's explicit
 * out-of-scope call — the whole tree is under the OS temp directory and goes
 * away with the machine's own temp cleanup), and deleting files while a
 * response might still be streaming one is a worse failure than leaving a
 * few kilobytes behind. Returns whether a room actually existed, mirroring
 * `removePendingConnection`'s "did anything change" return so callers know
 * whether there's anything to broadcast.
 */
export function destroySession(roomCode: string): boolean {
  return rooms.delete(roomCode)
}

export function addPendingConnection(room: RoomState, socketId: string, now: number = Date.now()): void {
  room.pendingConnections.set(socketId, { socketId, connectedAt: now })
}

/**
 * Removes a pending connection — called both when it graduates into a real
 * `Participant` via `joinParticipant` succeeding, and when the socket
 * disconnects before ever joining. A socket id with no pending entry (e.g.
 * the presenter's or dashboard's own socket, which never emitted
 * `participant:connecting` in the first place) is a harmless no-op. Returns
 * whether an entry actually existed (`Map.delete`'s own return value) so
 * `server.ts`'s `disconnect` handler knows whether there's a now-vanished
 * pending row to broadcast.
 */
export function removePendingConnection(room: RoomState, socketId: string): boolean {
  return room.pendingConnections.delete(socketId)
}

export function listPendingConnections(room: RoomState): PendingConnection[] {
  return [...room.pendingConnections.values()]
}

/**
 * How a `participant:join` call was actually resolved (plan 030 / PRD §12
 * resilience). Distinguishes a normal first-time join from a genuine resume
 * from one that *attempted* to resume but couldn't — the server logs each
 * differently (`server.ts`) so an operator can tell "someone joined" apart
 * from "someone's resume silently failed" during a real session, and the
 * addon's `JoinScreen.vue` uses it to decide whether to skip the join
 * prompt entirely (successful resume) or show it again (failed resume,
 * e.g. after a server restart wiped the in-memory registry — PRD §4/§14's
 * accepted in-memory-reset case).
 */
export type JoinOutcome = 'fresh' | 'resumed' | 'resume-fallback'

export interface JoinResult {
  participant: Participant
  outcome: JoinOutcome
}

/**
 * Finds an existing participant by a client-supplied id (from
 * `localStorage`, see the addon's `JoinScreen.vue` / `participantIdentity.ts`
 * — originally `sessionStorage` under plan 030, switched to `localStorage`
 * as a follow-on fix so a closed-and-reopened tab, not just a same-tab
 * refresh, can still resume) and refreshes it, or creates a new one with a
 * fresh server-assigned id. Never trusts a client-supplied id as the id of a
 * brand-new record — only reuses it to look up an *existing* one — so a
 * stale/guessed id can't be used to plant a record under an attacker-chosen
 * key.
 *
 * Resume is bound to two things an attacker can't cheaply obtain together:
 * the participant room code (checked by the caller, `server.ts`, before this
 * function ever runs) and this specific `existingId` — a 122-bit
 * `crypto.randomUUID()` minted at original join time (see `server.ts`'s
 * `participant:join` handler) that's never broadcast to other participant
 * sockets (only to the presenter-code-gated dashboard room). That combination
 * is, in effect, an unguessable bearer resume token scoped to one browser's
 * `localStorage` — not a plain "trust whatever id shows up" design (plan
 * 030's STOP condition on resume hijacking). Being scoped to *one browser*
 * rather than one tab is a deliberate widening (see `participantIdentity.ts`'s
 * doc comment for the bug it fixes) — the addon's own `JoinScreen.vue` "Not
 * you? Join as someone else" link is the client-side mitigation for the one
 * new consequence that introduces (a shared/kiosk browser resuming the
 * previous person's identity), not a server-side concern.
 *
 * Plan 032a: the lookup is scoped to `room.participants`, so a
 * `participantId` minted in room A resolves to nothing in room B and falls
 * through to an ordinary fresh join there — which means room B's room-code
 * gate (`server.ts`'s `isKnownResume` check) still applies to it in full.
 * Resume tokens do not cross rooms.
 */
export function joinParticipant(room: RoomState, name: string, existingId: string | undefined, generateId: () => string, socketId: string): JoinResult {
  const now = Date.now()
  const existing = existingId ? room.participants.get(existingId) : undefined

  if (existing) {
    // Plan 030 Step 1: name is part of what's being resumed — the resumed
    // identity wins even if a (possibly different) name was supplied on this
    // join call, so a rejoin can't quietly rename a participant out from
    // under their own history. `name` here is only ever used for a genuinely
    // *new* participant, below.
    existing.connected = true
    existing.lastSeen = now
    // A (re)join always means *this* tab is frontmost/interactive again —
    // reset visibility to 'visible' rather than leaving a stale
    // 'hidden'/'closed' from before this socket connected. This is a
    // reasonable simplification even in the multi-tab case (the tab that
    // just joined/resumed is the one the participant is presumably looking
    // at right now); an existing second tab's own heartbeat/visibility
    // reporting is unaffected and keeps correcting the picture independently.
    existing.visibility = 'visible'
    // Add, don't replace — see `socketIds`' own doc comment for the bug this
    // fixes. A same-tab refresh's *old* socket disconnects on its own
    // (Socket.io's `disconnect` event fires when a page unloads), which
    // removes it via `removeParticipantSocket` below; there's nothing to
    // proactively evict here.
    if (!existing.socketIds.includes(socketId))
      existing.socketIds.push(socketId)
    return { participant: existing, outcome: 'resumed' }
  }

  const participant: Participant = {
    id: generateId(),
    name,
    joinedAt: now,
    lastSeen: now,
    connected: true,
    visibility: 'visible',
    socketIds: [socketId],
  }
  room.participants.set(participant.id, participant)
  return { participant, outcome: existingId ? 'resume-fallback' : 'fresh' }
}

/**
 * Removes one socket from a participant's live-socket set — called from
 * `server.ts`'s `disconnect` handler. Only flips the participant to
 * `connected: false, visibility: 'closed'` once *every* socket representing
 * it is gone, not on the first one to close (see `socketIds`' doc comment
 * for why that distinction is the actual bug fix here). Returns whether this
 * removal was the one that fully closed the participant, so the caller knows
 * whether there's anything user-visible to broadcast — removing one socket
 * out of several changes nothing the dashboard renders.
 *
 * A stale dead socket id belonging to a participant that still has at least
 * one other live socket is left in the array rather than proactively pruned
 * here — harmless (a workshop-scale session never accumulates enough of
 * these to matter) and self-corrects the next time that specific socket's
 * own `disconnect` fires. `presence.ts`'s staleness sweep clears the whole
 * array in one go when it determines a participant is fully gone.
 */
export function removeParticipantSocket(room: RoomState, participantId: string, socketId: string): boolean {
  const participant = room.participants.get(participantId)
  if (!participant)
    return false
  participant.socketIds = participant.socketIds.filter(id => id !== socketId)
  if (participant.socketIds.length > 0 || !participant.connected)
    return false
  participant.connected = false
  participant.visibility = 'closed'
  return true
}

/**
 * Fully deletes a participant's record — the presenter's "kick" action
 * (dashboard, `presenter:kickParticipant`). Deliberately a hard delete, not
 * the soft `removeParticipantSocket` close above: a merely-`closed`
 * participant can still silently auto-resume (their `participantId` remains
 * a valid resume token — see `joinParticipant`'s doc comment on why that's
 * intentional for the ordinary "closed the tab" case), which would make
 * "kick" meaningless — they'd just reappear the moment their browser
 * reconnects. Deleting the record outright means a later `participant:join`
 * with this id finds nothing to resume and falls through to an ordinary
 * fresh join instead (room code required again — `server.ts`'s
 * `isKnownResume` check). Their past `ErrorReport`s are left as-is
 * (append-only, no retention policy — same posture as every other mutator
 * in this file) — a kicked participant's prior help requests still show up
 * in the dashboard's history, just against a `participantId` that no longer
 * resolves to a live roster row.
 *
 * Returns the removed participant (so the caller can read its `socketIds`
 * to actually disconnect them — see `server.ts`'s handler), or `undefined`
 * for an unknown id — a no-op, not an error, same "trust the caller"
 * posture as every other mutator here. A participant id belonging to a
 * different* room is an unknown id here, so a presenter can only ever kick
 * their own room's participants (plan 032a).
 */
export function removeParticipant(room: RoomState, participantId: string): Participant | undefined {
  const participant = room.participants.get(participantId)
  if (!participant)
    return undefined
  room.participants.delete(participantId)
  return participant
}

export function setStepStatus(room: RoomState, participantId: string, stepId: string, state: StepState): void {
  room.stepStatus.set(`${participantId}:${stepId}`, { state, updatedAt: Date.now() })
}

export interface StepStatusEntry {
  participantId: string
  stepId: string
  state: StepState
  /**
   * When this `(participantId, stepId)` pair last changed state — added so
   * the dashboard can show "how long since they clicked Copy" as a
   * check-in-with-them signal (a participant sitting in `'copied'` for a
   * long time, never reaching `'done'`, is exactly who the instructor wants
   * to notice without walking over). Set fresh on every `setStepStatus`
   * call, including a `'copied'` → `'copied'` no-op call (there isn't one —
   * copy/done only ever fire on an actual click) and a state transition
   * (`'copied'` → `'done'`), so "time since last change" is always accurate,
   * not just "time since first copy".
   */
  updatedAt: number
}

export function listStepStatus(room: RoomState): StepStatusEntry[] {
  return [...room.stepStatus.entries()].map(([key, value]) => {
    const separatorIndex = key.indexOf(':')
    return {
      participantId: key.slice(0, separatorIndex),
      stepId: key.slice(separatorIndex + 1),
      state: value.state,
      updatedAt: value.updatedAt,
    }
  })
}

/**
 * What kind of help a report represents — the "Ask for Help" redesign's
 * addition on top of M3's error-only shape. `'problem'` is the original
 * report-a-problem flow (screenshot-eligible); `'question'` is the new
 * text-only "ask a question" flow (`ErrorReportWidget.vue`'s two tabs).
 * Both share every other field and the entire resolve/confirm state
 * machine below — a question is answered exactly the way a problem is
 * resolved, just tagged differently for the feed's icon/label.
 */
export type HelpRequestKind = 'problem' | 'question'

/**
 * The two-way follow-up redesign's state machine, replacing the old bare
 * `resolved: boolean`:
 *
 * - `'open'`: freshly submitted, nothing sent back yet.
 * - `'awaiting_confirmation'`: the presenter marked it resolved (optionally
 *   with a message) and is waiting on the participant to say whether that
 *   actually fixed it — see `resolveErrorReport` below.
 * - `'resolved'`: the participant confirmed it — the end state.
 * - `'reopened'`: the participant said "still need help" (or something
 *   else) instead of confirming — back in the presenter's queue for
 *   attention, same as `'open'`, but visibly distinct so the dashboard can
 *   say *why* it's back rather than looking like a fresh report.
 */
export type HelpRequestStatus = 'open' | 'awaiting_confirmation' | 'resolved' | 'reopened'

/**
 * One entry in a report's back-and-forth — the "message box" redesign's
 * actual payload. Ordered, append-only, rendered as a chat thread by both
 * the dashboard and the widget's resolution card. Deliberately doesn't
 * carry an id: messages are never edited or targeted individually, only
 * ever appended and read in order.
 */
export interface ThreadMessage {
  from: 'participant' | 'presenter'
  text: string
  ts: number
}

/**
 * Cap (in UTF-16 code units) for any free-text field a socket can push into
 * this process's unbounded, in-memory, append-only state: an `ErrorReport`'s
 * `text`, or a `thread` entry's `text` (`resolveErrorReport`'s/
 * `confirmResolution`'s optional `message`, `addPresenterMessage`/
 * `addParticipantMessage`'s `text`). Flagged as informational in a prior
 * review and left unfixed — closed here: a participant or presenter who
 * already holds a valid code (nothing here is behind a *content* check, only
 * an identity one) could otherwise `socket.emit` an arbitrarily large string
 * indefinitely, with no eviction, straight into memory. 4000 characters is
 * comfortably more than any real error description or chat reply typed into
 * this UI's own textareas (`ErrorReportWidget.vue`'s `rows="2"`/`rows="3"`
 * boxes, which impose no client-side `maxlength` of their own — and
 * wouldn't be a security boundary even if they did, since nothing stops a
 * scripted `socket.emit` from bypassing the addon's UI entirely) while still
 * bounding the worst case per message.
 */
export const MAX_TEXT_LENGTH = 4000

/**
 * Truncates (never throws/rejects) a piece of free text to `MAX_TEXT_LENGTH`
 * — used for `ErrorReport.text`, the *original* report submission, which
 * (unlike thread messages) is never trimmed, so this only ever caps length,
 * nothing else.
 */
function capText(text: string): string {
  return text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text
}

/**
 * Trims and caps an optional message before it's considered for appending to
 * a `thread` — the shared "is there anything real here, and if so, how much
 * of it do we keep" check every thread-appending mutator below uses
 * (`resolveErrorReport`, `addPresenterMessage`, `addParticipantMessage`,
 * `confirmResolution`). Returns `undefined` for a blank/whitespace-only
 * input, same as each mutator's own pre-existing `trimmed` check — this just
 * adds the length cap on top without changing that behavior.
 */
function sanitizeMessage(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  if (!trimmed)
    return undefined
  return capText(trimmed)
}

/**
 * Adds a new `ErrorReport` to one room's append-only feed. Callers pass
 * everything but `status`/`thread` — a freshly-reported request always
 * starts `'open'` with an empty thread; nothing in this codebase ever
 * creates one pre-resolved or pre-seeded with messages. `text`, if present,
 * is capped at `MAX_TEXT_LENGTH` — see that constant's own doc comment.
 *
 * The feed is append-only for the session's lifetime — no retention/cleanup
 * policy (plan 028's explicit out-of-scope call: no cross-restart
 * persistence requirement in the PRD, §4 non-goals). Under plan 032a it is
 * bounded by the session rather than by the process: `destroySession` is
 * what finally releases it.
 */
export function addErrorReport(room: RoomState, report: Omit<ErrorReport, 'status' | 'thread'>): ErrorReport {
  const full: ErrorReport = {
    ...report,
    text: report.text !== undefined ? capText(report.text) : report.text,
    status: 'open',
    thread: [],
  }
  room.errorReports.push(full)
  return full
}

function findReport(room: RoomState, errorId: string): ErrorReport | undefined {
  return room.errorReports.find(r => r.id === errorId)
}

/**
 * The presenter's "Mark resolved" action (dashboard, plan 028 Step 3;
 * redesigned to require confirmation rather than resolving outright). Moves
 * the report to `'awaiting_confirmation'` — never straight to `'resolved'`
 * — so the participant gets the final say on whether it actually fixed
 * their problem (the whole point of the confirm/reopen redesign; see
 * `confirmResolution` below for the other half). An optional message is
 * appended to `thread` as a presenter message, same as a plain
 * `addPresenterMessage` call.
 *
 * Returns the updated report (so the caller can read `participantId` to
 * notify that participant back — see `server.ts`'s handler — without a
 * second lookup), or `undefined` if no report matched — an unknown
 * `errorId` is a no-op, not an error, mirroring `setStepStatus`'s "no-op
 * rather than a guess" precedent for a socket acting on an id it doesn't
 * recognize. An `errorId` belonging to a different room is an unknown id
 * here (plan 032a), so a presenter can only ever act on their own room's
 * reports even if they somehow learn another room's report id.
 */
export function resolveErrorReport(room: RoomState, errorId: string, message?: string): ErrorReport | undefined {
  const report = findReport(room, errorId)
  if (!report)
    return undefined
  report.status = 'awaiting_confirmation'
  const sanitized = sanitizeMessage(message)
  if (sanitized)
    report.thread.push({ from: 'presenter', text: sanitized, ts: Date.now() })
  return report
}

/**
 * Appends a presenter reply to a report's thread *without* touching its
 * status — the "message box" redesign's plain reply, for "still looking
 * into it" / answering a question / following up before (or instead of)
 * ever marking it resolved. A blank/whitespace-only message is a no-op:
 * there's nothing to append.
 */
export function addPresenterMessage(room: RoomState, errorId: string, text: string): ErrorReport | undefined {
  const report = findReport(room, errorId)
  const sanitized = sanitizeMessage(text)
  if (!report || !sanitized)
    return undefined
  report.thread.push({ from: 'presenter', text: sanitized, ts: Date.now() })
  return report
}

/**
 * Appends a participant's follow-up to a report's thread — asking a further
 * question on an already-open ticket, or adding detail — without touching
 * status. Confirming or reopening in response to a resolution offer is
 * `confirmResolution` below, not this: that's a status transition, this
 * never is.
 */
export function addParticipantMessage(room: RoomState, errorId: string, text: string): ErrorReport | undefined {
  const report = findReport(room, errorId)
  const sanitized = sanitizeMessage(text)
  if (!report || !sanitized)
    return undefined
  report.thread.push({ from: 'participant', text: sanitized, ts: Date.now() })
  return report
}

/**
 * The participant's half of the confirm/reopen redesign: their answer to
 * "did that actually fix it?" after the presenter marked a report
 * `'awaiting_confirmation'`. `confirmed: true` moves it to the `'resolved'`
 * end state; `confirmed: false` moves it to `'reopened'` — back in the
 * presenter's queue, distinguishable from a fresh `'open'` report. Not
 * restricted to only firing from `'awaiting_confirmation'` — a participant
 * confirming/reopening is always taken at face value regardless of the
 * report's current status, same "trust the caller, no-op on unknown id"
 * posture as every other mutator here; `server.ts`'s handler is what
 * actually restricts *who* may call this (the reporting participant only).
 * An optional message is appended as a participant thread message either
 * way.
 */
export function confirmResolution(room: RoomState, errorId: string, confirmed: boolean, message?: string): ErrorReport | undefined {
  const report = findReport(room, errorId)
  if (!report)
    return undefined
  report.status = confirmed ? 'resolved' : 'reopened'
  const sanitized = sanitizeMessage(message)
  if (sanitized)
    report.thread.push({ from: 'participant', text: sanitized, ts: Date.now() })
  return report
}

// Copies the array, same as `listPendingConnections`/`listStepStatus` above
// — returning the live `room.errorReports` array itself would let a caller
// mutate the master list by e.g. `.push()`-ing onto the returned value
// directly, bypassing `addErrorReport`. The `ErrorReport` objects *inside*
// the copy are still the real, shared, in-place-mutated records (finding
// one and pushing onto its own `thread` is exactly how every mutator above
// works) — only the array's own identity is protected here, matching the
// existing "trust the caller with the records themselves" posture.
export function listErrorReports(room: RoomState): ErrorReport[] {
  return [...room.errorReports]
}

/**
 * Finds the room a given participant id belongs to, scanning every live
 * session. The one place in this module that deliberately searches *across*
 * rooms rather than within one, and it exists for exactly one caller:
 * `POST /api/screenshot` (`screenshotUpload.ts`), whose multipart body
 * carries a `participantId` but no room information.
 *
 * That's safe to resolve this way — unlike `participant:connecting`, which
 * genuinely has no identity yet and therefore needed a new wire-contract
 * room hint (see `server.ts`'s `roomOf`) — because a `participantId` is
 * a 122-bit `crypto.randomUUID()` minted server-side at join time (see
 * `joinParticipant`), so it is globally unique across rooms by construction
 * and unambiguously names the room that minted it. The endpoint's
 * authorization is unchanged by this: it accepted exactly one credential
 * before (a `participantId` the server recognizes) and accepts exactly the
 * same one now — the lookup just also tells it *which* room's uploads
 * directory and error feed the report belongs in, instead of assuming the
 * single process-wide one.
 *
 * Returns `undefined` for an unknown id, which the caller turns into the
 * same `400 unknown participantId` it has always returned.
 */
export function findRoomByParticipantId(participantId: string): RoomState | undefined {
  for (const room of rooms.values()) {
    if (room.participants.has(participantId))
      return room
  }
  return undefined
}

/**
 * Drops every live session. Test-only: production never needs to reset a
 * running server's state; `beforeEach` in `server.test.ts`/`session.test.ts`
 * uses this so tests don't leak state into each other via the module-level
 * `rooms` map.
 *
 * Under plan 032a this replaced a function that reset the *fields* of the
 * one singleton session (slide index, step id, participants, …) — with state
 * keyed by room there is no singleton to reset, and clearing the map is both
 * simpler and stricter: a test can't accidentally inherit a room a previous
 * test created under a different code.
 */
export function resetSessionStateForTests(): void {
  rooms.clear()
}
