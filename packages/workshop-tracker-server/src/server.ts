import type { Server as HttpServer } from 'node:http'
import type { StepState } from './session'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import connect from 'connect'
import { join } from 'pathe'
import sirv from 'sirv'
import { Server as SocketIOServer } from 'socket.io'
import { createScreenshotUploadHandler } from './screenshotUpload'
import {
  addErrorReport,
  joinParticipant,
  listErrorReports,
  listStepStatus,
  participants,
  resolveErrorReport,
  session,
  setStepStatus,
} from './session'
import { resolveUploadPath } from './uploads'

export interface CreateWorkshopTrackerServerOptions {
  /** CORS origin for the Socket.io handshake. Defaults to `*`. */
  origin?: string
}

export interface WorkshopTrackerServer {
  httpServer: HttpServer
  io: SocketIOServer
}

// Sockets that have joined this room get every `state:update` broadcast —
// participant sockets never join it, so the full roster/step-status payload
// isn't sent to every participant on every other participant's keystroke
// (plan 027 Step 1 / STOP condition 3).
const DASHBOARD_ROOM = 'dashboard'

// The dashboard (plan 027 Step 3) is served as a small static page by this
// same process — same origin as the Socket.io server, so no CORS
// configuration is needed for it. See this package's README for why (option
// 1 of the two considered in the plan).
const DASHBOARD_PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'dashboard')

function buildStateUpdate() {
  return {
    currentSlideIndex: session.currentSlideIndex,
    currentStepId: session.currentStepId,
    participants: [...participants.values()],
    stepStatus: listStepStatus(),
    // PRD §10's literal `state:update` shape (`{ currentSlideIndex,
    // participants[], errors[] }`) — folded straight into the existing
    // payload rather than a separate event (plan 028 Step 1's decision):
    // error reports are rare compared to step-status churn, so the combined
    // payload isn't a size/frequency problem at realistic volumes, and the
    // dashboard client needs no restructuring beyond rendering a new field.
    errors: listErrorReports(),
  }
}

function broadcastStateUpdate(io: SocketIOServer) {
  io.to(DASHBOARD_ROOM).emit('state:update', buildStateUpdate())
}

/**
 * Builds the sync server's http+Socket.io instances without starting to
 * listen — kept separate from `index.ts`'s entrypoint so tests can drive it
 * against an ephemeral port, and so 027+ can extend the event handling here
 * without touching process bootstrapping.
 */
export function createWorkshopTrackerServer(options: CreateWorkshopTrackerServerOptions = {}): WorkshopTrackerServer {
  // `sirv` is mounted on the connect app *before* Socket.io attaches to the
  // same `httpServer` below. Engine.io's `attach()` caches whatever
  // `request` listeners are already registered, removes them, and installs
  // its own listener that intercepts only requests under its own path
  // (`/socket.io/` by default) — everything else falls through to the
  // cached listeners (see `engine.io`'s `Server.prototype.attach`). That's
  // what makes serving `/dashboard` from the *same* http server safe:
  // Socket.io's own handshake/polling traffic is untouched, and this app
  // only ever sees non-`/socket.io/` requests. Mounting sirv under a
  // `/dashboard` path prefix (rather than at `/`) keeps this deliberate and
  // explicit rather than relying on that fallthrough for every path.
  const app = connect()
  app.use('/dashboard', sirv(DASHBOARD_PUBLIC_DIR, { single: true, dev: true, etag: true }))

  // Session-scoped uploads dir (plan 028 Step 1): a fresh `mkdtemp`-ed
  // directory per server instance, not a fixed path in the repo — matches
  // the PRD's "keep them in memory/disk for the session, no cross-restart
  // persistence requirement" (§4 non-goals) without needing an explicit
  // cleanup job, and gives every test run (each of which creates its own
  // server) an isolated directory rather than sharing one across runs.
  const uploadsDir = mkdtempSync(join(tmpdir(), 'workshop-tracker-uploads-'))

  // `GET /uploads/:filename` — served by the same `sirv` used for the
  // dashboard, from the confined `uploadsDir` above. `resolveUploadPath`
  // (`uploads.ts`) is checked *first*, ahead of sirv, so a path-traversal
  // attempt or any filename that doesn't match the server's own
  // `${randomUUID()}.${ext}` naming scheme is rejected before sirv ever
  // touches the filesystem — defense-in-depth on top of sirv's own path
  // normalization, not a replacement for it.
  app.use('/uploads', (req, res, next) => {
    const raw = (req.url ?? '').replace(/^\/+/, '').split('?')[0]
    let requested: string
    try {
      requested = decodeURIComponent(raw)
    }
    catch {
      // Malformed percent-encoding — not a filename this server ever wrote,
      // reject rather than guess.
      res.writeHead(400).end()
      return
    }
    if (!resolveUploadPath(uploadsDir, requested)) {
      res.writeHead(404).end()
      return
    }
    next()
  })
  app.use('/uploads', sirv(uploadsDir, { dev: true, etag: true }))

  const httpServer = createServer(app)
  const io = new SocketIOServer(httpServer, {
    cors: { origin: options.origin ?? '*' },
  })

  app.use(createScreenshotUploadHandler(uploadsDir, () => broadcastStateUpdate(io)))

  io.on('connection', (socket) => {
    // Sync the newly-connected client to current state immediately — needed
    // for M1's own acceptance bar (a participant who loads *after* the
    // presenter has already moved past slide 1 must still land on the right
    // slide). This event isn't in PRD §10's list; it's the minimum addition
    // needed to make `slide:changed` (a rebroadcast-only event) useful to
    // late joiners, and is a deliberate, documented addition — not scope
    // creep.
    socket.emit('slide:sync', { index: session.currentSlideIndex })

    socket.on('presenter:setSlide', ({ index }: { index: number }) => {
      // NOTE(security): M1/M2 have no auth — any connected socket can emit
      // this and move everyone's slide. That's an accepted,
      // explicitly-tracked gap; plan 029 (M4) adds a join code that gates
      // who's allowed to be "the presenter". Do not treat this as
      // done/secure before 029 lands.
      session.currentSlideIndex = index
      io.emit('slide:changed', { index })
      broadcastStateUpdate(io)
    })

    // Not in PRD §10's literal event list — a deliberate addition (mirroring
    // M1's `slide:sync` precedent) so the dashboard can show a "current
    // step" status column (plan 027 Step 3) without the server parsing deck
    // markdown itself. Kept as its *own* event rather than folded into
    // `presenter:setSlide` above: the addon computes `stepId` via a real
    // mounted component reading `useNav().currentFrontmatter`
    // (`StepReporter.vue`), which updates on its own reactive schedule,
    // independent of when the router's `afterEach` (which drives
    // `presenter:setSlide`) fires — see that component's own comment for
    // why they can't share one event.
    socket.on('presenter:setStep', ({ stepId }: { stepId: string }) => {
      // NOTE(security): same gap as `presenter:setSlide` above.
      session.currentStepId = stepId
      broadcastStateUpdate(io)
    })

    socket.on(
      'participant:join',
      (
        { name, participantId }: { name: string, participantId?: string },
        ack?: (payload: { participantId: string, currentSlideIndex: number }) => void,
      ) => {
        const participant = joinParticipant(name, participantId, randomUUID)
        socket.data.participantId = participant.id
        ack?.({ participantId: participant.id, currentSlideIndex: session.currentSlideIndex })
        broadcastStateUpdate(io)
      },
    )

    function handleStepAction(state: StepState) {
      return ({ stepId }: { stepId: string }, ack?: (payload: { stepId: string, state: StepState }) => void) => {
        const participantId = socket.data.participantId as string | undefined
        // A client can only act on behalf of the participant it joined as
        // (set on `participant:join` above) — a socket that hasn't joined
        // yet has nothing to attach the status to, so this is a no-op
        // rather than a guess.
        if (!participantId)
          return
        setStepStatus(participantId, stepId, state)
        ack?.({ stepId, state })
        broadcastStateUpdate(io)
      }
    }

    socket.on('participant:copy', handleStepAction('copied'))
    socket.on('participant:done', handleStepAction('done'))

    // Text-only error report (PRD §10). The screenshot path is REST-only
    // (`POST /api/screenshot`, `screenshotUpload.ts`) — this WS event is
    // deliberately the *only* path for a text-only report, per plan 028
    // Step 2's decision not to implement both a WS and a REST path for the
    // identical text-only case.
    socket.on('participant:error', ({ stepId, text }: { stepId: string, text?: string }) => {
      const participantId = socket.data.participantId as string | undefined
      // Same "no-op rather than a guess" rule as `participant:copy`/`done`
      // above — a socket that hasn't joined has no participant to attach
      // the report to.
      if (!participantId)
        return
      const participant = participants.get(participantId)
      if (!participant)
        return
      addErrorReport({
        id: randomUUID(),
        participantId,
        participantName: participant.name,
        stepId,
        text,
        ts: Date.now(),
      })
      broadcastStateUpdate(io)
    })

    socket.on('presenter:resolveError', ({ errorId }: { errorId: string }) => {
      // NOTE(security): same no-auth gap as `presenter:setSlide`/`setStep`
      // above — any connected socket can resolve any error report until
      // plan 029 lands.
      resolveErrorReport(errorId)
      broadcastStateUpdate(io)
    })

    // The dashboard (plan 027 Step 3) opts into the room-scoped broadcast
    // explicitly, rather than every connected socket being auto-joined —
    // participant sockets never emit this. Sends one immediate snapshot to
    // the joining socket only, mirroring `slide:sync`'s late-joiner pattern
    // above, so a freshly-opened dashboard tab doesn't have to wait for the
    // next mutation to render anything.
    socket.on('dashboard:join', () => {
      socket.join(DASHBOARD_ROOM)
      socket.emit('state:update', buildStateUpdate())
    })

    socket.on('disconnect', () => {
      const participantId = socket.data.participantId as string | undefined
      if (!participantId)
        return
      const participant = participants.get(participantId)
      if (!participant)
        return
      participant.connected = false
      broadcastStateUpdate(io)
    })
  })

  return { httpServer, io }
}
