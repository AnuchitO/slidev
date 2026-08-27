import { describe, expect, it } from 'vitest'
import { percentile, summarize } from './loadTestStats'

// Plan 030 Step 2: the load-test script's own correctness — specifically the
// percentile/summary math it reports latency numbers with — is what this
// plan's "load-test script's own correctness" TDD target actually means in
// practice; the socket orchestration in load-test.ts itself is an
// integration exercise (verified by actually running it, not a unit test),
// but this arithmetic is exactly the kind of pure logic this repo's
// convention (presenterCode.ts, stepId.ts, uploads.ts) always pulls out and
// unit-tests directly.
describe('percentile', () => {
  it('returns the single value for a one-element array at any percentile', () => {
    expect(percentile([42], 50)).toBe(42)
    expect(percentile([42], 99)).toBe(42)
  })

  it('returns the exact value at p50 for an odd-length sorted array', () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30)
  })

  it('returns the min at p0 and the max at p100', () => {
    const samples = [5, 1, 4, 2, 3]
    expect(percentile(samples, 0)).toBe(1)
    expect(percentile(samples, 100)).toBe(5)
  })

  it('does not require the input to be pre-sorted', () => {
    expect(percentile([100, 1, 50], 50)).toBe(50)
  })

  it('throws on an empty array rather than silently returning NaN/undefined', () => {
    expect(() => percentile([], 50)).toThrow()
  })
})

describe('summarize', () => {
  it('reports count, min, max, mean, and p50/p95/p99 for a batch of samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100

    const result = summarize(samples)

    expect(result.count).toBe(100)
    expect(result.min).toBe(1)
    expect(result.max).toBe(100)
    expect(result.mean).toBeCloseTo(50.5, 5)
    expect(result.p50).toBe(50)
    expect(result.p95).toBe(95)
    expect(result.p99).toBe(99)
  })

  it('reports all zeros/NaN-free for an empty sample set rather than throwing', () => {
    const result = summarize([])
    expect(result).toEqual({ count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 })
  })
})
