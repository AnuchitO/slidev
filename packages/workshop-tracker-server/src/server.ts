import type { Server as HttpServer } from 'node:http'
import type { StepState } from './session'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
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
 * Builds the sync server's http+Socket.io instances without starting to
 * listen — kept separate from `index.ts`'s entrypoint so tests can drive it
 * against an ephemeral port, and so 027+ can extend the event handling here
 * without touching process bootstrapping.
 */
export function createWorkshopTrackerServer(options: CreateWorkshopTrackerServerOptions = {}): WorkshopTrackerServer {
  const httpServer = createServer()
  const io = new SocketIOServer(httpServer, {
    cors: { origin: options.origin ?? '*' },
  })

  io.on('connection', (socket) => {
    // Sync the newly-connected client to current state immediately — needed
    // for M1's own acceptance bar (a participant who loads *after* the
    // presenter has already moved past slide 1 must still land on the right
    // slide). This event isn't in PRD §10's list; it's the minimum addition
    // needed to make `slide:changed` (a rebroadcast-only event) useful to
    // late joiners, and is a deliberate, documented addition — not scope
    // creep.
    socket.emit('slide:sync', { index: session.currentSlideIndex })

    socket.on('presenter:setSlide', ({ index, stepId }: { index: number, stepId?: string }) => {
      // NOTE(security): M1/M2 have no auth — any connected socket can emit
      // this and move everyone's slide. That's an accepted,
      // explicitly-tracked gap; plan 029 (M4) adds a join code that gates
      // who's allowed to be "the presenter". Do not treat this as
      // done/secure before 029 lands.
      session.currentSlideIndex = index
      // `stepId` isn't in PRD §10's `presenter:setSlide` payload verbatim —
      // it's a deliberate addition (mirroring M1's `slide:sync` precedent)
      // so the dashboard can show a "current step" status column (plan 027
      // Step 3) without the server parsing deck markdown itself. The addon
      // computes it client-side via `resolveStepId` (frontmatter `stepId`,
      // falling back to the slide index — PRD §8) and reports it here;
      // falls back to the slide index itself if the addon omits it (e.g. an
      // older addon build).
      session.currentStepId = stepId ?? String(index)
      io.emit('slide:changed', { index })
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
