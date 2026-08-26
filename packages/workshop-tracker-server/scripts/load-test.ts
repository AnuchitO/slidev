/**
 * Load test for `workshop-tracker-server` (plan 030 Step 2 / PRD §12,
 * §15). Spins up the server in-process (via `createWorkshopTrackerServer`,
 * the same entry point `server.test.ts` uses) on an ephemeral port, connects
 * N simulated participant sockets + one presenter socket + one dashboard
 * socket, and measures:
 *
 *   1. Slide-change propagation — time from one `presenter:setSlide`
 *      emission to the *last* simulated participant receiving
 *      `slide:changed` (repeated over several trials, summarized).
 *   2. Step-status propagation — time from each participant's own
 *      `participant:copy` emission to that participant's status appearing
 *      in a `state:update` payload observed by the dashboard connection.
 *
 * Self-contained and re-runnable: no separately-running server or
 * operator-configured env vars required — this script generates its own
 * room/presenter codes and tears the server down when it's done. Matches
 * this package's own event contract exactly (no HTTP load tool would
 * exercise the WS upgrade + event traffic that actually matters here — see
 * plan 030 Step 2's own reasoning for why a custom script was chosen over
 * e.g. `artillery`).
 *
 * Usage:
 *   pnpm --filter workshop-tracker-server load-test [-- --participants=100]
 *
 * Pure latency-summary math lives in `loadTestStats.ts` (unit tested,
 * TDD'd) — this file is the socket orchestration around it, verified by
 * actually running it (an integration exercise, not something meaningfully
 * unit-testable without real sockets).
 */
import type { Socket as ClientSocket } from 'socket.io-client'
import type { WorkshopTrackerServer } from '../src/server'
import type { LatencySummary } from './loadTestStats'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { io as ioClient } from 'socket.io-client'
import { createWorkshopTrackerServer } from '../src/server'
import { resetSessionStateForTests } from '../src/session'
import { summarize } from './loadTestStats'

const STEP_ID = 'load-test-step'

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {}
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg)
    if (m)
      args[m[1]] = m[2]
  }
  return {
    participants: Number(args.participants ?? 50),
    slideTrials: Number(args['slide-trials'] ?? 5),
    resultsFile: args['results-file'] ?? fileURLToPath(new URL('./load-test-results.md', import.meta.url)),
  }
}

function connectClient(url: string): Promise<ClientSocket> {
  // `transports: ['websocket']` skips the polling-then-upgrade handshake —
  // at 50-100 concurrent connections opened in a tight loop, that dance is
  // a real source of multi-second stalls (the same reasoning as
  // `server.test.ts`'s `newClient` helper, at much larger scale here).
  const socket = ioClient(url, { forceNew: true, transports: ['websocket'] })
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket))
    socket.once('connect_error', reject)
  })
}

function emitWithAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise(resolve => socket.emit(event, payload, resolve))
}

async function main() {
  const { participants: participantCount, slideTrials, resultsFile } = parseArgs(process.argv.slice(2))
  const roomCode = `room-${randomUUID()}`
  const presenterCode = `presenter-${randomUUID()}`

  resetSessionStateForTests()
  const server: WorkshopTrackerServer = createWorkshopTrackerServer({ roomCode, presenterCode })
  await new Promise<void>(resolve => server.httpServer.listen(0, resolve))
  const address = server.httpServer.address()
  if (address === null || typeof address === 'string')
    throw new Error('expected an AddressInfo from an ephemeral-port listen()')
  const url = `http://localhost:${address.port}`

  console.log(`[load-test] server listening on ${url}, ramping up ${participantCount} simulated participants...`)

  const rampStart = performance.now()
  const participantSockets: ClientSocket[] = []
  const participantIds: string[] = []

  // Ramp up sequentially in small batches rather than all at once — mirrors
  // real workshop room behavior (participants trickle in over the first
  // minute or two, not literally all in the same event-loop tick) and keeps
  // any one batch's connection storm bounded.
  const BATCH_SIZE = 10
  for (let start = 0; start < participantCount; start += BATCH_SIZE) {
    const batch = Math.min(BATCH_SIZE, participantCount - start)
    const batchResults = await Promise.all(
      Array.from({ length: batch }, async (_, i) => {
        const socket = await connectClient(url)
        const ack = await emitWithAck<{ participantId: string }>(socket, 'participant:join', {
          name: `LoadTest-${start + i}`,
          roomCode,
        })
        return { socket, participantId: ack.participantId }
      }),
    )
    for (const { socket, participantId } of batchResults) {
      participantSockets.push(socket)
      participantIds.push(participantId)
    }
  }
  const rampMs = performance.now() - rampStart
  console.log(`[load-test] ${participantSockets.length} participants joined in ${rampMs.toFixed(0)}ms`)

  const presenter = await connectClient(url)
  const dashboard = await connectClient(url)
  const dashboardAck = await emitWithAck<{ ok: boolean }>(dashboard, 'dashboard:join', { presenterCode })
  if (!dashboardAck.ok)
    throw new Error('load-test: dashboard:join was rejected — presenter code mismatch in the harness itself')

  // Background heartbeat traffic for the duration of the test (production
  // cadence, `HEARTBEAT_INTERVAL_MS` = 5s) — realistic ambient load
  // alongside the measured slide-change/step-status traffic, per plan 030
  // Step 2's "join, occasional heartbeat, occasional copy/done" sketch.
  const heartbeatTimers = participantSockets.map(socket =>
    setInterval(() => socket.emit('participant:heartbeat', { stepId: STEP_ID }), 5_000),
  )

  // --- Measurement 1: slide-change propagation ---------------------------
  const slideLatencies: number[] = []
  for (let trial = 0; trial < slideTrials; trial++) {
    const index = trial + 2 // avoid index 1 (the session's initial value)
    const latency = await new Promise<number>((resolve) => {
      const t0 = performance.now()
      const seen = new Set<string>()
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          resolve(performance.now() - t0)
        }
      }
      const timeout = setTimeout(finish, 10_000)
      for (const socket of participantSockets) {
        const handler = (payload: { index: number }) => {
          if (payload.index !== index)
            return
          seen.add(socket.id ?? Math.random().toString())
          socket.off('slide:changed', handler)
          if (seen.size === participantSockets.length) {
            clearTimeout(timeout)
            finish()
          }
        }
        socket.on('slide:changed', handler)
      }
      presenter.emit('presenter:setSlide', { index, presenterCode })
    })
    slideLatencies.push(latency)
  }

  // --- Measurement 2: step-status (copy) propagation to the dashboard ----
  const copyEmitAt = new Map<string, number>()
  const copySeenAt = new Map<string, number>()
  const stateUpdateHandler = (payload: { stepStatus: Array<{ participantId: string, stepId: string, state: string }> }) => {
    const now = performance.now()
    for (const entry of payload.stepStatus) {
      if (entry.stepId === STEP_ID && entry.state === 'copied' && copyEmitAt.has(entry.participantId) && !copySeenAt.has(entry.participantId))
        copySeenAt.set(entry.participantId, now)
    }
  }
  dashboard.on('state:update', stateUpdateHandler)

  for (let i = 0; i < participantSockets.length; i++) {
    const socket = participantSockets[i]
    const participantId = participantIds[i]
    copyEmitAt.set(participantId, performance.now())
    socket.emit('participant:copy', { stepId: STEP_ID })
  }

  const copyDeadline = Date.now() + 10_000
  while (copySeenAt.size < participantSockets.length && Date.now() < copyDeadline)
    await new Promise(resolve => setTimeout(resolve, 25))

  dashboard.off('state:update', stateUpdateHandler)

  const copyLatencies = [...copyEmitAt.entries()]
    .filter(([id]) => copySeenAt.has(id))
    .map(([id, t0]) => copySeenAt.get(id)! - t0)
  const missingCopyCount = participantSockets.length - copyLatencies.length

  // --- Step 3: auth-under-load, with all N participants + dashboard still
  // connected — confirms the presenter/room-code gate has no
  // concurrency-dependent hole under the same connection count the latency
  // numbers above were measured at. ---------------------------------------
  const authResults: Array<{ check: string, pass: boolean }> = []

  {
    const attacker = await connectClient(url)
    const ack = await emitWithAck<{ error?: string, participantId?: string }>(attacker, 'participant:join', {
      name: 'Attacker',
      roomCode: 'wrong-room-code',
    })
    authResults.push({ check: 'participant:join rejects a wrong room code under load', pass: ack.error === 'invalid_room_code' })
    attacker.disconnect()
  }

  {
    const before = await new Promise<{ currentSlideIndex: number }>((resolve) => {
      dashboard.once('state:update', resolve)
      dashboard.emit('dashboard:join', { presenterCode })
    })
    let sawChange = false
    const handler = () => {
      sawChange = true
    }
    participantSockets[0]?.on('slide:changed', handler)
    presenter.emit('presenter:setSlide', { index: 999, presenterCode: 'wrong-presenter-code' })
    await new Promise(resolve => setTimeout(resolve, 300))
    participantSockets[0]?.off('slide:changed', handler)
    authResults.push({
      check: 'presenter:setSlide rejects a wrong presenter code under load',
      pass: !sawChange && before.currentSlideIndex !== 999,
    })
  }

  {
    const rogueDashboard = await connectClient(url)
    const ack = await emitWithAck<{ ok: boolean }>(rogueDashboard, 'dashboard:join', { presenterCode: 'wrong-presenter-code' })
    authResults.push({ check: 'dashboard:join rejects a wrong presenter code under load', pass: ack.ok === false })
    rogueDashboard.disconnect()
  }

  // --- Report --------------------------------------------------------------
  const slideSummary = summarize(slideLatencies)
  const copySummary = summarize(copyLatencies)

  function printSummary(label: string, s: LatencySummary) {
    console.log(`\n${label}`)
    console.log(`  count=${s.count} min=${s.min.toFixed(1)}ms mean=${s.mean.toFixed(1)}ms p50=${s.p50.toFixed(1)}ms p95=${s.p95.toFixed(1)}ms p99=${s.p99.toFixed(1)}ms max=${s.max.toFixed(1)}ms`)
  }

  console.log(`\n=== workshop-tracker-server load test: ${participantSockets.length} participants ===`)
  printSummary(`Slide-change propagation (presenter:setSlide -> last participant's slide:changed), ${slideTrials} trials`, slideSummary)
  printSummary(`Step-status propagation (participant:copy -> dashboard state:update)${missingCopyCount > 0 ? ` [${missingCopyCount} MISSING/TIMED OUT]` : ''}`, copySummary)
  console.log('\nAuth-under-load checks:')
  for (const r of authResults)
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${r.check}`)

  const targetMet = slideSummary.max <= 1_000 && copySummary.max <= 1_000 && missingCopyCount === 0
  const authOk = authResults.every(r => r.pass)

  const report = `# Load test results

Generated by \`pnpm --filter workshop-tracker-server load-test\` — re-run this
script to refresh these numbers (e.g. after any change to the broadcast path
in \`server.ts\`); see plan 030's "Maintenance notes".

- Date: ${new Date().toISOString()}
- Simulated participants: ${participantSockets.length}
- Ramp-up time: ${rampMs.toFixed(0)}ms

## Slide-change propagation

\`presenter:setSlide\` emission -> last simulated participant's \`slide:changed\`,
${slideTrials} trials.

| metric | value (ms) |
|---|---|
| count | ${slideSummary.count} |
| min | ${slideSummary.min.toFixed(1)} |
| mean | ${slideSummary.mean.toFixed(1)} |
| p50 | ${slideSummary.p50.toFixed(1)} |
| p95 | ${slideSummary.p95.toFixed(1)} |
| p99 | ${slideSummary.p99.toFixed(1)} |
| max | ${slideSummary.max.toFixed(1)} |

## Step-status propagation

Each participant's own \`participant:copy\` emission -> that participant's
status appearing in a \`state:update\` observed by the dashboard connection.
${missingCopyCount > 0 ? `\n**${missingCopyCount} participant(s) did not appear within the 10s timeout — see "STOP conditions" in plan 030.**\n` : ''}
| metric | value (ms) |
|---|---|
| count | ${copySummary.count} |
| min | ${copySummary.min.toFixed(1)} |
| mean | ${copySummary.mean.toFixed(1)} |
| p50 | ${copySummary.p50.toFixed(1)} |
| p95 | ${copySummary.p95.toFixed(1)} |
| p99 | ${copySummary.p99.toFixed(1)} |
| max | ${copySummary.max.toFixed(1)} |

## Auth-under-load (${participantSockets.length} concurrent participants + dashboard connected)

${authResults.map(r => `- [${r.pass ? 'PASS' : 'FAIL'}] ${r.check}`).join('\n')}

## Verdict

- Target (~1s max for both measurements, PRD §12/§15): **${targetMet ? 'MET' : 'NOT MET — see plan 030 STOP conditions'}**
- Auth gate under load: **${authOk ? 'HOLDS' : 'FAILED — see plan 030 STOP conditions'}**
`

  await writeFile(resultsFile, report)
  console.log(`\n[load-test] results written to ${resultsFile}`)

  for (const t of heartbeatTimers) clearInterval(t)
  for (const s of participantSockets) s.disconnect()
  presenter.disconnect()
  dashboard.disconnect()
  server.io.close()
  await new Promise<void>(resolve => server.httpServer.close(() => resolve()))

  if (!targetMet || !authOk) {
    console.error('\n[load-test] FAILED — see plan 030 STOP conditions before relaxing any target.')
    process.exitCode = 1
  }
  else {
    console.log('\n[load-test] PASSED')
  }
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
