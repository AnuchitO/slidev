import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

/**
 * Resolves the sync server URL from an env var (simplest option for M1;
 * revisit headmatter-driven config later if operators need a per-deck
 * override without env vars — not needed to hit M1's acceptance bar) and
 * connects to it.
 */
export function createWorkshopSocket(): Socket {
  const url = import.meta.env.VITE_WORKSHOP_TRACKER_SERVER_URL ?? 'http://localhost:3710'
  return io(url, { autoConnect: true, reconnection: true })
}
