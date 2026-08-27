import process from 'node:process'
import { createMuanCompanionServer } from './server'

const PORT = Number(process.env.PORT ?? 3710)

const roomCode = process.env.SLIDEV_MUAN_COMPANION_ROOM_CODE
const presenterCode = process.env.SLIDEV_MUAN_COMPANION_PRESENTER_CODE

// Fail closed, not open: `auth.ts`'s checks already reject every join/
// presenter action/dashboard-open when the configured code is unset — this
// is just a loud startup warning so an operator who forgot to set these
// finds out immediately (a server nobody can join) rather than filing a
// confusing bug report, instead of silently discovering it mid-workshop.
if (!roomCode || !presenterCode) {
  console.warn(
    '[muan-companion-server] SLIDEV_MUAN_COMPANION_ROOM_CODE and/or SLIDEV_MUAN_COMPANION_PRESENTER_CODE '
    + 'is not set — every participant:join, presenter:* event, and dashboard '
    + 'connection will be rejected until both are configured (plan 029 / PRD §12).',
  )
}

const { httpServer } = createMuanCompanionServer({
  origin: process.env.SLIDEV_MUAN_COMPANION_ORIGIN ?? '*',
  roomCode,
  presenterCode,
})

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console -- deliberate startup log for a CLI-run server process, not app logging.
  console.log(`muan-companion-server listening on :${PORT}`)
  // Answers "how does the presenter find out the codes to hand out" —
  // they're the operator who just set these env vars, so echoing them back
  // to the same terminal is just a convenience, not a leak. The dashboard
  // page itself shows the same two values once opened (via `dashboard:join`'s
  // ack, gated on already knowing the presenter code) as a second, harder-to-
  // miss place to find them mid-session.
  if (roomCode && presenterCode) {
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Room code (give to participants): ${roomCode}`)
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Presenter code (yours only): ${presenterCode}`)
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Dashboard: http://localhost:${PORT}/dashboard?code=${presenterCode}`)
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Append ?presenterCode=${presenterCode} to your own /presenter/N deck URL.`)
  }
})
