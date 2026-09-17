import { describe, expect, it } from 'vitest'
import { isValidAdminCode } from './adminAuth'

// Mirrors `auth.test.ts` deliberately — the admin code is a differently
// *scoped* credential built on the same primitive, so it should be provably
// subject to the same rules (constant-time compare, no wildcards, no
// length-based shortcuts) rather than merely assumed to be.
describe('isValidAdminCode', () => {
  it('accepts the configured code', () => {
    expect(isValidAdminCode('admin-secret', 'admin-secret')).toBe(true)
  })

  it('rejects a wrong code', () => {
    expect(isValidAdminCode('admin-secret', 'nope')).toBe(false)
  })

  it('rejects a code that is a prefix of the configured one', () => {
    // Guards the `timingSafeEqual` length pre-check: differing lengths must
    // be a plain `false`, never a throw that escapes as an unhandled error.
    expect(isValidAdminCode('admin-secret', 'admin')).toBe(false)
  })

  it('rejects an undefined or empty supplied code', () => {
    expect(isValidAdminCode('admin-secret', undefined)).toBe(false)
    expect(isValidAdminCode('admin-secret', '')).toBe(false)
  })

  it('rejects everything when no admin code is configured', () => {
    // The fail-closed rule that matters most for this credential: an unset
    // admin code must never be satisfied by "nothing supplied" behaving like
    // a wildcard, which would make `/home` — a cross-room view — the one
    // surface on this server that opens up when it is *less* configured.
    expect(isValidAdminCode('', undefined)).toBe(false)
    expect(isValidAdminCode('', '')).toBe(false)
    expect(isValidAdminCode('', 'anything')).toBe(false)
  })
})
