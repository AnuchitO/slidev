import type { Participant } from './session'

/**
 * How often the addon's client-side heartbeat (`participant:heartbeat`)
 * fires, and the cadence `server.ts` runs the staleness sweep on (plan 029
 * Step 3). PRD §10: "every ~5s (doubles as 'still connected' signal)".
 */
export const HEARTBEAT_INTERVAL_MS = 5_000

/**
 * A connected participant is considered stale once `lastSeen` is older than
 * this many ms. Documented multiple per plan 029 Step 1/Step 3: 3x the
 * heartbeat interval, not 1x — a single missed heartbeat (flaky workshop
 * wifi, a backgrounded tab throttling timers) shouldn't immediately read as
 * "gone"; it takes three consecutive misses before staleness even becomes a
 * candidate for the `closed` verdict below.
 */
export const STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3

/**
 * Sweeps every currently-`connected` participant and flips one to `closed`
 * only when BOTH hold: its `lastSeen` is stale (see `STALE_AFTER_MS`) AND
 * none of its sockets are actually still connected (per `isSocketConnected`
 * — a participant can have more than one live socket at once, one per open
 * tab; see `session.ts`'s `Participant.socketIds` doc comment). Staleness
 * alone is deliberately not enough to close a participant — a socket can be
 * perfectly alive but just not have sent a heartbeat inside this sweep's own
 * cadence; only every socket being hung/gone, combined with staleness, means
 * the connection is actually dead. A clean Socket.io `disconnect` event
 * removes just that one socket immediately elsewhere (`server.ts`, via
 * `removeParticipantSocket`), only closing the participant once that was its
 * last socket — this sweep exists purely to catch a *hung* connection that
 * never fires a clean `disconnect` at all (plan 029 Step 3's "use both
 * signals" call).
 *
 * `isSocketConnected` is injected rather than this module reaching into
 * Socket.io's own `io.sockets.sockets` map directly, so the sweep stays a
 * pure function testable with fake timers and a plain `Map`, no real
 * socket/server infrastructure required (see `presence.test.ts`).
 *
 * Returns whether any participant's state actually changed, so callers
 * (`server.ts`'s periodic sweep) can skip broadcasting `state:update` when
 * nothing moved.
 */
export function sweepStaleParticipants(
  participants: Map<string, Participant>,
  isSocketConnected: (participant: Participant) => boolean,
): boolean {
  const now = Date.now()
  let changed = false

  for (const participant of participants.values()) {
    // Already-disconnected participants (clean disconnect, or a prior sweep)
    // have nothing left to flip — don't re-process/re-broadcast for them.
    if (!participant.connected)
      continue

    const isStale = now - participant.lastSeen > STALE_AFTER_MS
    if (!isStale)
      continue

    if (isSocketConnected(participant))
      continue

    participant.connected = false
    participant.visibility = 'closed'
    // Every socket this predicate saw was dead — clear the array rather
    // than leaving stale ids sitting in it (see `removeParticipantSocket`'s
    // doc comment on why a *partial* leftover is tolerated but there's no
    // reason to keep any once we've determined the whole participant is gone).
    participant.socketIds = []
    changed = true
  }

  return changed
}
