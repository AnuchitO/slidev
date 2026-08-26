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
 * The current browser tab's joined participant, once `JoinScreen.vue` gets
 * a `participant:join` ack — a module-scope singleton `ref`, same pattern
 * as `client.ts`'s shared socket, so `ErrorReportWidget.vue` (plan 028)
 * knows who to attach an error report to without its own join flow or
 * prop-drilling from `JoinScreen.vue`. `undefined` until joined; still
 * `undefined` forever on the presenter route (`JoinScreen.vue` never joins
 * there).
 */
export const currentParticipant = ref<StoredParticipant | undefined>()
