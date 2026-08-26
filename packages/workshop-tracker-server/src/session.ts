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

export interface Participant {
  id: string
  name: string
  joinedAt: number
  lastSeen: number
  connected: boolean
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
export function joinParticipant(name: string, existingId: string | undefined, generateId: () => string): Participant {
  const now = Date.now()
  const existing = existingId ? participants.get(existingId) : undefined

  if (existing) {
    existing.name = name
    existing.connected = true
    existing.lastSeen = now
    return existing
  }

  const participant: Participant = {
    id: generateId(),
    name,
    joinedAt: now,
    lastSeen: now,
    connected: true,
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
