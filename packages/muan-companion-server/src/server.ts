import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'socket.io'
import type { WorkshopAuthConfig } from './auth'
import type { HelpRequestKind, ParticipantVisibility, StepState } from './session'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import connect from 'connect'
import { join } from 'pathe'
import QRCode from 'qrcode'
import sirv from 'sirv'
import { Server as SocketIOServer } from 'socket.io'
import { isValidPresenterCode, isValidRoomCode } from './auth'
import { HEARTBEAT_INTERVAL_MS, sweepStaleParticipants } from './presence'
import { createScreenshotUploadHandler } from './screenshotUpload'
import {
  addErrorReport,
  addParticipantMessage,
  addPendingConnection,
  addPresenterMessage,
  confirmResolution,
  joinParticipant,
  listErrorReports,
  listPendingConnections,
  listStepStatus,
  participants,
  removeParticipant,
  removeParticipantSocket,
  removePendingConnection,
  resolveErrorReport,
  session,
  setStepStatus,
} from './session'
import { resolveUploadPath } from './uploads'

export interface CreateMuanCompanionServerOptions {
  /** CORS origin for the Socket.io handshake. Defaults to `*`. */
  origin?: string
  /**
   * Required to `participant:join` (PRD §12 / plan 029 Step 1). An unset
   * (undefined/empty) code means *every* join is rejected — see `auth.ts`'s
   * `isValidCode`: a missing configured code is never satisfied by "nothing
   * supplied" behaving like a wildcard. Fail closed, not open, if an
   * operator forgets to configure this (see `index.ts`'s startup warning).
   */
  roomCode?: string
  /**
   * Required for every `presenter:*` event and to open `/dashboard` (PRD
   * §12 / plan 029 Step 1) — deliberately a *separate* secret from
   * `roomCode`, never derivable from it, so a participant who knows the room
   * code still can't move slides or open the dashboard. Same fail-closed
   * behavior as `roomCode` when unset.
   */
  presenterCode?: string
  /**
   * How often the staleness sweep (`presence.ts`'s `sweepStaleParticipants`)
   * runs. Defaults to `HEARTBEAT_INTERVAL_MS` (5s) in production. Test-only
   * override so `server.test.ts` can verify the sweep is actually wired up
   * without waiting a real 15s+ for staleness to accrue on every run.
   */
  sweepIntervalMs?: number
  /**
   * The URL a participant's browser should land on to join the deck itself —
   * i.e. Slidev's own dev server, a *different* process/port from this one
   * (see the package README's architecture notes: this server is the
   * companion sync backend, not the thing that serves slide content).
   * Defaults to `DEFAULT_DECK_URL` (Slidev's own default dev port) when
   * unset, so a server started with no configuration at all still produces a
   * well-formed (if likely wrong for the operator's real setup) join URL
   * rather than an obviously-broken one — matches this option's own
   * optionality: `index.ts` always supplies a real value (from
   * `SLIDEV_MUAN_COMPANION_DECK_URL`, itself defaulted the same way — see
   * that file), but a server constructed directly (every test in
   * `server.test.ts` that doesn't care about the join link) shouldn't have
   * to supply one just to exercise unrelated behavior.
   */
  deckUrl?: string
}

/**
 * Slidev's own default `dev`/`preview` port
 * (https://sli.dev/guide/) — the sane fallback for `deckUrl` when an
 * operator hasn't set `SLIDEV_MUAN_COMPANION_DECK_URL` (e.g. a quick local
 * trial run). Exported so `index.ts` can default its own env-var read to the
 * same* literal rather than two copies of this string drifting apart.
 */
export const DEFAULT_DECK_URL = 'http://localhost:3030'

/**
 * Builds the participant-facing "join this workshop" URL from the deck URL
 * and room code — the single place this specific query-param name/encoding
 * is decided, shared by `createMuanCompanionServer`'s `dashboard:join`
 * payload (consumed by the dashboard's "Share this workshop" panel) and
 * `index.ts`'s startup log, so the two can never drift apart on the exact
 * shape participants are expected to arrive with (the addon's
 * `getRoomCodeFromUrl` — `addon-muan-companion/src/roomCode.ts` — is the
 * other half of this contract: it reads back exactly the `roomCode` param
 * this function writes).
 *
 * Returns `undefined` when there's no room code to embed — a join link with
 * no code in it would silently send participants to the ordinary join form
 * with nothing prefilled, which isn't a "link", it's just the deck's plain
 * URL. Matches this file's existing fail-closed posture elsewhere (e.g. the
 * dashboard's codes panel showing nothing until both codes are known): if
 * the operator hasn't configured a room code, there's nothing valid to
 * share yet.
 */
export function buildJoinUrl(deckUrl: string, roomCode: string): string | undefined {
  return roomCode ? `${deckUrl}?roomCode=${encodeURIComponent(roomCode)}` : undefined
}

export interface MuanCompanionServer {
  httpServer: HttpServer
  io: SocketIOServer
}

/**
 * The one field every `presenter:*` event payload carries in common (plan
 * 029 Step 1). Named and shared, rather than `presenterCode?: string`
 * appearing as its own inline fragment in six different handler payload
 * types below, so `requirePresenterCode`'s generic constraint (immediately
 * below) has one real type to reference instead of duck-typing against a
 * structurally-repeated-but-never-named shape.
 */
interface WithPresenterCode {
  presenterCode?: string
}

/**
 * Wraps a `presenter:*` socket handler so the shared "no-op on
 * invalid/missing presenterCode" gate (plan 029 Step 1) lives in one place
 * instead of being repeated as an `if (!isValidPresenterCode(...)) return`
 * at the top of every handler below — six of them, before this existed,
 * all with the identical rejection shape: do nothing at all, no ack, no
 * disconnect, matching each event's pre-029 no-ack shape and the plan's own
 * verify step ("rejected/ignored, verified via ... the fact that no other
 * client's slide moves") rather than surfacing an error back to a
 * stray/misconfigured client. `dashboard:join` deliberately does **not**
 * use this wrapper — its rejection acks `{ ok: false }` instead of silently
 * doing nothing, a genuinely different shape, not just a variant worth
 * generalizing this helper over for a single caller.
 */
function requirePresenterCode<T extends WithPresenterCode>(authConfig: WorkshopAuthConfig, handler: (payload: T) => void) {
  return (payload: T) => {
    if (!isValidPresenterCode(authConfig, payload.presenterCode))
      return
    handler(payload)
  }
}

/**
 * The `dashboard:join` ack shape — named and exported rather than inlined
 * at the one `ack?: (result: {...}) => void` parameter that used to declare
 * it, both so the handler's own signature reads as one line instead of a
 * multi-field inline type, and so `server.test.ts` (which used to keep an
 * independent copy of this exact shape, `DashboardJoinAck`, purely for its
 * own assertions) can import this instead — one definition, so the two can
 * never quietly drift apart on a field name/optionality.
 */
export interface DashboardJoinAck {
  ok: boolean
  roomCode?: string
  presenterCode?: string
  /**
   * The Slidev deck URL participants should open — see
   * `CreateMuanCompanionServerOptions.deckUrl`'s own doc comment. Always
   * present alongside `ok: true`: unlike `joinUrl`/`joinQrDataUrl` below,
   * this doesn't depend on a room code being configured (it's just the
   * server's own static config), so there's no "nothing valid to show
   * yet" case for it the way there is for the other two.
   */
  deckUrl?: string
  /** See `buildJoinUrl`'s doc comment — `undefined` iff no room code is configured. */
  joinUrl?: string
  /**
   * A `data:image/png;base64,...` string encoding `joinUrl` (see
   * `getJoinQrDataUrl` below) — `undefined` in lockstep with `joinUrl`
   * (there's nothing to encode without it), never a separate failure
   * mode of its own.
   */
  joinQrDataUrl?: string
}

// Sockets that have joined this room get every `state:update` broadcast —
// participant sockets never join it, so the full roster/step-status payload
// isn't sent to every participant on every other participant's keystroke
// (plan 027 Step 1 / STOP condition 3).
const DASHBOARD_ROOM = 'dashboard'

// The dashboard (plan 027 Step 3) is served as a small static page by this
// same process — same origin as the Socket.io server, so no CORS
// configuration is needed for it. See this package's README for why (option
// 1 of the two considered in the plan).
const DASHBOARD_PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'dashboard')

function buildStateUpdate() {
  return {
    currentSlideIndex: session.currentSlideIndex,
    currentStepId: session.currentStepId,
    participants: [...participants.values()],
    // Sockets that connected and announced themselves (`participant:connecting`
    // below) but haven't completed `participant:join` yet — the "someone's
    // here but we don't know their name" visibility feature. A *separate*
    // field from `participants` above, not folded in as a fake participant
    // row: `Participant` requires a real `name`/`id`, and every other
    // consumer of `participants` (error reports, step status, the resume
    // flow) genuinely needs that to be true. The dashboard renders the two
    // together (see `public/dashboard/index.html`).
    pendingConnections: listPendingConnections(),
    stepStatus: listStepStatus(),
    // PRD §10's literal `state:update` shape (`{ currentSlideIndex,
    // participants[], errors[] }`) — folded straight into the existing
    // payload rather than a separate event (plan 028 Step 1's decision):
    // error reports are rare compared to step-status churn, so the combined
    // payload isn't a size/frequency problem at realistic volumes, and the
    // dashboard client needs no restructuring beyond rendering a new field.
    errors: listErrorReports(),
  }
}

function broadcastStateUpdate(io: SocketIOServer) {
  io.to(DASHBOARD_ROOM).emit('state:update', buildStateUpdate())
}

/**
 * Gates the `/dashboard` static route on the presenter credential, supplied
 * as a `?code=` query param (plan 029 Step 1's "simple query param... gate
 * on the dashboard's static route" option). Chosen over HTTP Basic Auth so
 * the *same* value the operator hands out in the dashboard URL is also what
 * `public/dashboard/index.html`'s own script reads back out of
 * `location.search` to authenticate its Socket.io `dashboard:join` — one
 * credential, one place it lives (the URL the operator was given), never
 * embedded in any served bundle. Runs *before* `sirv` in the middleware
 * chain below, so an invalid/missing code never reaches the static file
 * handler at all — satisfies plan 029's "dashboard route ... requires the
 * presenter credential to access" done-criterion for the route itself, not
 * just the Socket.io data feed layered on top of it.
 */
function requireDashboardCode(authConfig: WorkshopAuthConfig) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://internal')
    const supplied = url.searchParams.get('code') ?? undefined
    if (isValidPresenterCode(authConfig, supplied)) {
      next()
      return
    }
    res.statusCode = 401
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Presenter code required (append ?code=<presenterCode> to this URL).')
  }
}

/**
 * Builds the sync server's http+Socket.io instances without starting to
 * listen — kept separate from `index.ts`'s entrypoint so tests can drive it
 * against an ephemeral port, and so 027+ can extend the event handling here
 * without touching process bootstrapping.
 */
export function createMuanCompanionServer(options: CreateMuanCompanionServerOptions = {}): MuanCompanionServer {
  const authConfig: WorkshopAuthConfig = {
    roomCode: options.roomCode ?? '',
    presenterCode: options.presenterCode ?? '',
  }

  // Computed once, here, rather than per-request: both the deck URL and the
  // room code are fixed for this server process's entire lifetime today (no
  // dynamic code rotation exists — see the README's threat-model note), so
  // there's nothing that would make a second computation ever differ from
  // the first. `joinUrl` is `undefined` whenever `buildJoinUrl` finds no room
  // code configured — see that function's own doc comment for why that's the
  // right behavior rather than emitting a link that doesn't actually work.
  const deckUrl = options.deckUrl ?? DEFAULT_DECK_URL
  const joinUrl = buildJoinUrl(deckUrl, authConfig.roomCode)

  // `QRCode.toDataURL` is async (it's doing real PNG encoding work), and
  // deliberately *not* awaited right here at server-construction time: this
  // function is called synchronously by every test in `server.test.ts` (and
  // by `index.ts` before `httpServer.listen`), and forcing all of them to
  // pay for a PNG encode up front — for a value most of them never touch —
  // would slow the whole suite for no benefit. Instead this is computed
  // lazily, the *first* time anything actually asks for it
  // (`getJoinQrDataUrl` below, called from the `dashboard:join` handler), and
  // the resulting `Promise` (not just its resolved value) is cached in this
  // closure so a second dashboard tab opening moments later reuses the same
  // in-flight/completed encode instead of re-generating identical bytes.
  // Caching the `Promise` rather than waiting for it once and caching the
  // string is what makes that safe against two `dashboard:join` calls racing
  // before the first encode finishes.
  let joinQrDataUrlPromise: Promise<string | undefined> | undefined
  function getJoinQrDataUrl(): Promise<string | undefined> {
    if (!joinUrl)
      return Promise.resolve(undefined)
    if (!joinQrDataUrlPromise) {
      // `.catch(() => undefined)` rather than letting a rejection propagate:
      // `dashboard:join`'s handler `await`s this directly, and socket.io
      // doesn't catch a listener's own async rejections for you — an
      // unhandled one here would surface as a process-level
      // `unhandledRejection`, not a contained failure. The QR code is a
      // convenience on top of the plain `joinUrl` text link (still shown
      // regardless), not load-bearing, so degrading to "no QR image" beats
      // crashing the dashboard connection over it.
      joinQrDataUrlPromise = QRCode.toDataURL(joinUrl).catch(() => undefined)
    }
    return joinQrDataUrlPromise
  }

  // `sirv` is mounted on the connect app *before* Socket.io attaches to the
  // same `httpServer` below. Engine.io's `attach()` caches whatever
  // `request` listeners are already registered, removes them, and installs
  // its own listener that intercepts only requests under its own path
  // (`/socket.io/` by default) — everything else falls through to the
  // cached listeners (see `engine.io`'s `Server.prototype.attach`). That's
  // what makes serving `/dashboard` from the *same* http server safe:
  // Socket.io's own handshake/polling traffic is untouched, and this app
  // only ever sees non-`/socket.io/` requests. Mounting sirv under a
  // `/dashboard` path prefix (rather than at `/`) keeps this deliberate and
  // explicit rather than relying on that fallthrough for every path.
  const app = connect()

  // CORS (fixes a real bug found in manual testing): the participant's
  // browser loads the deck from Slidev's own dev server (e.g.
  // `localhost:3030`) and `fetch()`s `POST /api/screenshot` on *this*
  // server (e.g. `localhost:3710`) directly — a cross-origin request.
  // `multipart/form-data` with no custom headers is a CORS-safelisted
  // "simple request", so the browser still *sends* it and this server still
  // processes the upload (which is why the dashboard could already show a
  // screenshot that the reporting participant's own browser insisted had
  // failed to send) — but without an `Access-Control-Allow-Origin` header on
  // the response, the browser refuses to let the page's own JS read that
  // response, so `fetch()` rejects and `ErrorReportWidget.vue` shows "Could
  // not send the report" for a request that, server-side, fully succeeded.
  // Socket.io's own `cors` option (below) only covers its own handshake —
  // it does nothing for plain HTTP routes served by this `connect` app, so
  // they need their own CORS header. Applied globally (not just on
  // `/api/screenshot`) since `/dashboard` and `/uploads` are same-origin in
  // normal use and an extra allow-origin header on a same-origin response is
  // simply ignored by the browser — cheaper than special-casing one route.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', options.origin ?? '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    next()
  })

  app.use('/dashboard', requireDashboardCode(authConfig))
  app.use('/dashboard', sirv(DASHBOARD_PUBLIC_DIR, { single: true, dev: true, etag: true }))

  // Session-scoped uploads dir (plan 028 Step 1): a fresh `mkdtemp`-ed
  // directory per server instance, not a fixed path in the repo — matches
  // the PRD's "keep them in memory/disk for the session, no cross-restart
  // persistence requirement" (§4 non-goals) without needing an explicit
  // cleanup job, and gives every test run (each of which creates its own
  // server) an isolated directory rather than sharing one across runs.
  const uploadsDir = mkdtempSync(join(tmpdir(), 'slidev-muan-companion-uploads-'))

  // `GET /uploads/:filename` — served by the same `sirv` used for the
  // dashboard, from the confined `uploadsDir` above. `resolveUploadPath`
  // (`uploads.ts`) is checked *first*, ahead of sirv, so a path-traversal
  // attempt or any filename that doesn't match the server's own
  // `${randomUUID()}.${ext}` naming scheme is rejected before sirv ever
  // touches the filesystem — defense-in-depth on top of sirv's own path
  // normalization, not a replacement for it.
  app.use('/uploads', (req, res, next) => {
    const raw = (req.url ?? '').replace(/^\/+/, '').split('?')[0]
    let requested: string
    try {
      requested = decodeURIComponent(raw)
    }
    catch {
      // Malformed percent-encoding — not a filename this server ever wrote,
      // reject rather than guess.
      res.writeHead(400).end()
      return
    }
    if (!resolveUploadPath(uploadsDir, requested)) {
      res.writeHead(404).end()
      return
    }
    next()
  })
  app.use('/uploads', sirv(uploadsDir, { dev: true, etag: true }))

  const httpServer = createServer(app)
  const io = new SocketIOServer(httpServer, {
    cors: { origin: options.origin ?? '*' },
  })

  app.use(createScreenshotUploadHandler(uploadsDir, () => broadcastStateUpdate(io)))

  function touchLastSeen(participantId: string | undefined) {
    if (!participantId)
      return
    const participant = participants.get(participantId)
    if (participant)
      participant.lastSeen = Date.now()
  }

  // A client can only ever act on behalf of the participant it joined as
  // (`socket.data.participantId`, set on `participant:join` below) — shared
  // by every participant-scoped handler that needs that id and treats a
  // not-yet-joined socket as a no-op rather than a guess. Named and pulled
  // out once a sixth call site (`participant:heartbeat`) started repeating
  // the identical `socket.data.participantId as string | undefined` cast.
  function getJoinedParticipantId(socket: Socket): string | undefined {
    return socket.data.participantId as string | undefined
  }

  // Looks up the participant who filed a given error report, or does
  // nothing — shared by every handler that needs to notify the *specific*
  // reporting participant back (mirrors `presenter:resolveError`'s original
  // inline version of this same lookup pair, pulled out once a second
  // handler needed it too). Defined once here rather than freshly per
  // connection: neither this nor `notifyReporter`/`errorReportOwnedBy`
  // below reference `socket` at all, so redefining them inside
  // `io.on('connection', ...)` would just allocate three new, identical
  // closures on every single connection for no behavioral difference.
  // Takes the report itself, not `| undefined` — both call sites below
  // already check their own lookup's result (`if (!report) return`) before
  // ever reaching this, so accepting `undefined` here would just be a
  // second, unreachable defensive check duplicating the caller's own.
  // Returning `undefined` remains a real, reachable outcome of *this*
  // function though — the reporting participant's own record can be gone
  // (e.g. `presenter:kickParticipant` deleted it — reports are append-only,
  // see `removeParticipant`'s doc comment) even though their past report
  // still exists — `notifyReporter` below is what actually no-ops on that.
  function reporterOf(report: { participantId: string }) {
    return participants.get(report.participantId)
  }

  // The ownership check `participant:confirmResolution` and
  // `participant:addMessage` below both need: a report exists *and* it
  // belongs to the calling socket's own participant. Returns the report
  // itself (not just a boolean) so callers don't need a second lookup.
  function errorReportOwnedBy(errorId: string, participantId: string) {
    return listErrorReports().find(r => r.id === errorId && r.participantId === participantId)
  }

  // Targets *every* socket currently in `reporter.socketIds`, not just one:
  // a participant can have this identity open in more than one tab (the
  // `localStorage` resume), and `.to()` accepts an array of rooms — each
  // socket is implicitly in a room named by its own id — so every open tab
  // of theirs sees the notification, not just whichever tab happened to
  // join most recently. If they've disconnected entirely, `socketIds` is
  // empty and `io.to([])` is a harmless no-op — there's nothing to notify.
  function notifyReporter(reporter: { socketIds: string[] } | undefined, event: string, payload: unknown) {
    if (reporter)
      io.to(reporter.socketIds).emit(event, payload)
  }

  /**
   * M1's slide-sync events. Split out of the single giant `io.on('connection', ...)`
   * body (027-030's handlers had all accumulated inline there) purely for
   * navigability — every closure captured here (`io`, `authConfig`) is
   * exactly what these handlers already relied on, nothing changes about
   * when or how they fire.
   */
  function registerSlideHandlers(socket: Socket) {
    socket.on('presenter:setSlide', requirePresenterCode(authConfig, ({ index }: { index: number, presenterCode?: string }) => {
      // Plan 029 Step 1: gated on the presenter credential, distinct from
      // the participant room code (`requirePresenterCode` above) — a
      // stray/misconfigured client shouldn't be able to crash the server,
      // so an invalid/missing code is a silent no-op, not a thrown error or
      // disconnect (matches this event's pre-029 shape — no ack — and the
      // plan's own verify step: "rejected/ignored, verified via ... the
      // fact that no other client's slide moves").
      session.currentSlideIndex = index
      io.emit('slide:changed', { index })
      broadcastStateUpdate(io)
    }))

    // Not in PRD §10's literal event list — a deliberate addition (mirroring
    // M1's `slide:sync` precedent) so the dashboard can show a "current
    // step" status column (plan 027 Step 3) without the server parsing deck
    // markdown itself. Kept as its *own* event rather than folded into
    // `presenter:setSlide` above: the addon computes `stepId` via a real
    // mounted component reading `useNav().currentFrontmatter`
    // (`StepReporter.vue`), which updates on its own reactive schedule,
    // independent of when the router's `afterEach` (which drives
    // `presenter:setSlide`) fires — see that component's own comment for
    // why they can't share one event.
    socket.on('presenter:setStep', requirePresenterCode(authConfig, ({ stepId }: { stepId: string, presenterCode?: string }) => {
      session.currentStepId = stepId
      broadcastStateUpdate(io)
    }))
  }

  /**
   * Participant identity: the pre-join "someone's here" signal, the actual
   * `participant:join`/resume handshake, and the `disconnect` cleanup that
   * closes out whichever of those two states a socket was last in. Grouped
   * together (rather than splitting `disconnect` off into its own function)
   * since all three exist to answer the same question over a socket's
   * lifetime — "who is this, if anyone, and are they still here" — in a
   * strict progression: connect → (maybe) pending → (maybe) joined →
   * disconnect.
   */
  function registerParticipantLifecycleHandlers(socket: Socket) {
    // Pre-join dashboard visibility: `JoinScreen.vue` emits this once, on
    // mount, before the participant has typed a name or clicked Join —
    // *not* automatically on every connection, which is what lets this stay
    // participant-specific rather than also firing for the presenter's own
    // route or the dashboard's own socket (neither ever mounts
    // `JoinScreen.vue`, so neither ever emits this). Reported from live use:
    // the join screen is a client-side UI gate, not a content access
    // control (see that component's own comment) — a participant can bypass
    // it via devtools and watch the deck without ever joining. This can't
    // close that gap (nothing server-side can, short of gating the deck's
    // own static assets, well outside this addon's scope), but it makes the
    // presence visible on the dashboard instead of invisible, and pairs
    // with `presenter:kickPendingConnection` (`registerKickHandlers` below)
    // to let the presenter disconnect a socket they don't want around.
    socket.on('participant:connecting', () => {
      addPendingConnection(socket.id)
      broadcastStateUpdate(io)
    })

    socket.on(
      'participant:join',
      (
        { name, participantId, roomCode }: { name: string, participantId?: string, roomCode?: string },
        // `resumed` (plan 030 Step 1) tells the caller whether a *requested*
        // resume (a `participantId` was supplied) actually succeeded — the
        // addon's `JoinScreen.vue` uses this to distinguish "resumed
        // silently, skip the join prompt" from "resume fell back to a fresh
        // identity, show the prompt again" rather than assuming success.
        ack?: (payload: { participantId: string, currentSlideIndex: number, resumed: boolean } | { error: 'invalid_room_code' }) => void,
      ) => {
        // Plan 029 Step 1: the participant room code, distinct from (and
        // lower-privilege than) the presenter credential above. Rejected via
        // the ack rather than a forced disconnect — lets the join screen
        // show "wrong code" and let the participant retry without having to
        // reload/reconnect the socket.
        //
        // Follow-up fix: a resume of an *already-known* identity is exempt
        // from this gate. The unguessable `participantId` (a 122-bit
        // `crypto.randomUUID()` minted at original join time — see
        // `session.ts`'s `joinParticipant` doc comment) is itself the resume
        // credential; the room code adds no real protection against identity
        // hijacking on top of that (every participant already knows the room
        // code — it's not participant-specific secret information), but
        // *requiring* it on every resume forced the addon to keep it in
        // `localStorage` indefinitely just to auto-resume silently, which is
        // unnecessary standing exposure for a code meant to be
        // workshop-scoped, not permanent (reported as a real concern from
        // review, not a hypothetical). A participant whose id the server
        // doesn't currently recognize (unknown/stale — e.g. the server
        // restarted) still goes through the full room-code gate below,
        // exactly like a brand-new join.
        const isKnownResume = participantId !== undefined && participants.has(participantId)
        if (!isKnownResume && !isValidRoomCode(authConfig, roomCode)) {
          ack?.({ error: 'invalid_room_code' })
          return
        }
        const { participant, outcome } = joinParticipant(name, participantId, randomUUID, socket.id)
        // Plan 030 Step 1: log a resume distinctly from both a normal
        // first-time join and a *failed* resume — an operator watching the
        // server's own logs during a real session needs to be able to tell
        // "someone just joined" apart from "someone's resume silently fell
        // back to a fresh identity" (e.g. the server restarted mid-workshop
        // and lost its in-memory registry — PRD §4/§14's accepted case, not
        // an error).
        if (outcome === 'resumed') {
          // eslint-disable-next-line no-console -- deliberate operator-facing log, not app logging.
          console.log(`[muan-companion-server] participant resumed: ${participant.name} (${participant.id})`)
        }
        else if (outcome === 'resume-fallback') {
          console.warn(
            `[muan-companion-server] resume failed for unknown participantId "${participantId}" `
            + `(server restarted, or a stale id from a different session) — `
            + `falling back to a fresh join as ${participant.name} (${participant.id})`,
          )
        }
        else {
          // eslint-disable-next-line no-console -- deliberate operator-facing log, not app logging.
          console.log(`[muan-companion-server] participant joined: ${participant.name} (${participant.id})`)
        }
        socket.data.participantId = participant.id
        // This socket has a real identity now — it's no longer "someone's
        // here but we don't know their name yet" (see `participant:connecting`
        // above). Removing it here, in the same tick as the state mutation
        // above and the broadcast below, is what makes the dashboard's row
        // transition from an anonymous placeholder to the real name in one
        // atomic update rather than a flicker of "disappeared, then
        // reappeared as someone else".
        removePendingConnection(socket.id)
        ack?.({ participantId: participant.id, currentSlideIndex: session.currentSlideIndex, resumed: outcome === 'resumed' })
        broadcastStateUpdate(io)
      },
    )

    socket.on('disconnect', () => {
      const participantId = getJoinedParticipantId(socket)
      if (!participantId) {
        // Never joined — if this socket had announced itself as pending
        // (`participant:connecting` above), it needs to disappear from the
        // dashboard too, not just linger as a "still connecting" row
        // forever. A presenter/dashboard socket (never pending in the first
        // place) hits `removePendingConnection`'s own no-op path here,
        // matching this handler's pre-existing behavior for those.
        if (removePendingConnection(socket.id))
          broadcastStateUpdate(io)
        return
      }
      // A clean Socket.io `disconnect` is a definitive, immediate signal for
      // *this one socket* — mark the participant `closed` right away rather
      // than waiting for the periodic sweep below (plan 029 Step 3: "use
      // both signals ... since [the sweep] adds unnecessary latency for the
      // common clean-close case") — but only once every socket representing
      // this participant is gone (see `removeParticipantSocket`'s doc
      // comment): a second tab closing must not flip a participant offline
      // while a first tab, still open and connected, is the reason this
      // participant is genuinely still `viewing now`. Only broadcast when
      // that actually happened — removing one of several live sockets
      // changes nothing the dashboard renders.
      if (removeParticipantSocket(participantId, socket.id))
        broadcastStateUpdate(io)
    })
  }

  /** M2's per-step `copied`/`done` tracking. */
  function registerStepTrackingHandlers(socket: Socket) {
    function handleStepAction(state: StepState) {
      return ({ stepId }: { stepId: string }, ack?: (payload: { stepId: string, state: StepState }) => void) => {
        const participantId = getJoinedParticipantId(socket)
        // A client can only act on behalf of the participant it joined as
        // (set on `participant:join` above) — a socket that hasn't joined
        // yet has nothing to attach the status to, so this is a no-op
        // rather than a guess.
        if (!participantId)
          return
        setStepStatus(participantId, stepId, state)
        touchLastSeen(participantId)
        ack?.({ stepId, state })
        broadcastStateUpdate(io)
      }
    }

    socket.on('participant:copy', handleStepAction('copied'))
    socket.on('participant:done', handleStepAction('done'))
  }

  /**
   * M3's error/help-request reporting, extended by the "Ask for Help"
   * redesign's two-way problem/question + confirm/reopen + presenter↔
   * participant messaging. The largest, most repetitive cluster of handlers
   * in this file (five events sharing the `reporterOf`/`notifyReporter`/
   * `errorReportOwnedBy` helpers above) — the main beneficiary of splitting
   * `io.on('connection', ...)` into named groups at all.
   */
  function registerHelpRequestHandlers(socket: Socket) {
    // Text-only report (PRD §10, extended by the "Ask for Help" redesign to
    // carry `kind`). The screenshot path is REST-only (`POST
    // /api/screenshot`, `screenshotUpload.ts`) — this WS event is
    // deliberately the *only* path for a text-only report, per plan 028
    // Step 2's decision not to implement both a WS and a REST path for the
    // identical text-only case. `kind` defaults to `'problem'` for callers
    // predating the redesign (or any client that omits it) — only the
    // widget's new "Ask a question" tab ever sends `'question'` explicitly.
    // No presenter/room-code check beyond having joined: same "a socket can
    // only act as the participant it joined as" rule as
    // `participant:copy`/`done` above — the room code was already checked
    // once, at `participant:join`.
    socket.on('participant:error', ({ stepId, text, kind }: { stepId: string, text?: string, kind?: HelpRequestKind }) => {
      const participantId = getJoinedParticipantId(socket)
      // Same "no-op rather than a guess" rule as `participant:copy`/`done`
      // above — a socket that hasn't joined has no participant to attach
      // the report to.
      if (!participantId)
        return
      const participant = participants.get(participantId)
      // Defensive, not just theoretical: a presenter could in principle
      // `presenter:kickParticipant` this exact participant in the brief
      // window between this event being sent and being processed — the
      // record would already be gone by the time this handler runs, while
      // `socket.data.participantId` (set once, at join) still points at it.
      if (!participant)
        return
      addErrorReport({
        id: randomUUID(),
        participantId,
        participantName: participant.name,
        stepId,
        kind: kind ?? 'problem',
        text,
        ts: Date.now(),
      })
      // Plan 029: "any activity counts as liveness", not just the dedicated
      // heartbeat — reporting an error is real, recent activity.
      touchLastSeen(participantId)
      broadcastStateUpdate(io)
    })

    socket.on('presenter:resolveError', requirePresenterCode(authConfig, ({ errorId, message }: { errorId: string, message?: string, presenterCode?: string }) => {
      // Plan 029 Step 1: same presenter-credential gate as `presenter:setSlide`
      // / `presenter:setStep` (`registerSlideHandlers` above) — resolving a
      // report is exactly as privileged as moving everyone's slide. (This
      // handler was added by plan 028, developed concurrently with 029's
      // auth work in a separate worktree; gating it is this merge's
      // responsibility per plan 029's own documented merge-order caveat.)
      //
      // Redesign: this no longer resolves outright — `resolveErrorReport`
      // moves the report to `'awaiting_confirmation'`, the participant gets
      // the final word via `participant:confirmResolution` below. Close the
      // loop back to the *specific* participant who filed this report — not
      // a broadcast, and not the dashboard room (they already got it via
      // the `state:update` below).
      const report = resolveErrorReport(errorId, message)
      // Only broadcast once something actually changed — an unknown
      // `errorId` (with an otherwise-valid presenter code) is a no-op, same
      // "nothing to tell the dashboard" posture as every other handler here
      // that checks its lookup's result before broadcasting.
      if (!report)
        return
      broadcastStateUpdate(io)
      notifyReporter(reporterOf(report), 'participant:errorResolved', {
        errorId: report.id,
        stepId: report.stepId,
        status: report.status,
        // Trimmed the same way `resolveErrorReport` trims before storing —
        // echo back what was actually kept (undefined for blank/whitespace),
        // not the raw, possibly-untrimmed input.
        message: message?.trim() || undefined,
      })
    }))

    // The "message box" redesign: lets the presenter reply on a report's
    // thread — "still looking into it", answering a question — without
    // forcing a binary "ignore or mark resolved" choice. Doesn't touch
    // `status` at all (unlike `presenter:resolveError` above); the dashboard
    // sees the new thread entry via the `state:update` broadcast below, and
    // the reporting participant is pushed the same message live so they
    // don't have to reopen the widget to notice it.
    socket.on('presenter:sendMessage', requirePresenterCode(authConfig, ({ errorId, text }: { errorId: string, text: string, presenterCode?: string }) => {
      const report = addPresenterMessage(errorId, text)
      if (!report)
        return
      broadcastStateUpdate(io)
      notifyReporter(reporterOf(report), 'participant:message', {
        errorId: report.id,
        stepId: report.stepId,
        text: report.thread.at(-1)!.text,
      })
    }))

    // The other half of the confirm/reopen redesign: the participant's
    // answer to "did that actually fix it?" after `presenter:resolveError`
    // above put a report in `'awaiting_confirmation'`. Restricted to the
    // *reporting* participant's own socket — same "a socket can only act as
    // the participant it joined as" rule as `participant:copy`/`done` —
    // rather than trusting whatever `errorId` shows up: an `errorId` isn't a
    // secret the way `participantId` is (it's visible to the dashboard, and
    // in principle guessable-ish as a UUID others hold), so this check is
    // what actually stops one participant from confirming/reopening
    // another's report, not just a UI nicety.
    socket.on('participant:confirmResolution', ({ errorId, confirmed, message }: { errorId: string, confirmed: boolean, message?: string }) => {
      const participantId = getJoinedParticipantId(socket)
      if (!participantId)
        return
      const report = errorReportOwnedBy(errorId, participantId)
      if (!report)
        return
      confirmResolution(errorId, confirmed, message)
      touchLastSeen(participantId)
      broadcastStateUpdate(io)
    })

    // Lets a participant add a follow-up on their own report's thread —
    // more detail on an open ticket, or a further question — without
    // waiting for a resolution offer to respond to (that's
    // `participant:confirmResolution` above; this never touches `status`).
    // Same ownership restriction as `participant:confirmResolution`, for the
    // same reason.
    socket.on('participant:addMessage', ({ errorId, text }: { errorId: string, text: string }) => {
      const participantId = getJoinedParticipantId(socket)
      if (!participantId)
        return
      const report = errorReportOwnedBy(errorId, participantId)
      if (!report)
        return
      addParticipantMessage(errorId, text)
      touchLastSeen(participantId)
      broadcastStateUpdate(io)
    })
  }

  /** M4's presence signals: visibility changes and the liveness heartbeat. */
  function registerPresenceHandlers(socket: Socket) {
    // PRD §10 `participant:visibility { state }` — reported by the addon's
    // `PresenceReporter.vue` on the Page Visibility API's `visibilitychange`
    // (plan 029 Step 2). `'closed'` is never sent by a client (see
    // `session.ts`'s `ParticipantVisibility` doc comment) — only
    // `'visible'`/`'hidden'` are accepted from here; anything else is
    // ignored rather than trusted verbatim, so a client can't self-report
    // `'closed'` and short-circuit the server's own disconnect/sweep signals.
    socket.on('participant:visibility', ({ state }: { state: ParticipantVisibility }) => {
      const participantId = getJoinedParticipantId(socket)
      if (!participantId || (state !== 'visible' && state !== 'hidden'))
        return
      const participant = participants.get(participantId)
      // Defensive, not just theoretical — same kick-race reasoning as
      // `participant:error`'s identical check (`registerHelpRequestHandlers`
      // above): the record can vanish between this socket's last join and
      // this event actually being processed.
      if (!participant)
        return
      participant.visibility = state
      participant.lastSeen = Date.now()
      broadcastStateUpdate(io)
    })

    // PRD §10 `participant:heartbeat { stepId }` — sent every
    // `HEARTBEAT_INTERVAL_MS` (plan 029 Step 2) purely as a liveness signal;
    // `stepId` isn't currently surfaced on the dashboard (the "current step"
    // column already reflects the *presenter's* step, PRD §11) but is
    // accepted per PRD §10's literal payload shape for forward
    // compatibility (e.g. a future "participant's own step" column) without
    // another event-contract change. Doesn't broadcast `state:update` on its
    // own — a bare liveness tick doesn't change anything the dashboard
    // renders (presence state, roster, step status), so broadcasting here
    // would just be periodic noise on every connected participant's tab.
    // `touchLastSeen` itself no-ops on an unjoined socket, so there's no
    // extra guard needed here the way the other handlers above need one.
    socket.on('participant:heartbeat', () => {
      touchLastSeen(getJoinedParticipantId(socket))
    })
  }

  /**
   * Post-ship participant management: the presenter's "Remove" button for
   * either roster row the dashboard shows — a joined participant, or a
   * still-anonymous pending connection (`participant:connecting` above).
   * Two separate events rather than one overloaded one, since the two cases
   * look up and disconnect by different keys (`participantId` vs. a raw
   * `socket.id`) with no shared logic worth factoring out beyond the
   * `requirePresenterCode` gate both already share with every other
   * `presenter:*` handler.
   */
  function registerKickHandlers(socket: Socket) {
    // `io.sockets.sockets.get(id)?.disconnect(true)` is the same "force a
    // real disconnect" mechanism `JoinScreen.vue`'s "Join as someone else"
    // fix relies on client-side (see that component's own comment) — it
    // triggers this same server's `disconnect` handler
    // (`registerParticipantLifecycleHandlers` above) for real, reusing its
    // already-correct cleanup rather than duplicating it here. The `true`
    // argument closes the underlying transport immediately (not just the
    // Socket.io-level session), matching what a presenter clicking "kick"
    // actually wants: this browser stops working *now*, not "on its next
    // reconnect attempt".
    socket.on('presenter:kickParticipant', requirePresenterCode(authConfig, ({ participantId }: { participantId: string, presenterCode?: string }) => {
      // `removeParticipant` (session.ts) is the hard delete — see its own
      // doc comment for why a mere disconnect isn't enough to actually kick
      // someone (they could just silently auto-resume). Disconnect every
      // socket of theirs *after* deleting the record, not before: once the
      // record is gone, a same-tick `disconnect` firing synchronously for
      // any of these sockets would otherwise hit `removeParticipantSocket`
      // looking up an id `removeParticipant` already deleted — harmless
      // (it no-ops on an unknown id) but backwards from the intended order.
      const removed = removeParticipant(participantId)
      if (!removed)
        return
      for (const socketId of removed.socketIds)
        io.sockets.sockets.get(socketId)?.disconnect(true)
      broadcastStateUpdate(io)
    }))

    // The pending-connection equivalent — there's no `Participant` record to
    // delete (they never joined), just a socket to disconnect and a pending
    // entry to clear. `removePendingConnection` also runs from that
    // socket's own `disconnect` handler once it actually disconnects, so
    // this could arguably skip calling it here — but doing it eagerly means
    // the dashboard's row disappears immediately on the presenter's own
    // broadcast rather than waiting on a second round-trip for the
    // disconnect event to come back through.
    socket.on('presenter:kickPendingConnection', requirePresenterCode(authConfig, ({ socketId }: { socketId: string, presenterCode?: string }) => {
      if (!removePendingConnection(socketId))
        return
      io.sockets.sockets.get(socketId)?.disconnect(true)
      broadcastStateUpdate(io)
    }))
  }

  /**
   * The dashboard's own Socket.io entry point (plan 027 Step 3). Kept
   * separate from `registerKickHandlers`/`registerHelpRequestHandlers`
   * above even though it's also presenter-gated: unlike every other
   * `presenter:*` handler, its rejection acks `{ ok: false }` instead of
   * silently doing nothing, so it deliberately does *not* go through
   * `requirePresenterCode`.
   */
  function registerDashboardHandler(socket: Socket) {
    // Opts into the room-scoped broadcast explicitly, rather than every
    // connected socket being auto-joined — participant sockets never emit
    // this. Sends one immediate snapshot to the joining socket only,
    // mirroring `slide:sync`'s late-joiner pattern, so a freshly-opened
    // dashboard tab doesn't have to wait for the next mutation to render
    // anything.
    socket.on('dashboard:join', async ({ presenterCode }: { presenterCode?: string } = {}, ack?: (result: DashboardJoinAck) => void) => {
      // Plan 029 Step 1: same presenter credential as `presenter:*` above —
      // opening the dashboard is exactly as privileged as moving everyone's
      // slide, so it shares the same gate rather than a weaker one.
      if (!isValidPresenterCode(authConfig, presenterCode)) {
        ack?.({ ok: false })
        return
      }
      socket.join(DASHBOARD_ROOM)
      socket.emit('state:update', buildStateUpdate())
      // Hand both codes back so the dashboard page can display them for the
      // operator to copy — safe to do here specifically because reaching
      // this line already proved the caller holds the presenter code (the
      // higher-privilege of the two secrets), so echoing the room code back
      // doesn't reveal anything to someone who couldn't already open this
      // same dashboard. Answers "how does the presenter find the codes to
      // hand out" without a separate discovery mechanism — see also
      // `index.ts`'s startup log, the other place they're surfaced. The join
      // URL/QR code are exactly as safe to hand back for the same reason —
      // they're derived entirely from `roomCode`, already justified above —
      // and `getJoinQrDataUrl` resolves synchronously-fast after the first
      // call (see its own comment), so awaiting it here doesn't meaningfully
      // delay this ack.
      ack?.({
        ok: true,
        roomCode: authConfig.roomCode,
        presenterCode: authConfig.presenterCode,
        deckUrl,
        joinUrl,
        joinQrDataUrl: await getJoinQrDataUrl(),
      })
    })
  }

  io.on('connection', (socket) => {
    // Sync the newly-connected client to current state immediately — needed
    // for M1's own acceptance bar (a participant who loads *after* the
    // presenter has already moved past slide 1 must still land on the right
    // slide). This event isn't in PRD §10's list; it's the minimum addition
    // needed to make `slide:changed` (a rebroadcast-only event) useful to
    // late joiners, and is a deliberate, documented addition — not scope
    // creep.
    socket.emit('slide:sync', { index: session.currentSlideIndex })

    registerSlideHandlers(socket)
    registerParticipantLifecycleHandlers(socket)
    registerStepTrackingHandlers(socket)
    registerHelpRequestHandlers(socket)
    registerPresenceHandlers(socket)
    registerKickHandlers(socket)
    registerDashboardHandler(socket)
  })

  // Backstop for a *hung* connection that never fires a clean `disconnect`
  // (flaky workshop wifi) — see `presence.ts`'s own doc comment. Liveness is
  // checked against Socket.io's own live socket registry
  // (`io.sockets.sockets`, keyed by socket id) rather than trusting
  // `participant.connected` alone, which is exactly the signal this sweep
  // exists to correct when it's gone stale. A participant counts as
  // connected here if *any* of its `socketIds` is still live — same
  // multi-tab reasoning as the `disconnect` handler above.
  const sweepIntervalId = setInterval(() => {
    const changed = sweepStaleParticipants(participants, participant => participant.socketIds.some(id => io.sockets.sockets.has(id)))
    if (changed)
      broadcastStateUpdate(io)
  }, options.sweepIntervalMs ?? HEARTBEAT_INTERVAL_MS)
  // Cleared when the http server closes (see `server.test.ts`'s `afterEach`)
  // so tests don't leak a running interval across runs.
  httpServer.on('close', () => clearInterval(sweepIntervalId))

  return { httpServer, io }
}
