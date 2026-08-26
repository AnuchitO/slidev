import { ref } from 'vue'

export const PARTICIPANT_STORAGE_KEY = 'workshop-tracker:participant'

export interface StoredParticipant {
  participantId: string
  name: string
  /**
   * Persisted alongside identity (plan 029) so a same-tab reload can
   * auto-rejoin without re-prompting for the code — this is the low(er)-
   * privilege participant room code (PRD §12), not the presenter
   * credential, so sessionStorage is an acceptable place for it (unlike the
   * presenter code — see `presenterCode.ts`'s comment on why *that* one is
   * never persisted/embedded anywhere).
   */
  roomCode: string
}

export function readStoredParticipant(): StoredParticipant | undefined {
  try {
    const raw = sessionStorage.getItem(PARTICIPANT_STORAGE_KEY)
    if (!raw)
      return undefined
    const parsed = JSON.parse(raw)
    if (typeof parsed?.participantId === 'string' && typeof parsed?.name === 'string' && typeof parsed?.roomCode === 'string')
      return parsed
    return undefined
  }
  catch {
    // sessionStorage can throw (private browsing, disabled storage) — treat
    // the same as "nothing stored".
    return undefined
  }
}

export function writeStoredParticipant(participant: StoredParticipant): void {
  try {
    sessionStorage.setItem(PARTICIPANT_STORAGE_KEY, JSON.stringify(participant))
  }
  catch {
    // Best-effort only — 030's fuller reconnect/resume story can revisit if
    // this ever needs to be reliable rather than a nice-to-have.
  }
}

/**
 * Clears a stored participant (plan 030 Step 1). Used when a *requested*
 * resume fails (see `resolveJoinAckOutcome` below) — the stale id is no
 * longer good for anything, so `JoinScreen.vue` drops it rather than
 * re-attempting it on a future mount.
 */
export function clearStoredParticipant(): void {
  try {
    sessionStorage.removeItem(PARTICIPANT_STORAGE_KEY)
  }
  catch {
    // Same best-effort posture as writeStoredParticipant above.
  }
}

export interface JoinAck {
  participantId: string
  currentSlideIndex: number
  /** See `workshop-tracker-server`'s `participant:join` handler / README. */
  resumed: boolean
}

export type JoinAckOutcome = 'joined' | 'resume-failed'

/**
 * Decides whether a `participant:join` ack represents a successful resume
 * (or an ordinary first-time join) — both of which the join screen should
 * treat as "we're in, don't show the prompt" — versus a *requested* resume
 * (a `participantId` was supplied) that the server couldn't honor and fell
 * back on (PRD §4/§14's accepted server-restart/in-memory-reset case).
 *
 * Pulled out as a pure function (matching this package's `presenterCode.ts`/
 * `stepId.ts` precedent) so `JoinScreen.vue`'s resume-vs-fresh-join UI
 * decision (plan 030 Step 1) is unit-testable without mounting the
 * component. `ack.resumed` — not id comparison — is the source of truth
 * here; the server already knows definitively whether it revived an
 * existing record or minted a new one (`session.ts`'s `JoinOutcome`).
 */
export function resolveJoinAckOutcome(requestedParticipantId: string | undefined, ack: JoinAck): JoinAckOutcome {
  if (requestedParticipantId && !ack.resumed)
    return 'resume-failed'
  return 'joined'
}

/**
 * The current browser tab's joined participant, once `JoinScreen.vue` gets
 * a `participant:join` ack — a module-scope singleton `ref`, same pattern
 * as `client.ts`'s shared socket, so `ErrorReportWidget.vue` (plan 028)
 * knows who to attach an error report to without its own join flow or
 * prop-drilling from `JoinScreen.vue`. `undefined` until joined; still
 * `undefined` forever on the presenter route (`JoinScreen.vue` never joins
 * there).
 */
export const currentParticipant = ref<StoredParticipant | undefined>()
