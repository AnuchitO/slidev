import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { WorkshopAuthConfig } from './auth'
import type { ParticipantVisibility, StepState } from './session'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import connect from 'connect'
import { join } from 'pathe'
import sirv from 'sirv'
import { Server as SocketIOServer } from 'socket.io'
import { isValidPresenterCode, isValidRoomCode } from './auth'
import { HEARTBEAT_INTERVAL_MS, sweepStaleParticipants } from './presence'
import {
  joinParticipant,
  listStepStatus,
  participants,
  session,
  setStepStatus,
} from './session'

export interface CreateWorkshopTrackerServerOptions {
  /** CORS origin for the Socket.io handshake. Defaults to `*`. */
  origin?: string
  /**
   * Required to `participant:join` (PRD §12 / plan 029 Step 1). An unset
   * (undefined/empty) code means *every* join is rejected — see `auth.ts`'s
   * `isValidCode`: a missing configured code is never satisfied by "nothing
   * supplied" behaving like a wildcard. Fail closed, not open, if an
   * operator forgets to configure this (see `index.ts`'s startup warning).
   */
  roomCode?: string
  /**
   * Required for every `presenter:*` event and to open `/dashboard` (PRD
   * §12 / plan 029 Step 1) — deliberately a *separate* secret from
   * `roomCode`, never derivable from it, so a participant who knows the room
   * code still can't move slides or open the dashboard. Same fail-closed
   * behavior as `roomCode` when unset.
   */
  presenterCode?: string
  /**
   * How often the staleness sweep (`presence.ts`'s `sweepStaleParticipants`)
   * runs. Defaults to `HEARTBEAT_INTERVAL_MS` (5s) in production. Test-only
   * override so `server.test.ts` can verify the sweep is actually wired up
   * without waiting a real 15s+ for staleness to accrue on every run.
   */
  sweepIntervalMs?: number
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
  }
}

function broadcastStateUpdate(io: SocketIOServer) {
  io.to(DASHBOARD_ROOM).emit('state:update', buildStateUpdate())
}

/**
 * Gates the `/dashboard` static route on the presenter credential, supplied
 * as a `?code=` query param (plan 029 Step 1's "simple query param... gate
 * on the dashboard's static route" option). Chosen over HTTP Basic Auth so
 * the *same* value the operator hands out in the dashboard URL is also what
 * `public/dashboard/index.html`'s own script reads back out of
 * `location.search` to authenticate its Socket.io `dashboard:join` — one
 * credential, one place it lives (the URL the operator was given), never
 * embedded in any served bundle. Runs *before* `sirv` in the middleware
 * chain below, so an invalid/missing code never reaches the static file
 * handler at all — satisfies plan 029's "dashboard route ... requires the
 * presenter credential to access" done-criterion for the route itself, not
 * just the Socket.io data feed layered on top of it.
 */
function requireDashboardCode(authConfig: WorkshopAuthConfig) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://internal')
    const supplied = url.searchParams.get('code') ?? undefined
    if (isValidPresenterCode(authConfig, supplied)) {
      next()
      return
    }
    res.statusCode = 401
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Presenter code required (append ?code=<presenterCode> to this URL).')
  }
}

/**
 * Builds the sync server's http+Socket.io instances without starting to
 * listen — kept separate from `index.ts`'s entrypoint so tests can drive it
 * against an ephemeral port, and so 027+ can extend the event handling here
 * without touching process bootstrapping.
 */
export function createWorkshopTrackerServer(options: CreateWorkshopTrackerServerOptions = {}): WorkshopTrackerServer {
  const authConfig: WorkshopAuthConfig = {
    roomCode: options.roomCode ?? '',
    presenterCode: options.presenterCode ?? '',
  }

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
  app.use('/dashboard', requireDashboardCode(authConfig))
  app.use('/dashboard', sirv(DASHBOARD_PUBLIC_DIR, { single: true, dev: true, etag: true }))

  const httpServer = createServer(app)
  const io = new SocketIOServer(httpServer, {
    cors: { origin: options.origin ?? '*' },
  })

  function touchLastSeen(participantId: string | undefined) {
    if (!participantId)
      return
    const participant = participants.get(participantId)
    if (participant)
      participant.lastSeen = Date.now()
  }

  io.on('connection', (socket) => {
    // Sync the newly-connected client to current state immediately — needed
    // for M1's own acceptance bar (a participant who loads *after* the
    // presenter has already moved past slide 1 must still land on the right
    // slide). This event isn't in PRD §10's list; it's the minimum addition
    // needed to make `slide:changed` (a rebroadcast-only event) useful to
    // late joiners, and is a deliberate, documented addition — not scope
    // creep.
    socket.emit('slide:sync', { index: session.currentSlideIndex })

    socket.on('presenter:setSlide', ({ index, presenterCode }: { index: number, presenterCode?: string }) => {
      // Plan 029 Step 1: gated on the presenter credential, distinct from
      // the participant room code. Invalid/missing code is a silent no-op
      // (matches this event's pre-029 shape — no ack — and the plan's own
      // verify step: "rejected/ignored, verified via ... the fact that no
      // other client's slide moves"), not a thrown error or disconnect —
      // a stray/misconfigured client shouldn't be able to crash the server.
      if (!isValidPresenterCode(authConfig, presenterCode))
        return
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
    socket.on('presenter:setStep', ({ stepId, presenterCode }: { stepId: string, presenterCode?: string }) => {
      // Plan 029 Step 1: same gate as `presenter:setSlide` above.
      if (!isValidPresenterCode(authConfig, presenterCode))
        return
      session.currentStepId = stepId
      broadcastStateUpdate(io)
    })

    socket.on(
      'participant:join',
      (
        { name, participantId, roomCode }: { name: string, participantId?: string, roomCode?: string },
        ack?: (payload: { participantId: string, currentSlideIndex: number } | { error: 'invalid_room_code' }) => void,
      ) => {
        // Plan 029 Step 1: the participant room code, distinct from (and
        // lower-privilege than) the presenter credential above. Rejected via
        // the ack rather than a forced disconnect — lets the join screen
        // show "wrong code" and let the participant retry without having to
        // reload/reconnect the socket.
        if (!isValidRoomCode(authConfig, roomCode)) {
          ack?.({ error: 'invalid_room_code' })
          return
        }
        const participant = joinParticipant(name, participantId, randomUUID, socket.id)
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
        touchLastSeen(participantId)
        ack?.({ stepId, state })
        broadcastStateUpdate(io)
      }
    }

    socket.on('participant:copy', handleStepAction('copied'))
    socket.on('participant:done', handleStepAction('done'))

    // PRD §10 `participant:visibility { state }` — reported by the addon's
    // `PresenceReporter.vue` on the Page Visibility API's `visibilitychange`
    // (plan 029 Step 2). `'closed'` is never sent by a client (see
    // `session.ts`'s `ParticipantVisibility` doc comment) — only
    // `'visible'`/`'hidden'` are accepted from here; anything else is
    // ignored rather than trusted verbatim, so a client can't self-report
    // `'closed'` and short-circuit the server's own disconnect/sweep signals.
    socket.on('participant:visibility', ({ state }: { state: ParticipantVisibility }) => {
      const participantId = socket.data.participantId as string | undefined
      if (!participantId || (state !== 'visible' && state !== 'hidden'))
        return
      const participant = participants.get(participantId)
      if (!participant)
        return
      participant.visibility = state
      participant.lastSeen = Date.now()
      broadcastStateUpdate(io)
    })

    // PRD §10 `participant:heartbeat { stepId }` — sent every
    // `HEARTBEAT_INTERVAL_MS` (plan 029 Step 2) purely as a liveness signal;
    // `stepId` isn't currently surfaced on the dashboard (the "current step"
    // column already reflects the *presenter's* step, PRD §11) but is
    // accepted per PRD §10's literal payload shape for forward
    // compatibility (e.g. a future "participant's own step" column) without
    // another event-contract change. Doesn't broadcast `state:update` on its
    // own — a bare liveness tick doesn't change anything the dashboard
    // renders (presence state, roster, step status), so broadcasting here
    // would just be periodic noise on every connected participant's tab.
    socket.on('participant:heartbeat', () => {
      touchLastSeen(socket.data.participantId as string | undefined)
    })

    // The dashboard (plan 027 Step 3) opts into the room-scoped broadcast
    // explicitly, rather than every connected socket being auto-joined —
    // participant sockets never emit this. Sends one immediate snapshot to
    // the joining socket only, mirroring `slide:sync`'s late-joiner pattern
    // above, so a freshly-opened dashboard tab doesn't have to wait for the
    // next mutation to render anything.
    socket.on('dashboard:join', ({ presenterCode }: { presenterCode?: string } = {}, ack?: (result: { ok: boolean }) => void) => {
      // Plan 029 Step 1: same presenter credential as `presenter:*` above —
      // opening the dashboard is exactly as privileged as moving everyone's
      // slide, so it shares the same gate rather than a weaker one.
      if (!isValidPresenterCode(authConfig, presenterCode)) {
        ack?.({ ok: false })
        return
      }
      socket.join(DASHBOARD_ROOM)
      socket.emit('state:update', buildStateUpdate())
      ack?.({ ok: true })
    })

    socket.on('disconnect', () => {
      const participantId = socket.data.participantId as string | undefined
      if (!participantId)
        return
      const participant = participants.get(participantId)
      if (!participant)
        return
      // A clean Socket.io `disconnect` is a definitive, immediate signal —
      // mark `closed` right away rather than waiting for the periodic sweep
      // below (plan 029 Step 3: "use both signals ... since [the sweep]
      // adds unnecessary latency for the common clean-close case").
      participant.connected = false
      participant.visibility = 'closed'
      broadcastStateUpdate(io)
    })
  })

  // Backstop for a *hung* connection that never fires a clean `disconnect`
  // (flaky workshop wifi) — see `presence.ts`'s own doc comment. Liveness is
  // checked against Socket.io's own live socket registry
  // (`io.sockets.sockets`, keyed by socket id) rather than trusting
  // `participant.connected` alone, which is exactly the signal this sweep
  // exists to correct when it's gone stale.
  const sweepIntervalId = setInterval(() => {
    const changed = sweepStaleParticipants(participants, participant => io.sockets.sockets.has(participant.socketId))
    if (changed)
      broadcastStateUpdate(io)
  }, options.sweepIntervalMs ?? HEARTBEAT_INTERVAL_MS)
  // Cleared when the http server closes (see `server.test.ts`'s `afterEach`)
  // so tests don't leak a running interval across runs.
  httpServer.on('close', () => clearInterval(sweepIntervalId))

  return { httpServer, io }
}
