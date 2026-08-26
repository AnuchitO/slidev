import process from 'node:process'
import { createWorkshopTrackerServer } from './server'

const PORT = Number(process.env.PORT ?? 3710)

const roomCode = process.env.WORKSHOP_ROOM_CODE
const presenterCode = process.env.WORKSHOP_PRESENTER_CODE

// Fail closed, not open: `auth.ts`'s checks already reject every join/
// presenter action/dashboard-open when the configured code is unset — this
// is just a loud startup warning so an operator who forgot to set these
// finds out immediately (a server nobody can join) rather than filing a
// confusing bug report, instead of silently discovering it mid-workshop.
if (!roomCode || !presenterCode) {
  console.warn(
    '[workshop-tracker-server] WORKSHOP_ROOM_CODE and/or WORKSHOP_PRESENTER_CODE '
    + 'is not set — every participant:join, presenter:* event, and dashboard '
    + 'connection will be rejected until both are configured (plan 029 / PRD §12).',
  )
}

const { httpServer } = createWorkshopTrackerServer({
  origin: process.env.WORKSHOP_TRACKER_ORIGIN ?? '*',
  roomCode,
  presenterCode,
})

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console -- deliberate startup log for a CLI-run server process, not app logging.
  console.log(`workshop-tracker-server listening on :${PORT}`)
})
