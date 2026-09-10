import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearFailedAttempts,
  CONNECT_KEY_LENGTH,
  CONNECT_KEY_TTL_MS,
  consumeConnectKey,
  isRateLimited,
  MAX_FAILED_ATTEMPTS,
  mintConnectKey,
  RATE_LIMIT_LOCKOUT_MS,
  RATE_LIMIT_WINDOW_MS,
  recordFailedAttempt,
  resetConnectKeyStateForTests,
} from './connectKey'
import { PRESENTER_CODE_LENGTH } from './session'

// A fixed instant every test works relative to, rather than real wall-clock
// time: every TTL/window assertion below is about *relative* offsets, and
// pinning the origin makes those offsets readable ("+ TTL + 1") instead of
// hiding behind a mocked global clock. Both `mintConnectKey` and
// `consumeConnectKey` take an injectable `now` for exactly this reason — the
// same rationale as `generateCode`'s injectable `random`.
const T0 = 1_700_000_000_000

describe('connectKey', () => {
  beforeEach(() => {
    resetConnectKeyStateForTests()
  })

  describe('mintConnectKey', () => {
    // Same alphabet assertion `codeGeneration.test.ts` uses, applied here to
    // pin down that connect keys go through the *shared* `generateCode` rather
    // than growing their own character set — one alphabet, one crypto source,
    // one place to review (see `mintConnectKey`'s doc comment).
    it('mints a key of CONNECT_KEY_LENGTH from the shared unambiguous alphabet', () => {
      const { key } = mintConnectKey({ now: T0 })
      expect(key).toHaveLength(CONNECT_KEY_LENGTH)
      expect(key).toMatch(/^[A-HJKMNP-Z2-9]+$/)
    })

    it('mints keys longer than the presenter code, per this credential\'s own entropy note', () => {
      expect(CONNECT_KEY_LENGTH).toBeGreaterThanOrEqual(PRESENTER_CODE_LENGTH)
    })

    it('sets expiresAt exactly CONNECT_KEY_TTL_MS after minting', () => {
      expect(mintConnectKey({ now: T0 }).expiresAt).toBe(T0 + CONNECT_KEY_TTL_MS)
    })

    it('mints independent keys — redeeming one leaves the other usable', () => {
      const first = mintConnectKey({ now: T0 })
      const second = mintConnectKey({ now: T0 })
      expect(first.key).not.toBe(second.key)
      expect(consumeConnectKey(first.key, T0)).toBe(true)
      expect(consumeConnectKey(second.key, T0)).toBe(true)
    })

    // The opportunistic sweep documented in `mintConnectKey` — without it a
    // long-lived process that mints keys nobody redeems grows `keys` forever.
    // Observable only indirectly (the map isn't exported, deliberately), so
    // this asserts the *behavior* that matters: a swept key is still refused.
    it('does not resurrect an expired key when a later mint sweeps the map', () => {
      const stale = mintConnectKey({ now: T0 })
      mintConnectKey({ now: T0 + CONNECT_KEY_TTL_MS + 1 })
      expect(consumeConnectKey(stale.key, T0 + CONNECT_KEY_TTL_MS + 1)).toBe(false)
    })
  })

  describe('consumeConnectKey', () => {
    it('accepts a freshly-minted key', () => {
      const { key } = mintConnectKey({ now: T0 })
      expect(consumeConnectKey(key, T0)).toBe(true)
    })

    it('accepts a key at the last instant before it expires', () => {
      const { key, expiresAt } = mintConnectKey({ now: T0 })
      expect(consumeConnectKey(key, expiresAt - 1)).toBe(true)
    })

    // Single use — the property that makes a leaked-but-already-redeemed key
    // worthless. Asserted *inside* the TTL so this can only be explained by
    // the burn, never by expiry.
    it('refuses a second attempt with the same key even well inside its TTL', () => {
      const { key } = mintConnectKey({ now: T0 })
      expect(consumeConnectKey(key, T0)).toBe(true)
      expect(consumeConnectKey(key, T0 + 1)).toBe(false)
    })

    it('refuses a key at its exact expiry instant and after', () => {
      const a = mintConnectKey({ now: T0 })
      expect(consumeConnectKey(a.key, a.expiresAt)).toBe(false)
      const b = mintConnectKey({ now: T0 })
      expect(consumeConnectKey(b.key, b.expiresAt + 60_000)).toBe(false)
    })

    it('refuses a key that never existed', () => {
      expect(consumeConnectKey('NEVERMINTED', T0)).toBe(false)
      expect(consumeConnectKey('', T0)).toBe(false)
    })

    // "Reveal nothing extra": the three failure modes are indistinguishable
    // to a caller. `consumeConnectKey` returns a plain boolean precisely so
    // there is no richer result type in which a reason could accidentally be
    // surfaced later — this test pins that down as a contract, not an
    // implementation accident.
    it('returns the identical failure value for expired, already-used, and never-existed keys', () => {
      const expired = mintConnectKey({ now: T0 })
      const used = mintConnectKey({ now: T0 })
      consumeConnectKey(used.key, T0)

      const expiredResult = consumeConnectKey(expired.key, expired.expiresAt + 1)
      const usedResult = consumeConnectKey(used.key, T0)
      const unknownResult = consumeConnectKey('NEVERMINTED', T0)

      expect(expiredResult).toBe(false)
      expect(usedResult).toBe(false)
      expect(unknownResult).toBe(false)
      expect(new Set([expiredResult, usedResult, unknownResult]).size).toBe(1)
    })

    // A key presented after expiry is *spent*, not merely ignored — see
    // `consumeConnectKey`'s own comment. Verified by the fact that a clock
    // that later moves backwards (NTP correction, a caller passing a stale
    // `now`) still can't redeem it.
    it('burns an expired key on presentation, so an earlier clock cannot redeem it afterwards', () => {
      const { key, expiresAt } = mintConnectKey({ now: T0 })
      expect(consumeConnectKey(key, expiresAt + 1)).toBe(false)
      expect(consumeConnectKey(key, T0)).toBe(false)
    })
  })

  describe('rate limiting', () => {
    const IP = '203.0.113.7'

    it('does not rate-limit a source that has never failed', () => {
      expect(isRateLimited(IP, T0)).toBe(false)
    })

    it('does not rate-limit until MAX_FAILED_ATTEMPTS failures accrue in the window', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++)
        recordFailedAttempt(IP, T0)
      expect(isRateLimited(IP, T0)).toBe(false)
    })

    it('locks the source out once MAX_FAILED_ATTEMPTS failures accrue in the window', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        recordFailedAttempt(IP, T0)
      expect(isRateLimited(IP, T0)).toBe(true)
    })

    it('lifts the lockout after RATE_LIMIT_LOCKOUT_MS', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        recordFailedAttempt(IP, T0)
      expect(isRateLimited(IP, T0 + RATE_LIMIT_LOCKOUT_MS)).toBe(false)
    })

    // The "operator with a typo, not a grinder" case the thresholds are sized
    // for: failures spread across separate windows never accumulate into a
    // lockout, no matter how many there are in total.
    it('rolls failures off, so slow repeated failures never lock a source out', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS * 3; i++)
        recordFailedAttempt(IP, T0 + i * RATE_LIMIT_WINDOW_MS)
      expect(isRateLimited(IP, T0 + MAX_FAILED_ATTEMPTS * 3 * RATE_LIMIT_WINDOW_MS)).toBe(false)
    })

    it('gives a fresh budget after a lockout expires rather than re-locking on the next failure', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        recordFailedAttempt(IP, T0)
      const after = T0 + RATE_LIMIT_LOCKOUT_MS
      recordFailedAttempt(IP, after)
      expect(isRateLimited(IP, after)).toBe(false)
    })

    it('buckets per source — one locked-out source does not affect another', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        recordFailedAttempt(IP, T0)
      expect(isRateLimited(IP, T0)).toBe(true)
      expect(isRateLimited('198.51.100.4', T0)).toBe(false)
    })

    // An unobservable source address must not be a bypass — see
    // `isRateLimited`'s own comment.
    it('rate-limits an unknown source address rather than exempting it', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        recordFailedAttempt(undefined, T0)
      expect(isRateLimited(undefined, T0)).toBe(true)
    })

    it('clearFailedAttempts wipes a source history without touching other sources', () => {
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        recordFailedAttempt(IP, T0)
        recordFailedAttempt('198.51.100.4', T0)
      }
      clearFailedAttempts(IP)
      expect(isRateLimited(IP, T0)).toBe(false)
      expect(isRateLimited('198.51.100.4', T0)).toBe(true)
    })
  })

  describe('resetConnectKeyStateForTests', () => {
    it('clears both live keys and attempt history', () => {
      const { key } = mintConnectKey({ now: T0 })
      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
        recordFailedAttempt('203.0.113.7', T0)

      resetConnectKeyStateForTests()

      expect(consumeConnectKey(key, T0)).toBe(false)
      expect(isRateLimited('203.0.113.7', T0)).toBe(false)
    })
  })
})
