export interface WorkshopSession {
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

// Singleton in-memory session (multi-session is out of scope — PRD §14/§4).
export const session: WorkshopSession = {
  id: 'default',
  currentSlideIndex: 1,
  createdAt: Date.now(),
  currentStepId: '1',
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

export const stepStatus = new Map<string, StepStatusValue>()
export const participants = new Map<string, Participant>()

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
 */
export interface PendingConnection {
  socketId: string
  connectedAt: number
}

export const pendingConnections = new Map<string, PendingConnection>()

export function addPendingConnection(socketId: string, now: number = Date.now()): void {
  pendingConnections.set(socketId, { socketId, connectedAt: now })
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
export function removePendingConnection(socketId: string): boolean {
  return pendingConnections.delete(socketId)
}

export function listPendingConnections(): PendingConnection[] {
  return [...pendingConnections.values()]
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
 */
export function joinParticipant(name: string, existingId: string | undefined, generateId: () => string, socketId: string): JoinResult {
  const now = Date.now()
  const existing = existingId ? participants.get(existingId) : undefined

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
  participants.set(participant.id, participant)
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
export function removeParticipantSocket(participantId: string, socketId: string): boolean {
  const participant = participants.get(participantId)
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
 * posture as every other mutator here.
 */
export function removeParticipant(participantId: string): Participant | undefined {
  const participant = participants.get(participantId)
  if (!participant)
    return undefined
  participants.delete(participantId)
  return participant
}

export function setStepStatus(participantId: string, stepId: string, state: StepState): void {
  stepStatus.set(`${participantId}:${stepId}`, { state, updatedAt: Date.now() })
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

export function listStepStatus(): StepStatusEntry[] {
  return [...stepStatus.entries()].map(([key, value]) => {
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

// Append-only for the session's lifetime — no retention/cleanup policy
// (plan 028's explicit out-of-scope call: no cross-restart persistence
// requirement in the PRD, §4 non-goals).
export const errorReports: ErrorReport[] = []

/**
 * Adds a new `ErrorReport`. Callers pass everything but `status`/`thread` —
 * a freshly-reported request always starts `'open'` with an empty thread;
 * nothing in this codebase ever creates one pre-resolved or pre-seeded with
 * messages.
 */
export function addErrorReport(report: Omit<ErrorReport, 'status' | 'thread'>): ErrorReport {
  const full: ErrorReport = { ...report, status: 'open', thread: [] }
  errorReports.push(full)
  return full
}

function findReport(errorId: string): ErrorReport | undefined {
  return errorReports.find(r => r.id === errorId)
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
 * recognize.
 */
export function resolveErrorReport(errorId: string, message?: string): ErrorReport | undefined {
  const report = findReport(errorId)
  if (!report)
    return undefined
  report.status = 'awaiting_confirmation'
  const trimmed = message?.trim()
  if (trimmed)
    report.thread.push({ from: 'presenter', text: trimmed, ts: Date.now() })
  return report
}

/**
 * Appends a presenter reply to a report's thread *without* touching its
 * status — the "message box" redesign's plain reply, for "still looking
 * into it" / answering a question / following up before (or instead of)
 * ever marking it resolved. A blank/whitespace-only message is a no-op:
 * there's nothing to append.
 */
export function addPresenterMessage(errorId: string, text: string): ErrorReport | undefined {
  const report = findReport(errorId)
  const trimmed = text.trim()
  if (!report || !trimmed)
    return undefined
  report.thread.push({ from: 'presenter', text: trimmed, ts: Date.now() })
  return report
}

/**
 * Appends a participant's follow-up to a report's thread — asking a further
 * question on an already-open ticket, or adding detail — without touching
 * status. Confirming or reopening in response to a resolution offer is
 * `confirmResolution` below, not this: that's a status transition, this
 * never is.
 */
export function addParticipantMessage(errorId: string, text: string): ErrorReport | undefined {
  const report = findReport(errorId)
  const trimmed = text.trim()
  if (!report || !trimmed)
    return undefined
  report.thread.push({ from: 'participant', text: trimmed, ts: Date.now() })
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
export function confirmResolution(errorId: string, confirmed: boolean, message?: string): ErrorReport | undefined {
  const report = findReport(errorId)
  if (!report)
    return undefined
  report.status = confirmed ? 'resolved' : 'reopened'
  const trimmed = message?.trim()
  if (trimmed)
    report.thread.push({ from: 'participant', text: trimmed, ts: Date.now() })
  return report
}

// Copies the array, same as `listPendingConnections`/`listStepStatus` above
// — returning the live `errorReports` array itself would let a caller
// mutate the master list by e.g. `.push()`-ing onto the returned value
// directly, bypassing `addErrorReport`. The `ErrorReport` objects *inside*
// the copy are still the real, shared, in-place-mutated records (finding
// one and pushing onto its own `thread` is exactly how every mutator above
// works) — only the array's own identity is protected here, matching the
// existing "trust the caller with the records themselves" posture.
export function listErrorReports(): ErrorReport[] {
  return [...errorReports]
}

/**
 * Resets all M2/M3 state — participants, step status, current step id, and
 * error reports — back to a fresh session. Test-only: production never
 * needs to reset a running server's state; `beforeEach` in `server.test.ts`
 * uses this so tests don't leak state into each other via these singleton
 * maps/arrays (mirroring how M1's tests reset `session.currentSlideIndex`
 * directly).
 */
export function resetSessionStateForTests(): void {
  session.currentSlideIndex = 1
  session.currentStepId = '1'
  participants.clear()
  pendingConnections.clear()
  stepStatus.clear()
  errorReports.length = 0
}
