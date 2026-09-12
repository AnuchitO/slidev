import { describe, expect, it } from 'vitest'
import { generateCode } from './codeGeneration'

// Matches `CODE_ALPHABET` in `codeGeneration.ts` exactly (26 letters + 10
// digits, minus the 5 visually-ambiguous ones it excludes: 0, 1, I, L, O) —
// kept as its own constant here rather than re-deriving it, so a test
// assertion never silently drifts from what the source file actually
// excludes.
const ALPHABET_LENGTH = 31

describe('generateCode', () => {
  it('generates a code of the requested length', () => {
    expect(generateCode(6, () => 0)).toHaveLength(6)
    expect(generateCode(10, () => 0)).toHaveLength(10)
  })

  it('only ever uses characters from the excludes-ambiguous-characters alphabet', () => {
    const code = generateCode(200, () => Math.floor(Math.random() * ALPHABET_LENGTH))
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]+$/)
    // The visually-ambiguous characters this alphabet deliberately excludes.
    expect(code).not.toMatch(/[01OIL]/)
  })

  it('uses the injected random function deterministically, not real randomness', () => {
    expect(generateCode(4, () => 0)).toBe('AAAA')
    expect(generateCode(4, () => ALPHABET_LENGTH - 1)).toBe('9999')
  })

  it('calls random with the alphabet length as the exclusive upper bound', () => {
    const seen: number[] = []
    generateCode(3, (max) => {
      seen.push(max)
      return 0
    })
    expect(seen).toEqual([ALPHABET_LENGTH, ALPHABET_LENGTH, ALPHABET_LENGTH])
  })

  it('defaults to a real random source when none is injected (smoke test, not exact output)', () => {
    const a = generateCode(12)
    const b = generateCode(12)
    expect(a).toHaveLength(12)
    expect(b).toHaveLength(12)
    // Astronomically unlikely to collide by chance at this length — a
    // real regression (e.g. `randomInt` always returning 0) would make
    // this fail reliably, not flakily.
    expect(a).not.toBe(b)
  })
})
