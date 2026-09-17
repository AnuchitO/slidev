import { describe, expect, it } from 'vitest'
import { isValidPresenterCode, isValidRoomCode } from './auth'

describe('isValidRoomCode', () => {
  it('returns true when the supplied code matches the configured room code', () => {
    expect(isValidRoomCode({ roomCode: 'abc123', presenterCode: 'x' }, 'abc123')).toBe(true)
  })

  it('returns false when the supplied code does not match', () => {
    expect(isValidRoomCode({ roomCode: 'abc123', presenterCode: 'x' }, 'wrong')).toBe(false)
  })

  it('returns false when the supplied code is missing/undefined', () => {
    expect(isValidRoomCode({ roomCode: 'abc123', presenterCode: 'x' }, undefined)).toBe(false)
  })

  it('returns false for an empty-string supplied code even if the configured code is also empty', () => {
    expect(isValidRoomCode({ roomCode: '', presenterCode: 'x' }, '')).toBe(false)
  })
})

describe('isValidPresenterCode', () => {
  it('returns true when the supplied code matches the configured presenter code', () => {
    expect(isValidPresenterCode({ roomCode: 'x', presenterCode: 'secret' }, 'secret')).toBe(true)
  })

  it('returns false when the supplied code does not match', () => {
    expect(isValidPresenterCode({ roomCode: 'x', presenterCode: 'secret' }, 'guess')).toBe(false)
  })

  it('returns false when the supplied code is missing/undefined', () => {
    expect(isValidPresenterCode({ roomCode: 'x', presenterCode: 'secret' }, undefined)).toBe(false)
  })

  it('is not fooled by a supplied code that is a prefix of the real one', () => {
    expect(isValidPresenterCode({ roomCode: 'x', presenterCode: 'secret' }, 'sec')).toBe(false)
  })

  it('rejects mismatched-length codes without throwing (constant-time compare guard)', () => {
    expect(isValidPresenterCode({ roomCode: 'x', presenterCode: 'a' }, 'a much longer guess')).toBe(false)
  })
})
