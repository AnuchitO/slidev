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
   * The Socket.io socket id this participant is currently attached to.
   * Needed by `presence.ts`'s staleness sweep to ask "is the socket this
   * participant last spoke through still actually connected" without that
   * module reaching into `io.sockets.sockets` itself (kept injectable/pure
   * for testing — see `presence.test.ts`). Updated on every
   * `participant:join` (including a rejoin on a new socket after a
   * reconnect).
   */
  socketId: string
}

// Keyed as `${participantId}:${stepId}`.
export const stepStatus = new Map<string, StepState>()
export const participants = new Map<string, Participant>()

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
 * `sessionStorage`, see the addon's `JoinScreen.vue`) and refreshes it, or
 * creates a new one with a fresh server-assigned id. Never trusts a
 * client-supplied id as the id of a *new* record — only reuses it to look up
 * an *existing* one — so a stale/guessed id can't be used to plant a record
 * under an attacker-chosen key.
 *
 * Resume is bound to two things an attacker can't cheaply obtain together:
 * the participant room code (checked by the caller, `server.ts`, before this
 * function ever runs) and this specific `existingId` — a 122-bit
 * `crypto.randomUUID()` minted at original join time (see `server.ts`'s
 * `participant:join` handler) that's never broadcast to other participant
 * sockets (only to the presenter-code-gated dashboard room). That combination
 * is, in effect, an unguessable bearer resume token scoped to one browser
 * tab's `sessionStorage` — not a plain "trust whatever id shows up" design
 * (plan 030's STOP condition on resume hijacking).
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
    // A (re)join always means the tab is frontmost/interactive again — reset
    // visibility to 'visible' rather than leaving a stale 'hidden'/'closed'
    // from before the reconnect, and re-point socketId at the new socket.
    existing.visibility = 'visible'
    existing.socketId = socketId
    return { participant: existing, outcome: 'resumed' }
  }

  const participant: Participant = {
    id: generateId(),
    name,
    joinedAt: now,
    lastSeen: now,
    connected: true,
    visibility: 'visible',
    socketId,
  }
  participants.set(participant.id, participant)
  return { participant, outcome: existingId ? 'resume-fallback' : 'fresh' }
}

export function setStepStatus(participantId: string, stepId: string, state: StepState): void {
  stepStatus.set(`${participantId}:${stepId}`, state)
}

export interface StepStatusEntry {
  participantId: string
  stepId: string
  state: StepState
}

export function listStepStatus(): StepStatusEntry[] {
  return [...stepStatus.entries()].map(([key, state]) => {
    const separatorIndex = key.indexOf(':')
    return {
      participantId: key.slice(0, separatorIndex),
      stepId: key.slice(separatorIndex + 1),
      state,
    }
  })
}

/**
 * `ErrorReport` (PRD §9, plan 028 Step 1): a participant's text and/or
 * screenshot report tied to `participantId`/`stepId`. `resolved` is a M3
 * addition on top of the PRD's literal shape — the dashboard's
 * mark-resolved action (plan 028 Step 3) needs somewhere server-side to
 * live so resolved state survives a dashboard page reload, per that step's
 * own verification note.
 */
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

// Append-only for the session's lifetime — no retention/cleanup policy
// (plan 028's explicit out-of-scope call: no cross-restart persistence
// requirement in the PRD, §4 non-goals).
export const errorReports: ErrorReport[] = []

/**
 * Adds a new `ErrorReport`. Callers pass everything but `resolved` — a
 * freshly-reported error always starts unresolved; nothing in this plan's
 * scope ever creates one pre-resolved.
 */
export function addErrorReport(report: Omit<ErrorReport, 'resolved'>): ErrorReport {
  const full: ErrorReport = { ...report, resolved: false }
  errorReports.push(full)
  return full
}

/**
 * Marks a report resolved by id (the dashboard's `presenter:resolveError`
 * handler, plan 028 Step 3). Returns whether a matching report was found —
 * an unknown `errorId` is a no-op, not an error, mirroring `setStepStatus`'s
 * "no-op rather than a guess" precedent for a socket acting on an id it
 * doesn't recognize.
 */
export function resolveErrorReport(errorId: string): boolean {
  const report = errorReports.find(r => r.id === errorId)
  if (!report)
    return false
  report.resolved = true
  return true
}

export function listErrorReports(): ErrorReport[] {
  return errorReports
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
  stepStatus.clear()
  errorReports.length = 0
}
