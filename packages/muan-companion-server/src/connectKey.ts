import { generateCode } from './codeGeneration'

/**
 * How long a freshly-minted connect key stays usable (plan 032 Flow B step 1:
 * "single-use, short TTL (e.g. 5 minutes)"). Deliberately short and a named
 * constant rather than an inline literal, because it is one half of this
 * credential's entire security story — the other half being single use.
 *
 * 5 minutes is the operator-ergonomics floor, not an arbitrary round number:
 * the intended flow is "mint a key on the home view, paste it into the
 * terminal where `slidev dev` is about to start, hit enter". That is a
 * copy-paste and a process start, well under a minute in practice, with slack
 * for an operator who gets interrupted mid-paste. Anything materially longer
 * buys no usability and only widens the window in which a key that leaked
 * (shoulder-surfed off a projected dashboard, left in a terminal's
 * scrollback, captured in a shell history file) is still redeemable.
 */
export const CONNECT_KEY_TTL_MS = 5 * 60 * 1000

/**
 * Length of a generated connect key, in characters from `codeGeneration.ts`'s
 * 31-character unambiguous alphabet (~4.95 bits each, so 12 chars ≈ 59 bits,
 * ≈7.9×10¹⁷ combinations).
 *
 * Sized above `PRESENTER_CODE_LENGTH` (10, ≈50 bits), not at the room-code
 * length, because of what a guessed key actually buys an attacker: possession
 * of a valid connect key alone is enough to make this server *create a
 * session* — a room code, a presenter code, and a dashboard entry — with a
 * `deckUrl` the guesser chose. That is strictly more than joining an existing
 * room as a fake participant (what a guessed room code buys) and comparable
 * to holding a presenter code, so it gets at least presenter-grade entropy.
 * The two extra characters over the presenter code are close to free: unlike
 * the room code this is never read aloud across a room, it is copy-pasted
 * into an env var exactly once, so the "resist mishearing / typing under time
 * pressure" pressure that caps the other two lengths does not apply.
 *
 * Note this entropy is a backstop, not the primary defense — the TTL above
 * and `isRateLimited`/`recordFailedAttempt` below are what actually make
 * online guessing hopeless. Entropy is what keeps that true if the rate limit
 * is ever misconfigured, bypassed by a distributed source, or defeated by a
 * deployment that terminates every request through one proxy IP (see
 * `recordFailedAttempt`'s own threat-model comment).
 */
export const CONNECT_KEY_LENGTH = 12

/**
 * How many failed `/api/register` attempts one source may make inside
 * `RATE_LIMIT_WINDOW_MS` before further attempts from that source are refused
 * outright for `RATE_LIMIT_LOCKOUT_MS`.
 *
 * ## Threat model this exists for (plan 032 §Security notes / 031 Q1-4.2b)
 *
 * `/api/register` is the one route in this package reachable with a
 * credential that did **not** require already holding another credential to
 * obtain. Every other privileged surface fails closed on a secret an operator
 * already had to distribute (`auth.ts`); a connect key is minted by the
 * server on request and then travels, by design, to a machine the server does
 * not control. That makes this the natural place for an attacker to grind:
 * the endpoint sits *in front of* session creation, so there is no session
 * whose auth could have stopped them earlier.
 *
 * Two distinct attacks, and what stops each:
 *
 * 1. **Blind key guessing.** Enumerate 12-character keys against
 *    `/api/register`. `CONNECT_KEY_LENGTH`'s ≈59 bits already makes this
 *    hopeless offline; this counter makes it hopeless *cheaply*, capping a
 *    single source at a handful of guesses per minute instead of as many as
 *    it can open sockets. It also converts what would otherwise be a silent,
 *    unbounded grind into a visible one — a locked-out source is a signal,
 *    not just a slower attacker.
 * 2. **Racing a real operator's live key.** An attacker who knows a key was
 *    just minted (they can see the projected dashboard, say) has at most
 *    `CONNECT_KEY_TTL_MS` to use it — but they must also *land* it before the
 *    legitimate deck does, since the first successful consumption burns it.
 *    The rate limit does not help here; single-use plus the TTL does. Noted
 *    explicitly so a reviewer does not mistake this counter for a defense it
 *    is not.
 *
 * ## Why these numbers, and what they deliberately do not defend
 *
 * 5 failures / 60s window / 60s lockout: an operator who fat-fingers a pasted
 * key has room to retry a few times within a normal workshop setup without
 * ever noticing this exists, while a script gets ~5 guesses a minute — about
 * 10¹⁶ years to cover the keyspace. The window and the lockout are the same
 * length on purpose: there is no escalation ladder, no exponential backoff,
 * no persistence. This is a speed bump sized to the actual risk, and it is
 * kept boring so that it is obviously correct on reading.
 *
 * Keyed on the source IP as the server sees it (`req.socket.remoteAddress`),
 * with the explicit, reviewed limitations that (a) an attacker with many
 * source addresses gets the budget once per address, and (b) a deployment
 * behind a reverse proxy sees every request as one address, so one attacker
 * can lock out every legitimate operator sharing that proxy. `X-Forwarded-For`
 * is deliberately **not** trusted to fix (b): this package has no configured
 * notion of a trusted proxy, and honoring a client-settable header here would
 * hand an attacker a per-request reset of their own rate limit — strictly
 * worse than the shared-bucket false-positive it would cure. A deployment
 * that needs per-client limiting behind a proxy should rate-limit at the
 * proxy, which is the layer that actually knows who the client is. This
 * asymmetry (fail toward refusing service, never toward granting it) is the
 * same posture as `auth.ts`'s refusal to treat an unset code as a wildcard.
 */
export const MAX_FAILED_ATTEMPTS = 5
export const RATE_LIMIT_WINDOW_MS = 60 * 1000
export const RATE_LIMIT_LOCKOUT_MS = 60 * 1000

export interface ConnectKey {
  key: string
  /** Epoch milliseconds after which `consumeConnectKey` refuses this key. */
  expiresAt: number
}

interface MintedKey {
  expiresAt: number
}

/**
 * Live, unredeemed keys. In-memory only, consistent with every other piece of
 * state in this package (`rooms` in `session.ts`, `pendingConnections` on each
 * `RoomState`) — there is no persistence layer here and 032d does not add one.
 * A server restart invalidating every outstanding key is the correct behavior
 * anyway: a key is a 5-minute bootstrap token, and a restarted server has no
 * sessions for one to register into.
 *
 * A key is removed from this map the instant it is consumed *or* found
 * expired, so "already used" and "expired" collapse into the same
 * indistinguishable "not present" state — see `consumeConnectKey`.
 */
const keys = new Map<string, MintedKey>()

interface AttemptRecord {
  /** Failures counted so far inside the current window. */
  count: number
  /** When the current window started — failures older than this roll off. */
  windowStartedAt: number
  /** Epoch ms until which this source is refused outright; 0 when not locked out. */
  lockedOutUntil: number
}

const attempts = new Map<string, AttemptRecord>()

export interface MintConnectKeyOptions {
  /**
   * Injectable code generator, defaulting to `codeGeneration.ts`'s
   * crypto-backed one — same rationale as `generateCode`'s own `random`
   * parameter and `createSessionOptions.generate`: tests can assert exact
   * keys without mocking the crypto module.
   */
  generate?: (length: number) => string
  /** Injectable clock, so TTL behavior is testable without real waiting. */
  now?: number
}

/**
 * Mints one single-use connect key (plan 032 Flow B step 1).
 *
 * Uses the same `generateCode` as room/presenter codes rather than, say, a
 * raw `randomUUID()`: one alphabet, one crypto source, one place to review.
 * The key is returned to the caller and *only* to the caller — it is never
 * logged, never included in any broadcast, and cannot be listed back out of
 * this module afterwards, matching the proposal's "displayed once, not
 * persisted anywhere retrievable after the fact".
 *
 * No cap on the number of live keys and no collision re-roll loop, unlike
 * `createSession`'s room codes: a collision at ≈59 bits would require the
 * same key to be drawn twice, and the consequence if it somehow happened is
 * that one of the two keys silently replaces the other and its holder's
 * registration fails — a benign, self-healing failure (mint another), not the
 * two-workshops-merged-into-one corruption a room-code collision would cause.
 */
export function mintConnectKey(options: MintConnectKeyOptions = {}): ConnectKey {
  const generate = options.generate ?? (length => generateCode(length))
  const now = options.now ?? Date.now()

  // Opportunistic sweep on the write path: expired entries are also rejected
  // lazily on read (below), so this is purely to stop `keys` growing without
  // bound in a long-lived process where keys are minted but never redeemed.
  // Doing it here rather than on an interval keeps this module free of timers
  // (nothing to clean up in tests, nothing to leak) — the map only ever grows
  // via this function, so this function is the only place it can need
  // trimming.
  for (const [existing, record] of keys) {
    if (record.expiresAt <= now)
      keys.delete(existing)
  }

  const key = generate(CONNECT_KEY_LENGTH)
  const expiresAt = now + CONNECT_KEY_TTL_MS
  keys.set(key, { expiresAt })
  return { key, expiresAt }
}

/**
 * Validates and **burns** a connect key. Returns whether the key was good.
 *
 * Single-use is enforced by deleting before returning success, so a second
 * call with the same key fails even well inside its TTL — the proposal's
 * "burned the moment registration succeeds". There is deliberately no
 * "peek"/`isValidConnectKey` variant: a check that did not burn would invite
 * a caller to validate first and consume later, and that gap is exactly where
 * two concurrent registrations with the same key would both succeed.
 *
 * **Reveals nothing about *why* a key failed.** Expired, never-existed, and
 * already-used all return the identical `false`, and all three leave the map
 * in the identical state (no entry). This mirrors `auth.ts`'s posture for the
 * room and presenter codes — a caller learns only "no", never "you were close"
 * or "that one was real, just late", either of which would tell an attacker
 * probing keys that a given prefix/format was worth more of their budget.
 * That is also why an expired key is deleted here rather than merely skipped:
 * leaving it behind would make "expired" and "never existed" distinguishable
 * by anything that could observe the map, and would let a resurrection bug in
 * a future edit have something to resurrect.
 */
export function consumeConnectKey(key: string, now: number = Date.now()): boolean {
  const record = keys.get(key)
  if (!record)
    return false
  // Burn on *any* outcome once the key is known to exist — a key that is
  // presented after expiry is spent, not merely ignored, so a caller cannot
  // sit on one and retry it against a clock they hope to have misread.
  keys.delete(key)
  return record.expiresAt > now
}

/**
 * Whether this source is currently locked out and must be refused before any
 * other work happens. See `MAX_FAILED_ATTEMPTS`' doc comment for the threat
 * model, the chosen thresholds, and the limitations this deliberately accepts.
 *
 * An `undefined` source (Node reports no `remoteAddress` — a socket already
 * destroyed by the time the handler runs) is bucketed under one shared
 * `'unknown'` key rather than exempted. Exempting it would make "arrive
 * without an observable address" a rate-limit bypass; sharing one bucket at
 * worst makes a rare, already-broken class of request refuse each other, which
 * is the fail-toward-refusing direction this package prefers.
 */
export function isRateLimited(sourceIp: string | undefined, now: number = Date.now()): boolean {
  const record = attempts.get(bucketKeyOf(sourceIp))
  return record !== undefined && record.lockedOutUntil > now
}

/**
 * Records one failed `/api/register` attempt from this source, locking the
 * source out once `MAX_FAILED_ATTEMPTS` accrue inside `RATE_LIMIT_WINDOW_MS`.
 *
 * Called for *every* rejected registration — a bad key, a malformed body, an
 * unparseable `deckUrl`, all of it — not only for bad keys. Counting only
 * key failures would leave the cheapest probe (does this route exist? does it
 * parse my body?) free and unbounded, and it would also re-introduce the
 * distinction between failure reasons that the response shape works to erase:
 * an attacker who noticed that malformed bodies never lock them out but bad
 * keys do has learned which of their attempts got as far as key validation.
 */
export function recordFailedAttempt(sourceIp: string | undefined, now: number = Date.now()): void {
  const bucket = bucketKeyOf(sourceIp)
  const record = attempts.get(bucket)

  // No record, or the previous window has fully elapsed — start counting
  // again from one. A source that fails twice, waits out the window, and
  // fails twice more is an operator with a typo, not a grinder, and gets no
  // lockout.
  if (!record || now - record.windowStartedAt >= RATE_LIMIT_WINDOW_MS) {
    attempts.set(bucket, { count: 1, windowStartedAt: now, lockedOutUntil: 0 })
    return
  }

  record.count += 1
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedOutUntil = now + RATE_LIMIT_LOCKOUT_MS
    // Reset the counter alongside the lockout so the source gets a fresh
    // budget when the lockout expires, rather than being re-locked by its
    // very next failure forever. Escalating repeat offenders is deliberately
    // out of scope — see `MAX_FAILED_ATTEMPTS`' "kept boring" note.
    record.count = 0
    record.windowStartedAt = now
  }
}

/**
 * Clears a source's failure history after a *successful* registration, so an
 * operator who mistyped a key twice before getting it right doesn't carry
 * those failures into their next registration minutes later. Deliberately
 * does not clear an active lockout for anyone else: the bucket is per source,
 * and reaching success requires a valid key, which a grinder by definition
 * does not have.
 */
export function clearFailedAttempts(sourceIp: string | undefined): void {
  attempts.delete(bucketKeyOf(sourceIp))
}

function bucketKeyOf(sourceIp: string | undefined): string {
  return sourceIp || 'unknown'
}

/**
 * Test-only reset, mirroring `session.ts`'s `resetSessionStateForTests`. Both
 * maps here are module-level, so without this a test that mints a key or trips
 * the rate limit would leak that state into every later test in the same file.
 */
export function resetConnectKeyStateForTests(): void {
  keys.clear()
  attempts.clear()
}
