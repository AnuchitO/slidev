import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CreateSessionOptions, CreateSessionResult } from './session'
import { isValidAdminCode } from './adminAuth'
import { parseJsonObject, readBody, respondJson, suppliedAdminCode } from './apiHttp'
import {
  clearFailedAttempts,
  consumeConnectKey,
  isRateLimited,
  mintConnectKey,
  recordFailedAttempt,
} from './connectKey'

const CONNECT_KEY_ROUTE = '/api/connect-key'
const REGISTER_ROUTE = '/api/register'

/**
 * Hard cap on the `POST /api/register` request body, in bytes. The body is
 * two short strings (`connectKey`, `deckUrl`); 4 KiB is orders of magnitude
 * more than any legitimate one needs and still small enough that an attacker
 * cannot use this unauthenticated-adjacent route (see `connectKey.ts`'s
 * threat model) to make the process buffer meaningful memory. Enforced *while
 * reading*, not after — a body that exceeds the cap is abandoned mid-stream
 * rather than accumulated and then measured, so the cap actually bounds
 * allocation instead of merely reporting on it. Mirrors the intent of
 * `uploads.ts`'s `UPLOAD_MAX_BYTES` for the multipart route.
 */
const MAX_REGISTER_BODY_BYTES = 4096

/**
 * Hard cap on the `deckUrl` string. `new URL()` happily parses absurdly long
 * inputs, and this value is stored on a `RoomState` and echoed into every
 * join link and QR code for the life of the session — a multi-kilobyte URL is
 * not a deck address, it's a payload looking for somewhere to be rendered.
 */
const MAX_DECK_URL_LENGTH = 2048

export interface CreateRegistrationRoutesOptions {
  /**
   * The process-wide admin code (`adminAuth.ts`). Gates `POST /api/connect-key`.
   * An empty string means "no admin code configured", which `isValidAdminCode`
   * fails closed on — the mint route is then unreachable, never open.
   */
  adminCode: string
  /**
   * How a validated registration actually creates its session. Injected as
   * `createMuanCompanionServer`'s own wrapper (the one that pairs
   * `createSession` with `broadcastHomeUpdate`) rather than importing
   * `session.ts`'s `createSession` directly, so a registration cannot create
   * a session the home view never hears about — the exact invariant that
   * wrapper exists to enforce. See `MuanCompanionServer.createSession`.
   */
  createSession: (options: CreateSessionOptions) => CreateSessionResult
  /** Builds the participant-facing join URL — `server.ts`'s `buildJoinUrl`. */
  buildJoinUrl: (deckUrl: string, roomCode: string) => string | undefined
  /** Builds the presenter-facing URL — `server.ts`'s `buildPresenterUrl`. */
  buildPresenterUrl: (deckUrl: string, presenterCode: string) => string
}

/**
 * The single rejection shape every `/api/register` failure uses.
 *
 * Deliberately one constant, referenced from every failure path, rather than
 * a per-path message: a malformed body, an unparseable `deckUrl`, a key that
 * never existed, a key that expired, and a key already redeemed are all
 * indistinguishable to the caller — same status, same bytes. This is the same
 * "reveal nothing extra" posture `auth.ts` takes for the room and presenter
 * codes, applied to the one route that sits in front of session creation. A
 * caller who could tell "your key was valid but your URL wasn't" apart from
 * "your key was wrong" would have a working key oracle, which is precisely
 * what a connect key must never be.
 *
 * The cost is real and accepted: an operator with a typo'd `deckUrl` gets no
 * hint about which of the two fields is wrong. That is why the addon logs the
 * request it made (`register.ts`) — the operator's own console is where the
 * diagnosis belongs, since the operator can see both values and an attacker
 * cannot.
 */
const REGISTRATION_FAILED_BODY = { error: 'registration failed' }

interface RegisterRequest {
  connectKey: string
  deckUrl: string
}

/**
 * Parses the `POST /api/register` body into its two required string fields,
 * or `undefined` if it is anything else at all.
 *
 * Strict about types, not just presence: `JSON.parse` will happily hand back
 * a number, an array, `null`, or an object whose `connectKey` is an object.
 * Every one of those is rejected here (the container by `parseJsonObject`, the
 * two fields below) rather than being coerced downstream —
 * `consumeConnectKey` taking a non-string would compare against map keys in
 * ways nobody reviewed, and a non-string `deckUrl` reaching `new URL()` would
 * be stringified into something that might even parse. Untrusted input from a
 * caller who has not yet proven they are the presenter of anything gets
 * checked to its exact expected shape, once, here.
 */
function parseRegisterBody(raw: string | undefined): RegisterRequest | undefined {
  const parsed = parseJsonObject(raw)
  if (!parsed)
    return undefined
  const { connectKey, deckUrl } = parsed
  if (typeof connectKey !== 'string' || typeof deckUrl !== 'string')
    return undefined
  return { connectKey, deckUrl }
}

/**
 * Validates a caller-supplied `deckUrl` and returns it in the normalized form
 * this server will store on the `RoomState`, or `undefined` if it isn't a
 * well-formed absolute URL this package is willing to hand to a human.
 *
 * The trust boundary here is the sharpest one in 032d: whoever posts this has,
 * by definition, not yet proven they are the presenter of anything — a valid
 * connect key proves only "someone gave me a bootstrap token". The value they
 * supply becomes `RoomState.deckUrl`, which is concatenated into the
 * participant join link, encoded into the QR code the dashboard projects on a
 * screen, and clicked by every person in the room. So "well-formed absolute
 * URL" is enforced strictly, and specifically:
 *
 * - **Absolute only.** `new URL(value)` with no base throws on a relative
 *   reference, which is the check. A relative deck URL is meaningless to a
 *   participant's browser loading it from a different origin.
 * - **`http:`/`https:` only.** `new URL()` accepts any scheme, including
 *   `javascript:`, `data:`, and `file:`. All three would be a genuine attack
 *   if rendered as a link on the dashboard or encoded into a QR code someone
 *   scans — an allowlist, not a denylist, so a scheme nobody thought of is
 *   refused rather than permitted.
 * - **No embedded credentials.** `https://evil@trusted.example` renders with
 *   the credential leading and is a classic look-alike-link trick; there is no
 *   legitimate reason for a deck URL to carry userinfo.
 * - **A real host.** Rejects the degenerate parses (`http:///foo`) that
 *   produce a URL object with an empty hostname.
 * - **No fragment.** A `#...` on the base URL would end up *before* the
 *   `?roomCode=` that `buildJoinUrl` appends, silently producing a join link
 *   whose query the deck never sees. Rejected rather than stripped, because
 *   quietly editing a caller's URL into a different one is worse than telling
 *   them no.
 *
 * The returned value is the parsed URL's own serialization with any trailing
 * slash removed, not the raw input: `buildJoinUrl` builds `${deckUrl}?roomCode=`
 * by concatenation, so a stored `http://host:3030/` would yield
 * `http://host:3030/?roomCode=…` — still functional, but gratuitously
 * different from the shape every other session produces. Normalizing once,
 * here, keeps every session's links identical in form regardless of how the
 * operator happened to type it.
 */
export function normalizeDeckUrl(value: string): string | undefined {
  if (value.length === 0 || value.length > MAX_DECK_URL_LENGTH)
    return undefined
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return undefined
  if (url.username || url.password)
    return undefined
  if (!url.hostname)
    return undefined
  if (url.hash)
    return undefined
  return url.href.replace(/\/+$/, '')
}

/**
 * Builds the plan 032d connect-key routes as one `connect` middleware, in the
 * same shape `createScreenshotUploadHandler` established for `POST
 * /api/screenshot`: anything that isn't one of this module's own routes falls
 * straight through to `next()`, so it can sit in the same chain as the
 * `/dashboard` and `/uploads` mounts without knowing about them.
 *
 * Two routes, deliberately separate:
 *
 * - `POST /api/connect-key` — admin-gated. Mints a key. This is the operator's
 *   half, run wherever the operator already holds the admin code.
 * - `POST /api/register` — gated only by a valid connect key. Redeems one and
 *   creates a session. This is the deck's half, run on a machine this server
 *   does not control and cannot hand a long-lived secret to. That asymmetry is
 *   the entire reason connect keys exist rather than just reusing the admin
 *   code on both ends.
 *
 * Neither route depends on the `/home` dashboard UI (032b, in flight
 * separately). Both are fully usable — and are tested — with `curl` alone.
 */
export function createRegistrationRoutes(options: CreateRegistrationRoutesOptions) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const url = new URL(req.url ?? '/', 'http://internal')

    if (req.method !== 'POST' || (url.pathname !== CONNECT_KEY_ROUTE && url.pathname !== REGISTER_ROUTE)) {
      next()
      return
    }

    if (url.pathname === CONNECT_KEY_ROUTE) {
      handleConnectKey(req, res, url, options)
      return
    }

    void handleRegister(req, res, options)
  }
}

function handleConnectKey(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: CreateRegistrationRoutesOptions,
) {
  // Checked before any state-changing work, mirroring `requireDashboardCode`'s
  // position ahead of `sirv` in the middleware chain: an unauthorized caller
  // must never reach `mintConnectKey`, because merely reaching it would mint a
  // real, redeemable key even if the response were then discarded.
  if (!isValidAdminCode(options.adminCode, suppliedAdminCode(req, url))) {
    // Same body for a missing code, a wrong code, and a server with no admin
    // code configured — "not authorized" and nothing further. In particular it
    // never says whether an admin code exists, which would tell a prober
    // whether this deployment is worth grinding at all.
    respondJson(res, 401, { error: 'not authorized' })
    return
  }

  const { key, expiresAt } = mintConnectKey()
  // 201, not 200: this created a server-side resource (a redeemable key) that
  // did not exist before, same as `POST /api/screenshot`'s 201.
  //
  // The key appears here and nowhere else — not in a log line, not in any
  // broadcast. `mintConnectKey` keeps no way to read it back out, so this
  // response body is genuinely the only copy that ever leaves the process.
  respondJson(res, 201, { key, expiresAt })
}

async function handleRegister(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateRegistrationRoutesOptions,
) {
  const sourceIp = req.socket.remoteAddress ?? undefined

  // First thing, before reading a byte of the body: a locked-out source gets
  // no work done on its behalf at all. See `connectKey.ts`'s
  // `MAX_FAILED_ATTEMPTS` for the threat model and the limits of this defense.
  // 429 rather than the shared 400 because this one *is* worth distinguishing:
  // it tells a real operator to slow down rather than to re-check their key,
  // and it reveals nothing about any credential — only that this source has
  // been failing.
  if (isRateLimited(sourceIp)) {
    respondJson(res, 429, { error: 'too many attempts, try again shortly' })
    return
  }

  function reject() {
    recordFailedAttempt(sourceIp)
    respondJson(res, 400, REGISTRATION_FAILED_BODY)
  }

  const body = parseRegisterBody(await readBody(req, MAX_REGISTER_BODY_BYTES))
  if (!body) {
    reject()
    return
  }

  // `deckUrl` is validated *before* the key is consumed, deliberately. Both
  // orders are equally safe against an oracle (every failure below produces
  // the identical response either way), so the tiebreaker is operator
  // ergonomics: a typo'd `deckUrl` should not silently burn a good key and
  // force a trip back to the dashboard to mint another. A caller with an
  // invalid key learns nothing from this ordering, because they never see a
  // different response for having gotten the URL right.
  const deckUrl = normalizeDeckUrl(body.deckUrl)
  if (!deckUrl) {
    reject()
    return
  }

  if (!consumeConnectKey(body.connectKey)) {
    reject()
    return
  }

  // The key is now burned and the input is validated, so this registration is
  // going to succeed — clear the source's failure history (an operator who
  // fat-fingered a paste twice before getting it right shouldn't carry that
  // into their next registration).
  clearFailedAttempts(sourceIp)

  // The *same* `createSession` every other session goes through — no
  // special-cased second path (plan 032a's own invariant, restated in
  // `createSession`'s doc comment). This session gets its own generated room
  // and presenter codes, its own uploads directory, its own entry in `rooms`,
  // and a `home:update` for any subscribed home view, without this handler
  // arranging any of it. Notably it does *not* get to choose its own codes:
  // `roomCode`/`presenterCode` are left `undefined` (i.e. "generate one")
  // rather than read from the request, so a caller cannot register a session
  // under a code they picked and thereby collide with — or squat on — a code
  // an operator is already handing out.
  const { roomCode, presenterCode } = options.createSession({ deckUrl })

  respondJson(res, 201, {
    roomCode,
    presenterCode,
    presenterUrl: options.buildPresenterUrl(deckUrl, presenterCode),
    // Always defined in practice — `createSession` generates a room code when
    // none is supplied, and one is never supplied here — but `buildJoinUrl`'s
    // contract still returns `undefined` for an empty code, so this stays
    // honest about that rather than asserting non-null.
    participantUrl: options.buildJoinUrl(deckUrl, roomCode),
  })
}
