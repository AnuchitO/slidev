import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearStoredParticipant,
  PARTICIPANT_STORAGE_KEY,
  readStoredParticipant,
  resolveJoinAckOutcome,
  shouldOfferJoinAsSomeoneElse,
  writeStoredParticipant,
} from './participantIdentity'

// Follow-on to plan 030: a real workshop-tracker bug report showed a
// participant who closed and reopened their tab (same browser, same
// device — not just a same-tab refresh) got treated as brand new, losing
// their step-status history and showing as a duplicate row on the
// dashboard. Root cause: this module persisted to `sessionStorage`, which
// is cleared the moment its tab closes. `localStorage` (same-origin, same
// browser, persists until explicitly cleared) fixes it — these tests drive
// that change against a *real* `localStorage` (this package's
// `vitest.config.ts` sets `environment: 'jsdom'` for exactly this reason;
// the default `'node'` environment has no global `localStorage` at all, and
// the try/catch below would silently treat a `ReferenceError` as "nothing
// stored", never actually exercising this read/write/clear cycle).
describe('readStoredParticipant / writeStoredParticipant / clearStoredParticipant (localStorage)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns undefined when nothing has been stored', () => {
    expect(readStoredParticipant()).toBeUndefined()
  })

  it('round-trips a written participant through localStorage', () => {
    const participant = { participantId: 'p1', name: 'Ada', roomCode: 'ROOM1' }
    writeStoredParticipant(participant)
    expect(readStoredParticipant()).toEqual(participant)
  })

  it('persists in localStorage directly under PARTICIPANT_STORAGE_KEY, not sessionStorage', () => {
    const participant = { participantId: 'p1', name: 'Ada', roomCode: 'ROOM1' }
    writeStoredParticipant(participant)
    // This is the crux of the bug fix: a value that survives in
    // `localStorage` after the write is what lets a *closed-and-reopened*
    // tab resume, since `sessionStorage` is gone the instant its tab closes
    // (and thus could never be inspected here across a "close" at all).
    expect(localStorage.getItem(PARTICIPANT_STORAGE_KEY)).toBe(JSON.stringify(participant))
    expect(sessionStorage.getItem(PARTICIPANT_STORAGE_KEY)).toBeNull()
  })

  it('clearStoredParticipant removes the value so a later read is undefined', () => {
    writeStoredParticipant({ participantId: 'p1', name: 'Ada', roomCode: 'ROOM1' })
    clearStoredParticipant()
    expect(readStoredParticipant()).toBeUndefined()
    expect(localStorage.getItem(PARTICIPANT_STORAGE_KEY)).toBeNull()
  })

  it('treats malformed stored JSON as "nothing stored" rather than throwing', () => {
    localStorage.setItem(PARTICIPANT_STORAGE_KEY, '{not valid json')
    expect(readStoredParticipant()).toBeUndefined()
  })

  it('treats a stored value missing required fields as "nothing stored"', () => {
    localStorage.setItem(PARTICIPANT_STORAGE_KEY, JSON.stringify({ participantId: 'p1' }))
    expect(readStoredParticipant()).toBeUndefined()
  })
})

// Plan 030 (M5): the addon's `JoinScreen.vue` needs to tell a *successful*
// resume (skip the join prompt entirely) apart from a resume attempt that
// silently fell back to a fresh identity (e.g. the server restarted and no
// longer recognizes the stored `participantId` — PRD §4/§14's accepted
// in-memory-reset case) — in that case the join prompt must reappear rather
// than quietly rejoining as a "new" participant behind an unchanged UI, per
// plan 030 Step 1's own verify note. Pulled out as a pure function (matching
// this package's `presenterCode.ts`/`stepId.ts` precedent) so the decision
// is unit-testable without mounting the component.
describe('resolveJoinAckOutcome', () => {
  it('is "joined" for a first-time join (no participantId was requested)', () => {
    expect(resolveJoinAckOutcome(undefined, { participantId: 'p1', currentSlideIndex: 1, resumed: false })).toBe('joined')
  })

  it('is "joined" when the server confirms the resume (ack.resumed is true)', () => {
    expect(resolveJoinAckOutcome('p1', { participantId: 'p1', currentSlideIndex: 3, resumed: true })).toBe('joined')
  })

  it('is "resume-failed" when a resume was requested but the server minted a different id (resumed: false)', () => {
    expect(resolveJoinAckOutcome('stale-id', { participantId: 'p2', currentSlideIndex: 1, resumed: false })).toBe('resume-failed')
  })
})

// Follow-on to plan 030: the localStorage switch (participantIdentity.ts's
// doc comment) means a shared/kiosk browser can now silently resume a
// *previous* person's identity indefinitely (localStorage, unlike
// sessionStorage, doesn't clear itself when a tab closes). JoinScreen.vue's
// "Not you? Join as someone else" link is the way out — this decides when
// it's actually offered, pulled into a pure function for the same reason as
// `resolveJoinAckOutcome` above.
describe('shouldOfferJoinAsSomeoneElse', () => {
  it('is false for a first-time join (no participantId was requested)', () => {
    expect(shouldOfferJoinAsSomeoneElse(undefined, { participantId: 'p1', currentSlideIndex: 1, resumed: false })).toBe(false)
  })

  it('is true once the server confirms a requested id was actually resumed', () => {
    expect(shouldOfferJoinAsSomeoneElse('p1', { participantId: 'p1', currentSlideIndex: 3, resumed: true })).toBe(true)
  })

  it('is false when a participantId was requested but the server did not resume it (fresh/fallback)', () => {
    expect(shouldOfferJoinAsSomeoneElse('stale-id', { participantId: 'p2', currentSlideIndex: 1, resumed: false })).toBe(false)
  })
})
