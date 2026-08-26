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
 */
function isValidCode(configured: string, supplied: string | undefined): boolean {
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
