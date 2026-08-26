import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

let socket: Socket | undefined

/**
 * Resolves the sync server URL from an env var (simplest option for M1;
 * revisit headmatter-driven config later if operators need a per-deck
 * override without env vars — not needed to hit M1's acceptance bar) and
 * returns a single shared connection.
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
  if (!socket) {
    const url = import.meta.env.VITE_WORKSHOP_TRACKER_SERVER_URL ?? 'http://localhost:3710'
    socket = io(url, { autoConnect: true, reconnection: true })
  }
  return socket
}
