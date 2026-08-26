import process from 'node:process'
import { createWorkshopTrackerServer } from './server'

const PORT = Number(process.env.PORT ?? 3710)

const { httpServer } = createWorkshopTrackerServer({
  origin: process.env.WORKSHOP_TRACKER_ORIGIN ?? '*',
})

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console -- deliberate startup log for a CLI-run server process, not app logging.
  console.log(`workshop-tracker-server listening on :${PORT}`)
})
