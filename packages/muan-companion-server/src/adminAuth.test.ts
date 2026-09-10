import { describe, expect, it } from 'vitest'
import { isValidAdminCode } from './adminAuth'

describe('isValidAdminCode', () => {
  it('returns true when the supplied code matches the configured admin code', () => {
    expect(isValidAdminCode('admin-secret', 'admin-secret')).toBe(true)
  })

  it('returns false when the supplied code does not match', () => {
    expect(isValidAdminCode('admin-secret', 'guess')).toBe(false)
  })

  it('returns false when the supplied code is missing/undefined', () => {
    expect(isValidAdminCode('admin-secret', undefined)).toBe(false)
  })

  it('is not fooled by a supplied code that is a prefix of the real one', () => {
    expect(isValidAdminCode('admin-secret', 'admin')).toBe(false)
  })

  it('rejects mismatched-length codes without throwing (constant-time compare guard)', () => {
    expect(isValidAdminCode('a', 'a much longer guess')).toBe(false)
  })

  // The fail-closed property that makes an unconfigured admin code a *closed*
  // cross-room surface rather than an open one — see `adminAuth.ts` and
  // `auth.ts`'s `isValidCode`. Asserted here as well as in `auth.test.ts`
  // because this is the specific invariant `createMuanCompanionServer` relies
  // on when it passes `options.adminCode ?? ''`.
  it('rejects every credential against an unconfigured (empty) admin code', () => {
    expect(isValidAdminCode('', '')).toBe(false)
    expect(isValidAdminCode('', undefined)).toBe(false)
    expect(isValidAdminCode('', 'anything')).toBe(false)
  })
})
