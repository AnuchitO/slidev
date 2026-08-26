import { describe, expect, it } from 'vitest'
import { resolveJoinAckOutcome } from './participantIdentity'

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
