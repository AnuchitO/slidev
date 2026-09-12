import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

let socket: Socket | undefined

/**
 * Resolves the sync server's base URL from an env var (simplest option for
 * M1; revisit headmatter-driven config later if operators need a per-deck
 * override without env vars — not needed to hit M1's acceptance bar).
 * Shared by `getWorkshopSocket()` below (the Socket.io connection) and
 * `ErrorReportWidget.vue`'s plain `fetch()` call to `POST /api/screenshot`
 * (plan 028) — both need the *same* origin, so this is the one place that
 * reads the env var rather than each call site re-deriving it.
 */
export function getMuanCompanionServerUrl(): string {
  return import.meta.env.VITE_SLIDEV_MUAN_COMPANION_SERVER_URL ?? 'http://localhost:3710'
}

/**
 * Returns a single shared Socket.io connection to the sync server.
 *
 * Memoized at module scope rather than created fresh per call: `setup/main.ts`
 * (app-level, pre-mount) and the M2 components (`StepCommand.vue`,
 * `JoinScreen.vue`, both real mounted components) all need to talk to the
 * same socket — e.g. a component's `participant:copy` has to go out on the
 * connection that already carries this browser's `socket.data.participantId`
 * from `participant:join`. A plain ES module is a singleton per bundle, so
 * every importer of this file gets the same instance without provide/inject
 * (which `setup/main.ts` can't use — see its own comment on injection
 * context).
 */
export function getWorkshopSocket(): Socket {
  if (!socket)
    socket = io(getMuanCompanionServerUrl(), { autoConnect: true, reconnection: true })
  return socket
}
