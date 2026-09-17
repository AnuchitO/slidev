import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LaunchedDeck, SpawnDeckProcess } from './deckLauncher'
import type { CreateSessionOptions, CreateSessionResult } from './session'
import { isValidAdminCode } from './adminAuth'
import { parseJsonObject, readBody, respondJson, suppliedAdminCode } from './apiHttp'
import {
  adoptLaunchedDeck,
  DeckLaunchError,
  discardLaunchedDeck,
  launchPresentation,
  stopSpawnedDeck,
} from './deckLauncher'
import { resolvePresentation } from './presentations'

const LAUNCH_ROUTE = '/api/launch'
const STOP_ROUTE = '/api/stop'

/**
 * Hard cap on either route's request body, in bytes. Both bodies are a single
 * short identifier (`presentationId`, `roomCode`); 4 KiB is orders of
 * magnitude more than any legitimate one needs. Same value and same reasoning
 * as `registrationRoutes.ts`'s `MAX_REGISTER_BODY_BYTES`, and enforced by the
 * same `readBody` — bounded *while reading*, so the cap actually limits
 * allocation rather than merely reporting on it afterwards.
 */
const MAX_BODY_BYTES = 4096

/**
 * Plan 032c's two state-changing operator actions: start a discovered
 * presentation as a child process, and stop a live session.
 *
 * ## Route naming
 *
 * `POST /api/launch` and `POST /api/stop`, with their subject in the JSON
 * body, rather than `POST /api/presentations/:id/launch` and
 * `POST /api/sessions/:roomCode/stop`. Three reasons, in order of weight:
 *
 * 1. **It matches what this package already does.** Every other JSON endpoint
 *    here is a flat path with its subject in the body — `POST /api/register`
 *    takes `{ connectKey, deckUrl }`, `POST /api/connect-key` takes nothing,
 *    `POST /api/screenshot` takes a multipart body. There is not one path
 *    parameter anywhere in this server's HTTP surface, and inventing a
 *    `:param` convention for two routes would mean this package now has two
 *    conventions.
 * 2. **It keeps identifiers out of logs.** A presentation id in the path lands
 *    in every access log, proxy log and `Referer` between the operator and
 *    this process — the same argument `apiHttp.ts`'s `ADMIN_CODE_HEADER`
 *    comment makes for the admin code, applied to a value that is less secret
 *    but no more useful to leak.
 * 3. **It avoids a real mounting hazard.** `server.ts` mounts
 *    `requireAdminCode` on the `/api/presentations` *prefix*, and that gate
 *    only reads `?code=`. A launch route living under that prefix would
 *    silently reject the header form of the credential these JSON routes
 *    otherwise accept — one route with two contradictory answers to "how do I
 *    authenticate", which is exactly the kind of thing that gets "fixed" later
 *    by weakening a gate.
 *
 * ## Auth
 *
 * Both routes are gated on the cross-room admin code (`adminAuth.ts`), checked
 * **before any work at all** — in particular before `resolvePresentationDir`
 * touches the filesystem and before anything is spawned. An unauthenticated
 * caller cannot use these routes to learn whether the discovery directory
 * exists, which presentation ids are real, or which room codes are live.
 *
 * Same self-contained posture as `createRegistrationRoutes`: the gate is
 * inside this middleware rather than mounted in front of it, so the routes
 * carry their own credential requirement regardless of where in the chain
 * `server.ts` mounts them.
 */
export interface CreateDeckLaunchRoutesOptions {
  /**
   * The process-wide admin code (`adminAuth.ts`). An empty string means "no
   * admin code configured", which `isValidAdminCode` fails closed on — both
   * routes are then unreachable, never open.
   */
  adminCode: string
  /**
   * The configured discovery root, or `undefined` when this deployment never
   * opted into discovery. `undefined` makes `resolvePresentationDir` resolve
   * nothing, so every launch attempt is a 404 and nothing is ever spawned —
   * which is the correct behavior for a server that was never told where decks
   * live, and keeps 032c a complete no-op for deployments that predate it.
   *
   * Configuration, never client input; see
   * `CreateMuanCompanionServerOptions.presentationsDir`.
   */
  presentationsDir: string | undefined
  /**
   * The externally-reachable URL of this server, injected into the spawned
   * deck's env as `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL`, and the origin the
   * spawned deck's own participant URL is built from. Resolved lazily (a
   * function, not a string) because its default is derived from the port this
   * server is actually listening on, which is not known at construction time —
   * see `server.ts`'s `resolvePublicUrl`.
   */
  publicUrl: () => string
  /**
   * How a successful launch creates its session — `server.ts`'s
   * `createSessionAndBroadcast`, the same wrapper `POST /api/register` is
   * given, so a launched session cannot be one the home view never hears
   * about.
   */
  createSession: (options: CreateSessionOptions) => CreateSessionResult
  /**
   * How a session is torn down — `server.ts`'s `destroySessionAndBroadcast`.
   * Used by `POST /api/stop` and by the crash handler below, so a session that
   * ends because its process died goes through the *identical* path as one an
   * operator stopped on purpose.
   */
  destroySession: (roomCode: string) => boolean
  /** Builds the participant-facing join URL — `server.ts`'s `buildJoinUrl`. */
  buildJoinUrl: (deckUrl: string, roomCode: string) => string | undefined
  /** Builds the presenter-facing URL — `server.ts`'s `buildPresenterUrl`. */
  buildPresenterUrl: (deckUrl: string, presenterCode: string) => string
  /** Pass `--remote=` to spawned decks — see `buildSlidevArgs`. */
  remote?: boolean
  /** Explicit Slidev CLI path — see `resolveSlidevBinary`. */
  slidevBinary?: string
  /** Concurrency cap override — see `MAX_CONCURRENT_SPAWNED_DECKS`. */
  maxConcurrent?: number
  /** Readiness-probe overrides, for tests — see `launchPresentation`. */
  readinessTimeoutMs?: number
  readinessPollIntervalMs?: number
  /** Injectable spawn, for tests — see `SpawnDeckProcess`. */
  spawn?: SpawnDeckProcess
  /** Injectable port allocator, for tests — see `allocateEphemeralPort`. */
  allocatePort?: () => Promise<number>
}

export function createDeckLaunchRoutes(options: CreateDeckLaunchRoutesOptions) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    const url = new URL(req.url ?? '/', 'http://internal')

    if (req.method !== 'POST' || (url.pathname !== LAUNCH_ROUTE && url.pathname !== STOP_ROUTE)) {
      next()
      return
    }

    // Before the body is read, before the filesystem is touched, before
    // anything is spawned. Same body for a missing code, a wrong code, and a
    // server with no admin code configured — it never says whether an admin
    // code exists, matching every other gate in this package.
    if (!isValidAdminCode(options.adminCode, suppliedAdminCode(req, url))) {
      respondJson(res, 401, { error: 'not authorized' })
      return
    }

    if (url.pathname === LAUNCH_ROUTE) {
      void handleLaunch(req, res, options)
      return
    }

    void handleStop(req, res, options)
  }
}

/**
 * Reads one required string field out of a JSON body. Returns `undefined` for
 * a missing/oversized/unparseable body, a non-object, a missing field, a
 * non-string field, or an empty string — every one of which is the same
 * "malformed request" to the caller.
 */
async function readStringField(req: IncomingMessage, field: string): Promise<string | undefined> {
  const parsed = parseJsonObject(await readBody(req, MAX_BODY_BYTES))
  const value = parsed?.[field]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function handleLaunch(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateDeckLaunchRoutesOptions,
) {
  const presentationId = await readStringField(req, 'presentationId')
  if (!presentationId) {
    respondJson(res, 400, { error: 'presentationId is required' })
    return
  }

  // **The one path resolution in all of 032c.** `resolvePresentation` is an
  // exact-match lookup against a freshly-scanned configured root — the id is
  // compared against strings the filesystem itself just produced, so `..`, an
  // absolute path, a separator, or any percent-decoded traversal simply
  // matches nothing. There is deliberately no `join(root, id)` anywhere in this
  // feature; see that function's own doc comment for why the exact-match shape
  // is the point rather than an implementation detail. Its `title` rides along
  // with the resolved `dir` so the session created below can label itself for
  // the home view without a second scan of the discovery root.
  const presentation = resolvePresentation(options.presentationsDir, presentationId)
  if (!presentation) {
    // 404 and **no spawn attempt** — this is the assertion the launch route's
    // test pins down. An unknown id is indistinguishable from a known id in a
    // deployment with discovery switched off, which is the correct amount of
    // information to give a caller who already holds the admin code (i.e.
    // none extra; they can list the real ids from `GET /api/presentations`).
    respondJson(res, 404, { error: 'unknown presentation' })
    return
  }

  const serverUrl = options.publicUrl()

  let deck: LaunchedDeck
  try {
    deck = await launchPresentation({
      presentationDir: presentation.dir,
      presentationId,
      serverUrl,
      remote: options.remote,
      slidevBinary: options.slidevBinary,
      maxConcurrent: options.maxConcurrent,
      readinessTimeoutMs: options.readinessTimeoutMs,
      readinessPollIntervalMs: options.readinessPollIntervalMs,
      spawn: options.spawn,
      allocatePort: options.allocatePort,
    })
  }
  catch (error) {
    if (error instanceof DeckLaunchError) {
      // 503 for the cap ("this server, right now, cannot take another one" —
      // a temporary condition the operator fixes by stopping something), 502
      // for a deck that would not start ("the upstream thing I tried to run
      // failed"). Both carry the launcher's message, which for a failed start
      // includes the tail of the child's own output — plan 032's "surfacing
      // 'this deck failed to start' instead of a silent timeout".
      //
      // That message is shown to a caller who already holds the admin code,
      // i.e. the server's operator, and it can contain host paths from a Vite
      // stack trace. That is the right trade for the one audience that can
      // reach this route: an operator debugging their own deck needs the real
      // error, and the credential required to see it already grants strictly
      // more than knowing a path.
      respondJson(res, error.reason === 'at-capacity' ? 503 : 502, {
        error: error.message,
        reason: error.reason,
      })
      return
    }
    throw error
  }

  // The deck's own URL: this server's public origin with the child's port.
  //
  // The spawned deck runs on *this* host — plan 032's Flow A is explicitly
  // local-only ("no remote-exec, no SSH-to-another-host design needed") — so
  // the host participants reach it at is the host they reach this server at,
  // and the only thing that differs is the port. Deriving it from `publicUrl`
  // rather than hardcoding `localhost` is what makes a launched deck's
  // participant link work for anyone but the operator.
  //
  // Known limitation, stated rather than papered over: a deployment that
  // terminates TLS at a reverse proxy and sets `publicUrl` to that proxy's
  // origin will get a deck URL of `https://proxy-host:<ephemeral port>`, which
  // the proxy is not forwarding. Flow A assumes the spawned deck's port is
  // directly reachable at the same host as this server. A deployment where
  // that is not true should use Flow B (032d), where the operator supplies the
  // deck's real URL.
  const deckUrl = deckUrlFor(serverUrl, deck.port)

  let session: CreateSessionResult
  try {
    session = options.createSession({ deckUrl, presentationTitle: presentation.title })
  }
  catch (error) {
    // `createSession` throws only on a duplicate room code, which for a
    // generated code means it lost a ten-in-a-row lottery — but if it ever
    // does happen, the child is already running and would otherwise leak,
    // holding a port and one of the cap's slots for the life of the process.
    discardLaunchedDeck(deck)
    throw error
  }

  // Bind the child to the session, with the crash handler plan 032 asks for.
  adoptLaunchedDeck(session.roomCode, deck, () => {
    // The child died on its own. Tear the session down through the *same*
    // create/destroy-and-broadcast pairing `POST /api/stop` and every other
    // session-ending path uses, so a subscribed `/home` view sees the row
    // disappear exactly as it would for a deliberate stop. Leaving the session
    // in place would leave the home view advertising a participant URL that
    // nothing is serving.
    options.destroySession(session.roomCode)
  })

  // The same response shape `POST /api/register` returns, field for field.
  // Both routes answer the same question ("a session now exists — where do the
  // presenter and the participants go?"), and the `/home` page consumes them
  // with the same code path, so they must not differ in spelling.
  respondJson(res, 201, {
    roomCode: session.roomCode,
    presenterCode: session.presenterCode,
    presenterUrl: options.buildPresenterUrl(deckUrl, session.presenterCode),
    participantUrl: options.buildJoinUrl(deckUrl, session.roomCode),
  })
}

/**
 * The spawned deck's base URL: `publicUrl`'s scheme and hostname, the child's
 * port, nothing else. A malformed `publicUrl` falls back to loopback rather
 * than throwing — a deck that started successfully should not fail its launch
 * over a misconfigured env var, and `http://localhost:<port>` is at least
 * correct for the operator sitting at the host.
 */
function deckUrlFor(publicUrl: string, port: number): string {
  try {
    const parsed = new URL(publicUrl)
    return `${parsed.protocol}//${parsed.hostname}:${port}`
  }
  catch {
    return `http://localhost:${port}`
  }
}

async function handleStop(
  req: IncomingMessage,
  res: ServerResponse,
  options: CreateDeckLaunchRoutesOptions,
) {
  const roomCode = await readStringField(req, 'roomCode')
  if (!roomCode) {
    respondJson(res, 400, { error: 'roomCode is required' })
    return
  }

  // **The Flow-B path**: a session registered by a deck the server did not
  // start has no child here, and `stopSpawnedDeck` is a clean no-op that
  // answers `false` for it. The session is destroyed either way. This
  // asymmetry is the whole reason this route does not simply kill a process
  // and call it done: 032d's sessions are just as stoppable, they just have
  // nothing of ours to kill, and the operator's own `slidev dev` on their own
  // laptop is emphatically not this server's to terminate.
  //
  // Reported back as `hadProcess` so an operator can tell "I stopped a
  // process" from "I ended a session whose deck is someone else's to stop".
  const hadProcess = stopSpawnedDeck(roomCode)

  const destroyed = options.destroySession(roomCode)
  if (!destroyed) {
    // No such session. 404 rather than a cheerful 200: an operator whose Stop
    // click did nothing should be told, and the room code they named is one
    // they read off their own admin-gated home view, so "that room does not
    // exist" reveals nothing they could not already enumerate.
    respondJson(res, 404, { error: 'unknown session' })
    return
  }

  respondJson(res, 200, { stopped: true, hadProcess })
}
