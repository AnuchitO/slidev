import { ref } from 'vue'

export const PARTICIPANT_STORAGE_KEY = 'slidev-muan-companion:participant'

export interface StoredParticipant {
  participantId: string
  name: string
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
 * `clearStoredParticipant`, or the browser's site-data controls). See
 * `JoinScreen.vue`'s "Not you? Join as someone else" affordance for the one
 * consequence that introduces (a shared/kiosk browser silently resuming the
 * previous person's identity).
 *
 * Deliberately does **not** persist the room code, even though it's a low-
 * privilege value (PRD §12) — a second follow-up fix, this time to close a
 * different gap: indefinitely caching a workshop-scoped code in a browser's
 * storage is unnecessary standing exposure with no real benefit, since a
 * resume of an *already-known* identity doesn't actually need the room code
 * at all — the unguessable `participantId` this struct carries is itself
 * the resume credential (see `slidev-muan-companion-server`'s `session.ts` /
 * `server.ts` for the server-side half of this). The room code is only ever
 * asked for again on a genuinely *fresh* join, or the rare case where a
 * resume attempt fails (e.g. the server restarted) — both go through
 * `JoinScreen.vue`'s ordinary join form, never through storage.
 */
export function readStoredParticipant(): StoredParticipant | undefined {
  try {
    const raw = localStorage.getItem(PARTICIPANT_STORAGE_KEY)
    if (!raw)
      return undefined
    const parsed = JSON.parse(raw)
    if (typeof parsed?.participantId === 'string' && typeof parsed?.name === 'string')
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
  /** See `slidev-muan-companion-server`'s `participant:join` handler / README. */
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
 * Whether `JoinScreen.vue` should offer its "Not you? Join as someone else"
 * link after this join — true only for a genuine resume of an *already-
 * known* identity (a `participantId` was supplied, e.g. from the localStorage
 * value read on mount, or from a previous attempt's resume-fallback id — see
 * `pendingParticipantId` there — and the server actually resumed it), never
 * for a name/room-code the participant just typed for the first time.
 *
 * A follow-on to the sessionStorage→localStorage switch (see this module's
 * storage-backend doc comment above): localStorage doesn't clear itself when
 * a tab closes, so a shared/kiosk browser would otherwise resume the
 * previous person's identity with no way to say "that's not me" — this
 * link is that way out, and this function decides when it's warranted.
 * Pulled out as a pure function (matching `resolveJoinAckOutcome` just
 * above) so the decision is unit-testable without mounting the component.
 */
export function shouldOfferJoinAsSomeoneElse(requestedParticipantId: string | undefined, ack: JoinAck): boolean {
  return Boolean(requestedParticipantId) && ack.resumed
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
