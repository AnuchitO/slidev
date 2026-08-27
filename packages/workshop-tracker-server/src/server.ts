import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { WorkshopAuthConfig } from './auth'
import type { ParticipantVisibility, StepState } from './session'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import connect from 'connect'
import { join } from 'pathe'
import sirv from 'sirv'
import { Server as SocketIOServer } from 'socket.io'
import { isValidPresenterCode, isValidRoomCode } from './auth'
import { HEARTBEAT_INTERVAL_MS, sweepStaleParticipants } from './presence'
import { createScreenshotUploadHandler } from './screenshotUpload'
import {
  addErrorReport,
  joinParticipant,
  listErrorReports,
  listStepStatus,
  participants,
  removeParticipantSocket,
  resolveErrorReport,
  session,
  setStepStatus,
} from './session'
import { resolveUploadPath } from './uploads'

export interface CreateWorkshopTrackerServerOptions {
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
}

export interface WorkshopTrackerServer {
  httpServer: HttpServer
  io: SocketIOServer
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
export function createWorkshopTrackerServer(options: CreateWorkshopTrackerServerOptions = {}): WorkshopTrackerServer {
  const authConfig: WorkshopAuthConfig = {
    roomCode: options.roomCode ?? '',
    presenterCode: options.presenterCode ?? '',
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
  const uploadsDir = mkdtempSync(join(tmpdir(), 'workshop-tracker-uploads-'))

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

  io.on('connection', (socket) => {
    // Sync the newly-connected client to current state immediately — needed
    // for M1's own acceptance bar (a participant who loads *after* the
    // presenter has already moved past slide 1 must still land on the right
    // slide). This event isn't in PRD §10's list; it's the minimum addition
    // needed to make `slide:changed` (a rebroadcast-only event) useful to
    // late joiners, and is a deliberate, documented addition — not scope
    // creep.
    socket.emit('slide:sync', { index: session.currentSlideIndex })

    socket.on('presenter:setSlide', ({ index, presenterCode }: { index: number, presenterCode?: string }) => {
      // Plan 029 Step 1: gated on the presenter credential, distinct from
      // the participant room code. Invalid/missing code is a silent no-op
      // (matches this event's pre-029 shape — no ack — and the plan's own
      // verify step: "rejected/ignored, verified via ... the fact that no
      // other client's slide moves"), not a thrown error or disconnect —
      // a stray/misconfigured client shouldn't be able to crash the server.
      if (!isValidPresenterCode(authConfig, presenterCode))
        return
      session.currentSlideIndex = index
      io.emit('slide:changed', { index })
      broadcastStateUpdate(io)
    })

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
    socket.on('presenter:setStep', ({ stepId, presenterCode }: { stepId: string, presenterCode?: string }) => {
      // Plan 029 Step 1: same gate as `presenter:setSlide` above.
      if (!isValidPresenterCode(authConfig, presenterCode))
        return
      session.currentStepId = stepId
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
        if (!isValidRoomCode(authConfig, roomCode)) {
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
          console.log(`[workshop-tracker-server] participant resumed: ${participant.name} (${participant.id})`)
        }
        else if (outcome === 'resume-fallback') {
          console.warn(
            `[workshop-tracker-server] resume failed for unknown participantId "${participantId}" `
            + `(server restarted, or a stale id from a different session) — `
            + `falling back to a fresh join as ${participant.name} (${participant.id})`,
          )
        }
        else {
          // eslint-disable-next-line no-console -- deliberate operator-facing log, not app logging.
          console.log(`[workshop-tracker-server] participant joined: ${participant.name} (${participant.id})`)
        }
        socket.data.participantId = participant.id
        ack?.({ participantId: participant.id, currentSlideIndex: session.currentSlideIndex, resumed: outcome === 'resumed' })
        broadcastStateUpdate(io)
      },
    )

    function handleStepAction(state: StepState) {
      return ({ stepId }: { stepId: string }, ack?: (payload: { stepId: string, state: StepState }) => void) => {
        const participantId = socket.data.participantId as string | undefined
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

    // Text-only error report (PRD §10). The screenshot path is REST-only
    // (`POST /api/screenshot`, `screenshotUpload.ts`) — this WS event is
    // deliberately the *only* path for a text-only report, per plan 028
    // Step 2's decision not to implement both a WS and a REST path for the
    // identical text-only case. No presenter/room-code check beyond having
    // joined: same "a socket can only act as the participant it joined as"
    // rule as `participant:copy`/`done` below — the room code was already
    // checked once, at `participant:join`.
    socket.on('participant:error', ({ stepId, text }: { stepId: string, text?: string }) => {
      const participantId = socket.data.participantId as string | undefined
      // Same "no-op rather than a guess" rule as `participant:copy`/`done`
      // above — a socket that hasn't joined has no participant to attach
      // the report to.
      if (!participantId)
        return
      const participant = participants.get(participantId)
      if (!participant)
        return
      addErrorReport({
        id: randomUUID(),
        participantId,
        participantName: participant.name,
        stepId,
        text,
        ts: Date.now(),
      })
      // Plan 029: "any activity counts as liveness", not just the dedicated
      // heartbeat — reporting an error is real, recent activity.
      touchLastSeen(participantId)
      broadcastStateUpdate(io)
    })

    socket.on('presenter:resolveError', ({ errorId, presenterCode, message }: { errorId: string, presenterCode?: string, message?: string }) => {
      // Plan 029 Step 1: same presenter-credential gate as `presenter:setSlide`
      // / `presenter:setStep` above — resolving a report is exactly as
      // privileged as moving everyone's slide. (This handler was added by
      // plan 028, developed concurrently with 029's auth work in a separate
      // worktree; gating it is this merge's responsibility per plan 029's own
      // documented merge-order caveat.)
      if (!isValidPresenterCode(authConfig, presenterCode))
        return
      const report = resolveErrorReport(errorId, message)
      broadcastStateUpdate(io)
      if (!report)
        return
      // Close the loop back to the *specific* participant who filed this
      // report — not a broadcast, and not the dashboard room (they already
      // got it via the `state:update` above). Targets *every* socket
      // currently in `reporter.socketIds`, not just one: a participant can
      // have this identity open in more than one tab (the `localStorage`
      // resume), and `.to()` accepts an array of rooms — each socket is
      // implicitly in a room named by its own id — so every open tab of
      // theirs sees the notification, not just whichever tab happened to
      // join most recently. If they've disconnected entirely, `socketIds` is
      // empty and `io.to([])` is a harmless no-op — there's nothing to notify.
      const reporter = participants.get(report.participantId)
      if (reporter) {
        io.to(reporter.socketIds).emit('participant:errorResolved', {
          errorId: report.id,
          stepId: report.stepId,
          message: report.resolutionMessage,
        })
      }
    })

    // PRD §10 `participant:visibility { state }` — reported by the addon's
    // `PresenceReporter.vue` on the Page Visibility API's `visibilitychange`
    // (plan 029 Step 2). `'closed'` is never sent by a client (see
    // `session.ts`'s `ParticipantVisibility` doc comment) — only
    // `'visible'`/`'hidden'` are accepted from here; anything else is
    // ignored rather than trusted verbatim, so a client can't self-report
    // `'closed'` and short-circuit the server's own disconnect/sweep signals.
    socket.on('participant:visibility', ({ state }: { state: ParticipantVisibility }) => {
      const participantId = socket.data.participantId as string | undefined
      if (!participantId || (state !== 'visible' && state !== 'hidden'))
        return
      const participant = participants.get(participantId)
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
    socket.on('participant:heartbeat', () => {
      touchLastSeen(socket.data.participantId as string | undefined)
    })

    // The dashboard (plan 027 Step 3) opts into the room-scoped broadcast
    // explicitly, rather than every connected socket being auto-joined —
    // participant sockets never emit this. Sends one immediate snapshot to
    // the joining socket only, mirroring `slide:sync`'s late-joiner pattern
    // above, so a freshly-opened dashboard tab doesn't have to wait for the
    // next mutation to render anything.
    socket.on('dashboard:join', ({ presenterCode }: { presenterCode?: string } = {}, ack?: (result: { ok: boolean, roomCode?: string, presenterCode?: string }) => void) => {
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
      // `index.ts`'s startup log, the other place they're surfaced.
      ack?.({ ok: true, roomCode: authConfig.roomCode, presenterCode: authConfig.presenterCode })
    })

    socket.on('disconnect', () => {
      const participantId = socket.data.participantId as string | undefined
      if (!participantId)
        return
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
