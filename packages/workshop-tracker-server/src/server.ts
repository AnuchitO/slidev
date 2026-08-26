import type { Server as HttpServer } from 'node:http'
import { createServer } from 'node:http'
import { Server as SocketIOServer } from 'socket.io'
import { session } from './session'

export interface CreateWorkshopTrackerServerOptions {
  /** CORS origin for the Socket.io handshake. Defaults to `*`. */
  origin?: string
}

export interface WorkshopTrackerServer {
  httpServer: HttpServer
  io: SocketIOServer
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
    // late joiners, and is a deliberate, documented addition — not scope creep.
    socket.emit('slide:sync', { index: session.currentSlideIndex })

    socket.on('presenter:setSlide', ({ index }: { index: number }) => {
      // NOTE(security): M1 has no auth — any connected socket can emit this
      // and move everyone's slide. That's an accepted, explicitly-tracked
      // gap; plan 029 (M4) adds a join code that gates who's allowed to be
      // "the presenter". Do not treat this as done/secure before 029 lands.
      session.currentSlideIndex = index
      io.emit('slide:changed', { index })
    })
  })

  return { httpServer, io }
}
