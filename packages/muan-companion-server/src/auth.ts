import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'

/**
 * The two secrets an operator configures for a workshop session (plan 029 /
 * PRD §12). Deliberately two distinct fields, not one shared secret: a
 * participant who knows the room code must never be able to derive or reuse
 * it as the presenter code — see `isValidPresenterCode`'s own comment and
 * this package's README for the full threat model this closes.
 */
export interface WorkshopAuthConfig {
  /** Required to join as a participant (`participant:join`). Low-privilege. */
  roomCode: string
  /**
   * Required to act as the presenter (`presenter:*` events) and to open the
   * dashboard (`/dashboard` HTTP route + its `dashboard:join` socket event).
   * High-privilege — never derivable from the room code alone.
   */
  presenterCode: string
}

/**
 * Constant-time string comparison so a mismatched code takes the same amount
 * of time to reject regardless of how many leading characters happen to
 * match — a cheap, standard defense against timing side-channels on a
 * password-equality check. `timingSafeEqual` throws if the two buffers
 * differ in length, so unequal-length inputs are rejected explicitly first
 * rather than letting that throw escape as an unhandled error.
 */
function constantTimeEquals(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected)
  const actualBuf = Buffer.from(actual)
  if (expectedBuf.length !== actualBuf.length)
    return false
  return timingSafeEqual(expectedBuf, actualBuf)
}

/**
 * A missing/undefined/empty supplied code is always invalid, even against an
 * (accidentally) empty configured code — an unset code must never be
 * satisfied by "nothing supplied" behaving like a wildcard.
 *
 * Exported (plan 032d) as **the** shared-secret comparison primitive for this
 * package, rather than staying private to the two checks below. `adminAuth.ts`
 * needs exactly this behavior — constant-time compare, fail-closed on an
 * unconfigured expected value — for the cross-room admin code, and a second
 * hand-rolled copy of it is precisely the kind of drift that turns one
 * reviewed comparison into two, only one of which stays timing-safe after the
 * next edit. The admin code lives in its own module (not as a third field on
 * `WorkshopAuthConfig`) because it is deliberately *not* per-room state — see
 * `adminAuth.ts`'s own doc comment — but the comparison itself is the same
 * comparison, so it is shared rather than reimplemented.
 */
export function isValidCode(configured: string, supplied: string | undefined): boolean {
  if (!configured || !supplied)
    return false
  return constantTimeEquals(configured, supplied)
}

export function isValidRoomCode(config: WorkshopAuthConfig, supplied: string | undefined): boolean {
  return isValidCode(config.roomCode, supplied)
}

export function isValidPresenterCode(config: WorkshopAuthConfig, supplied: string | undefined): boolean {
  return isValidCode(config.presenterCode, supplied)
}
