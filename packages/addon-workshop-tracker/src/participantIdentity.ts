import { ref } from 'vue'

export const PARTICIPANT_STORAGE_KEY = 'workshop-tracker:participant'

export interface StoredParticipant {
  participantId: string
  name: string
  /**
   * Persisted alongside identity (plan 029) so a reload — same tab, or a
   * closed-and-reopened tab (see this module's own doc comment below) — can
   * auto-rejoin without re-prompting for the code — this is the low(er)-
   * privilege participant room code (PRD §12), not the presenter
   * credential, so localStorage is an acceptable place for it (unlike the
   * presenter code — see `presenterCode.ts`'s comment on why *that* one is
   * never persisted/embedded anywhere).
   */
  roomCode: string
}

/**
 * Storage backend for `StoredParticipant`. A follow-on fix to plan 030: this
 * was originally `sessionStorage` (tab-scoped, cleared the instant its tab
 * closes), which quietly broke the "resume without re-joining" story plan
 * 030 built — a participant who closed and reopened their *tab* (same
 * browser, same device, not just a same-tab refresh) got no stored value to
 * read on the new tab's mount, so they joined as a brand-new participant:
 * lost step-status history, and a duplicate row on the instructor's
 * dashboard. `localStorage` is same-origin but *not* tab-scoped — it
 * persists across a closed tab, a closed browser, even a machine restart,
 * until something explicitly clears it (this module's own
 * `clearStoredParticipant`, or the browser's site-data controls). The
 * threat-model reasoning above (a low-privilege room code + an unguessable
 * server-minted id, never the presenter credential) is unaffected by the
 * storage swap — what changes is only *how long* it's retained and *what
 * physical-browser scenario* that retention now covers; see
 * `JoinScreen.vue`'s "Not you? Join as someone else" affordance for the one
 * new consequence this introduces (a shared/kiosk browser silently
 * resuming the previous person's identity).
 */
export function readStoredParticipant(): StoredParticipant | undefined {
  try {
    const raw = localStorage.getItem(PARTICIPANT_STORAGE_KEY)
    if (!raw)
      return undefined
    const parsed = JSON.parse(raw)
    if (typeof parsed?.participantId === 'string' && typeof parsed?.name === 'string' && typeof parsed?.roomCode === 'string')
      return parsed
    return undefined
  }
  catch {
    // localStorage can throw (private browsing, disabled storage) — treat
    // the same as "nothing stored".
    return undefined
  }
}

export function writeStoredParticipant(participant: StoredParticipant): void {
  try {
    localStorage.setItem(PARTICIPANT_STORAGE_KEY, JSON.stringify(participant))
  }
  catch {
    // Best-effort only — resume/reconnect degrades to "always join fresh"
    // rather than failing outright if storage is unavailable or full.
  }
}

/**
 * Clears a stored participant. Used when a *requested* resume fails (see
 * `resolveJoinAckOutcome` below) — the stale id is no longer good for
 * anything, so `JoinScreen.vue` drops it rather than re-attempting it on a
 * future mount — and when the participant explicitly asks to stop resuming
 * as whoever this browser last remembered (`JoinScreen.vue`'s "Not you?
 * Join as someone else" link, added alongside the sessionStorage→localStorage
 * switch above precisely because localStorage no longer clears itself when
 * a tab closes).
 */
export function clearStoredParticipant(): void {
  try {
    localStorage.removeItem(PARTICIPANT_STORAGE_KEY)
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
