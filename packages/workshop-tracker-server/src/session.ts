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
 * Finds an existing participant by a client-supplied id (from
 * `sessionStorage`, see the addon's `JoinScreen.vue`) and refreshes it, or
 * creates a new one with a fresh server-assigned id. Never trusts a
 * client-supplied id as the id of a *new* record — only reuses it to look up
 * an *existing* one — so a stale/guessed id can't be used to plant a record
 * under an attacker-chosen key.
 */
export function joinParticipant(name: string, existingId: string | undefined, generateId: () => string, socketId: string): Participant {
  const now = Date.now()
  const existing = existingId ? participants.get(existingId) : undefined

  if (existing) {
    existing.name = name
    existing.connected = true
    existing.lastSeen = now
    // A (re)join always means the tab is frontmost/interactive again — reset
    // visibility to 'visible' rather than leaving a stale 'hidden'/'closed'
    // from before the reconnect, and re-point socketId at the new socket.
    existing.visibility = 'visible'
    existing.socketId = socketId
    return existing
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
  return participant
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
 * Resets all M2 state — participants, step status, and the current step id
 * — back to a fresh session. Test-only: production never needs to reset a
 * running server's state; `beforeEach` in `server.test.ts` uses this so
 * tests don't leak participant/step state into each other via these
 * singleton maps (mirroring how M1's tests reset `session.currentSlideIndex`
 * directly).
 */
export function resetSessionStateForTests(): void {
  session.currentSlideIndex = 1
  session.currentStepId = '1'
  participants.clear()
  stepStatus.clear()
}
