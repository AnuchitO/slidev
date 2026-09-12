import { isValidCode } from './auth'

/**
 * The **cross-room admin credential** (plan 032b), deliberately a third
 * secret rather than a reuse of either of `auth.ts`'s two.
 *
 * Why it has to exist at all: plan 032a wired `HOME_DASHBOARD_ROOM` and its
 * `home:update` feed but left the room permanently empty, precisely because
 * a cross-room view has no correct gate among the credentials that existed
 * then. The `home:update` payload necessarily carries *every* live room's
 * code (that's what a session list is), and a room code is the
 * participant-level credential for its session — so gating a cross-room view
 * on any single room's presenter code would hand that room's presenter the
 * ability to enumerate every *other* workshop running on the same server.
 * A cross-room view is strictly more privileged than any one room's
 * dashboard, so it needs a credential that isn't scoped to a room in the
 * first place.
 *
 * Scope of this credential, as of 032b and as planned:
 * - opening `/home` (the cross-room dashboard page) and its `home:join`
 *   socket subscription;
 * - listing discovered presentations (`GET /api/presentations`);
 * - 032c: launching and stopping a server-spawned deck;
 * - 032d: minting a Flow-B connect key.
 *
 * Every one of those is an operator action, not a presenter action — which
 * is the line this credential draws: `presenterCode` answers "may you
 * run _this_ workshop", `adminCode` answers "may you operate this _server_".
 *
 * The comparison itself is `auth.ts`'s `isValidCode` verbatim — the same
 * constant-time compare, the same refusal to let a missing configured code
 * be satisfied by "nothing supplied" behaving like a wildcard. Nothing about
 * how a secret is checked is re-decided here; only which secret is being
 * checked, and against what.
 *
 * Kept in its own module rather than folded into `auth.ts` for the same
 * reason plan 032's own Security notes give for the connect key: a
 * differently-scoped credential deserves its own code path even when the
 * "compare a shared secret" shape looks identical, so that a future change
 * to one gate's semantics can't silently widen another's.
 */
export function isValidAdminCode(configuredCode: string, supplied: string | undefined): boolean {
  return isValidCode(configuredCode, supplied)
}
