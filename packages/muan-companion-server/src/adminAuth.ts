import { isValidCode } from './auth'

/**
 * The **cross-room** credential (plan 032 / 032b / 032d), as distinct from the
 * two per-room secrets `auth.ts` already guards.
 *
 * Why this isn't a third field on `WorkshopAuthConfig`: every credential in
 * `auth.ts` is scoped to exactly one session — room A's presenter code is
 * worthless against room B, which is the whole point of 032a's re-keying. The
 * admin code is the opposite by construction: it authorizes actions *about*
 * the set of sessions rather than about any one of them — minting a
 * connect key (`connectKey.ts`), opening the cross-room home view (032b), and
 * later launching/stopping a spawned deck (032c). Folding it into the
 * per-room config would mean either duplicating the same value onto every
 * `RoomState` (N copies of one process-wide secret, each drifting
 * independently the moment anything re-keys a room) or picking an arbitrary
 * "which room's config do I check the cross-room code against?" — a question
 * with no correct answer. So it is process-wide, and it lives here.
 *
 * **It is at least as privileged as a presenter code, and strictly more so in
 * aggregate.** 032a's `HOME_DASHBOARD_ROOM` comment states the requirement
 * this module exists to satisfy: whatever gates a cross-room view "must be at
 * least as strong as the per-room presenter code that gates `dashboard:join`
 * today — a cross-room view is strictly more privileged than any single
 * room's dashboard, so it must not be reachable with less." Hence the same
 * `PRESENTER_CODE_LENGTH` (10 characters) when auto-generated in `index.ts`,
 * never the shorter room-code length.
 *
 * The comparison itself is deliberately not reimplemented here: it delegates
 * to `auth.ts`'s `isValidCode`, so the admin code gets exactly the same
 * constant-time compare (`timingSafeEqual`, with the explicit unequal-length
 * guard) and exactly the same fail-closed treatment of an unconfigured
 * expected value — a missing/empty configured code is never satisfied by
 * "nothing supplied" behaving like a wildcard. See that function's own doc
 * comment for the full reasoning; there is one such comparison in this
 * package, on purpose.
 */
export function isValidAdminCode(configuredCode: string, supplied: string | undefined): boolean {
  return isValidCode(configuredCode, supplied)
}
