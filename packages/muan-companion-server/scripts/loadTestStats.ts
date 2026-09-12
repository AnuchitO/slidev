/**
 * Pure latency-summary math for `load-test.ts` (plan 030 Step 2). Pulled out
 * of the orchestration script so it's unit-testable directly (this repo's
 * convention — see `presenterCode.ts`/`stepId.ts` in the addon package, and
 * `uploads.ts` in this one) rather than only exercisable by actually running
 * a load test against real sockets.
 */

/**
 * The nearest-rank percentile of `samples` (ms latencies, but unit-agnostic)
 * at `p` (0-100). Sorts a copy — never mutates the caller's array. Throws on
 * an empty input rather than returning `NaN`/`undefined`, so a load-test run
 * that produced zero samples (e.g. every participant failed to connect)
 * fails loudly instead of silently reporting a bogus "0ms p99".
 */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0)
    throw new Error('percentile: samples must not be empty')

  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length) - 1
  const index = Math.min(Math.max(rank, 0), sorted.length - 1)
  return sorted[index]
}

export interface LatencySummary {
  count: number
  min: number
  max: number
  mean: number
  p50: number
  p95: number
  p99: number
}

/**
 * Summarizes a batch of latency samples for the load test's console report
 * and its committed results doc (`scripts/load-test-results.md`). An empty
 * `samples` array reports all-zero rather than throwing — a load test
 * printing a summary table shouldn't crash mid-report just because one
 * measurement (e.g. "step-status propagation" with zero participants acting)
 * happened to collect nothing.
 */
export function summarize(samples: number[]): LatencySummary {
  if (samples.length === 0)
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 }

  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((acc, v) => acc + v, 0)

  return {
    count: sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  }
}
