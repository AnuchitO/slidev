import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Socket } from 'socket.io'
import type { WorkshopAuthConfig } from './auth'
import type { SpawnDeckProcess } from './deckLauncher'
import type { CreateSessionOptions, CreateSessionResult, HelpRequestKind, ParticipantVisibility, RoomState, StepState } from './session'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import connect from 'connect'
import { join } from 'pathe'
import QRCode from 'qrcode'
import sirv from 'sirv'
import { Server as SocketIOServer } from 'socket.io'
import { isValidAdminCode } from './adminAuth'
import { isValidPresenterCode, isValidRoomCode } from './auth'
import { generateCode } from './codeGeneration'
import { createDeckLaunchRoutes } from './deckLaunchRoutes'
import { HEARTBEAT_INTERVAL_MS, sweepStaleParticipants } from './presence'
import { listPresentations } from './presentations'
import { createRegistrationRoutes, normalizeDeckUrl } from './registrationRoutes'
import { createScreenshotUploadHandler } from './screenshotUpload'
import {
  addErrorReport,
  addParticipantMessage,
  addPendingConnection,
  addPresenterMessage,
  confirmResolution,
  createSession,
  destroySession,
  getRoom,
  getUploadsRootDir,
  joinParticipant,
  listErrorReports,
  listPendingConnections,
  listRooms,
  listStepStatus,
  removeParticipant,
  removeParticipantSocket,
  removePendingConnection,
  resolveErrorReport,
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
   *
   * Plan 032a: this is the **boot session's** room code specifically, not a
   * process-wide setting — it's forwarded to `createSession` (`session.ts`)
   * as the code for the one session this server stands up at construction
   * time. Further sessions created later (032b/032d, via the returned
   * server's own `createSession`) carry their own, independent codes.
   */
  roomCode?: string
  /**
   * Required for every `presenter:*` event and to open `/dashboard` (PRD
   * §12 / plan 029 Step 1) — deliberately a *separate* secret from
   * `roomCode`, never derivable from it, so a participant who knows the room
   * code still can't move slides or open the dashboard. Same fail-closed
   * behavior as `roomCode` when unset, and (as of 032a) likewise per-session
   * rather than per-process: room A's presenter code is worthless against
   * room B.
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
  /**
   * The **cross-room operator credential** (plan 032b, consumed by 032d's
   * registration routes too) — see `adminAuth.ts` for why it exists as a
   * third secret rather than a reuse of either per-room code. Gates `/home`,
   * `home:join`, `GET /api/presentations`, and `POST /api/connect-key` today,
   * and (per plan 032) the deck launcher later.
   *
   * `undefined` means **generate one**, exactly as `roomCode`/`presenterCode`
   * do at `createSession` (plan 031a's posture): a server started with no
   * configuration at all still ends up with a real, unguessable admin
   * credential that `index.ts` prints at startup, rather than an empty string
   * that `isValidAdminCode` would reject every request against — which would
   * leave `/home` permanently 401ing with no way for the operator to tell a
   * misconfiguration apart from a bug. An explicitly-set env var always wins,
   * and an explicit empty string is still honored verbatim (and still fails
   * closed) for a caller that genuinely wants the feature bolted shut.
   */
  adminCode?: string
  /**
   * Root directory scanned for presentable Slidev decks (plan 032b's Flow-A
   * discovery — `SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR`). Each immediate
   * subdirectory containing a `slides.md` with the companion addon
   * configured is one Presentation; see `presentations.ts` for exactly what
   * is checked and why.
   *
   * **Unset is not an error** — it means "this deployment hasn't opted into
   * discovery", and the presentation list is simply empty everywhere it
   * appears. Every deployment that predates 032b keeps behaving identically.
   *
   * This is configuration and *never* client input: no request can influence
   * which directory is scanned, and no response ever carries a path out of
   * it (see `Presentation`'s own doc comment).
   */
  presentationsDir?: string
  /**
   * The externally-reachable URL of **this** server (plan 032c —
   * `SLIDEV_MUAN_COMPANION_PUBLIC_URL`). Two jobs, both Flow-A only:
   *
   * 1. It is injected into every spawned deck's environment as
   *    `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL`, which is how the deck's addon
   *    finds its way back here with no change to `client.ts` at all. Vite
   *    inlines `VITE_*` variables **into the browser bundle**, so this value
   *    is resolved in the *participant's* browser, not in the child process —
   *    which is exactly why it has to be the externally-reachable URL and not
   *    something derived from the loopback interface.
   * 2. Its scheme and hostname are the origin the spawned deck's own URL is
   *    built from (the child's port replaces this server's) — see
   *    `deckLaunchRoutes.ts`'s `deckUrlFor`.
   *
   * Unset defaults to `http://localhost:<the port this server is listening
   * on>`, resolved lazily at launch time because the port is not known until
   * `listen` has happened (and is ephemeral in every test). That default is
   * correct only for an operator whose participants are on the same machine —
   * which is precisely the same caveat, and the same deliberate choice, as
   * `DEFAULT_DECK_URL` above: a zero-config server produces a well-formed link
   * that works locally rather than refusing to start or emitting something
   * obviously broken, and a real deployment sets the env var.
   *
   * **Set-but-invalid gets the same `localhost` fallback as unset, not a
   * crash** — found live: a value that isn't a well-formed absolute
   * `http:`/`https:` URL (e.g. the literal string `"true"`, from a
   * copy-paste mix-up with `SLIDEV_MUAN_COMPANION_SPAWN_REMOTE=true`) used to
   * flow straight through into every launched deck's bundle, and the only
   * symptom was every participant's browser failing to open a socket with an
   * opaque `ERR_NAME_NOT_RESOLVED` — nothing in this server's own logs
   * pointed at the cause. `createMuanCompanionServer` now validates this
   * once at construction (`normalizeDeckUrl`, the same check
   * `registrationRoutes.ts` already trusts for the identical class of
   * value) and logs a loud `console.error` if it's rejected.
   */
  publicUrl?: string
  /**
   * Flow-A deck-launcher configuration and test seams (plan 032c). Grouped
   * into one option rather than six top-level ones because they are only
   * meaningful together, and because five of the six are inert on a server
   * nobody ever clicks Present on.
   *
   * `spawn`, `allocatePort`, `readinessTimeoutMs` and `readinessPollIntervalMs`
   * are test-only overrides in the same spirit as `sweepIntervalMs` above:
   * they let `deckLaunch.test.ts` drive the real launcher, the real readiness
   * probe and the real registry without a `slidev` installation, following
   * this package's inject-a-function convention (`createSessionOptions.generate`,
   * `mintConnectKeyOptions.now`) rather than module mocking.
   */
  deckLaunch?: {
    /**
     * Bind spawned decks to every interface (`--remote=`) instead of
     * `localhost`. Off by default — see `buildSlidevArgs` for why this is an
     * operator's decision to make knowingly.
     */
    remote?: boolean
    /** Explicit path to the Slidev CLI — see `resolveSlidevBinary`. */
    slidevBinary?: string
    /** Concurrency cap; defaults to `MAX_CONCURRENT_SPAWNED_DECKS` (4). */
    maxConcurrent?: number
    readinessTimeoutMs?: number
    readinessPollIntervalMs?: number
    spawn?: SpawnDeckProcess
    allocatePort?: () => Promise<number>
  }
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
 * The port `index.ts` listens on when `PORT` is unset, and the port
 * `resolvePublicUrl` assumes when it is asked for this server's own URL before
 * `listen` has assigned one (only reachable in a test that launches a deck
 * against an unlistened server — a real launch always comes in over HTTP, so
 * the server is listening by definition).
 *
 * Exported for the same reason `DEFAULT_DECK_URL` is: `index.ts` needs the
 * same literal, and two copies of a port number are two things that can drift.
 */
export const DEFAULT_SERVER_PORT = 3710

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

/**
 * `buildJoinUrl`'s presenter-side twin (plan 032d): the URL the person running
 * the deck opens to drive it, with the presenter credential already attached.
 *
 * Lives next to `buildJoinUrl` for the same reason that one exists — this is
 * the single place the presenter URL's shape is decided, so the three things
 * that have to agree on it can't drift: this function, `index.ts`'s startup
 * log ("Append `?code=…` to your own `/presenter/N` deck URL"), and the addon's
 * `getPresenterCodeFromUrl` (`addon-muan-companion/src/presenterCode.ts`),
 * which reads back exactly the `code` param written here. `POST /api/register`
 * is its first caller: a deck that registers itself has no operator watching a
 * startup log, so the presenter URL has to be handed back in the response,
 * fully formed.
 *
 * Slide 1 specifically, matching every other "here's where to start" affordance
 * in this package: a freshly-registered session's `currentSlideIndex` is 1
 * (see `createSession`), so any other number would open the presenter on a
 * slide the session doesn't think it's on.
 *
 * Unlike `buildJoinUrl` this always returns a string, never `undefined`. The
 * asymmetry is real, not an oversight: an empty room code makes a join *link*
 * meaningless (it would silently send participants to the plain deck with
 * nothing prefilled — see `buildJoinUrl`'s own comment), whereas a presenter
 * URL with an empty code is still the correct URL to open; it simply won't
 * authorize anything, which is the intended fail-closed outcome for a session
 * with no presenter code rather than a link worth suppressing.
 *
 * **`roomCode` in the query string too, not just `code`.** Bug found live: for
 * any session that isn't this process's *boot* session (every Flow A launch —
 * `POST /api/launch` — and every Flow B registration — `POST /api/register`),
 * a presenter URL with no room hint at all silently drove the *wrong* room.
 * `client.ts`'s `getWorkshopSocket()` (the addon, running inside the deck this
 * URL points at) reads `?roomCode=` off the page's own URL and passes it as
 * the Socket.io handshake's room hint (`ROOM_CODE_QUERY_PARAM` — see that
 * constant's own comment); with nothing to read, every socket from that deck —
 * the presenter's own included — fell back to `defaultRoomCode` (the boot
 * session). `presenter:setSlide` then moved the *boot* session's slide while
 * the actual participants, correctly joined to the launched room, never saw
 * it move; opening `/dashboard` with this URL's `code` similarly got checked
 * against the boot session's presenter code and was silently rejected. Adding
 * `roomCode` here is the fix for the presenter's own window; `buildJoinUrl`
 * already carried it for participants, so this closes the one gap.
 */
export function buildPresenterUrl(deckUrl: string, roomCode: string, presenterCode: string): string {
  return `${deckUrl}/presenter/1?code=${encodeURIComponent(presenterCode)}&roomCode=${encodeURIComponent(roomCode)}`
}

export interface MuanCompanionServer {
  httpServer: HttpServer
  io: SocketIOServer
  /**
   * The session this server stood up at construction time, exactly as
   * `createSession` returned it. Its `roomCode` is also the room every
   * socket that arrives *without* a room hint is resolved into (see
   * `roomOf`/`ROOM_CODE_QUERY_PARAM` below) — which is what keeps every
   * pre-032a client working against a now-multi-room server.
   *
   * Exposed because a server constructed without explicit codes now gets
   * generated* ones rather than unusable empty strings, so the caller
   * (`index.ts`, whose startup log has to print both codes) can no longer
   * assume it already knows what they are.
   */
  bootSession: CreateSessionResult
  /**
   * The cross-room admin credential this server is actually enforcing —
   * whatever `options.adminCode` supplied, or the one generated for it when
   * that was `undefined` (plan 032b). Exposed for exactly the same reason
   * `bootSession` is: a server constructed without one gets a *generated*
   * credential, so `index.ts`'s startup log can no longer assume it knows
   * what the value is, and reading it back off the server is what keeps the
   * printed code from ever drifting from the enforced one.
   */
  adminCode: string
  /**
   * Plan 032a's seam for 032b (the presentation-launcher UI) and 032d:
   * stands up an additional, fully isolated session on this same running
   * server and tells every `dashboard:home` subscriber about it. Delegates
   * straight to `session.ts`'s `createSession` — this wrapper exists only to
   * pair session creation with the home broadcast, so no caller can create a
   * session the home view never hears about.
   *
   * Throws (from `createSession`) if the requested room code is already in
   * use — callers driving this from user input should catch that and surface
   * "that code is taken" rather than assuming success.
   */
  createSession: (options?: CreateSessionOptions) => CreateSessionResult
  /**
   * The symmetric half of `createSession` above — 032d's "end this session"
   * action. Returns whether a session actually existed. Every socket still
   * in the destroyed room's dashboard/participant rooms simply stops
   * receiving updates for it (their next event resolves no room and no-ops,
   * exactly like a socket naming a room that never existed).
   */
  destroySession: (roomCode: string) => boolean
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
 * The `WorkshopAuthConfig` (`auth.ts`) for one room. Plan 032a: the auth
 * config used to be a single object built once per process from
 * `createMuanCompanionServer`'s options; it's now derived per room, so every
 * gate below checks the credential it was handed against **the room the
 * calling socket actually resolved to** rather than against one global pair.
 * The check itself (`auth.ts`'s constant-time compare, and its refusal to
 * treat a missing configured code as a wildcard) is untouched — only where
 * the expected values come from changed.
 */
function authConfigOf(room: RoomState): WorkshopAuthConfig {
  return { roomCode: room.roomCode, presenterCode: room.presenterCode }
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
 *
 * Plan 032a: the wrapper now also resolves the room (via the `resolveRoom`
 * function it's handed) and passes it to the wrapped handler, so a
 * `presenter:*` handler can't accidentally act on a *different* room than
 * the one whose presenter code it just validated against — the two come
 * from the same lookup, in this one place, rather than each handler
 * repeating the pair. A socket whose room can't be resolved at all (it named
 * a room that doesn't exist, or one that has since been destroyed) is the
 * same silent no-op as a bad code, for the same reason: nothing to act on,
 * and nothing worth telling a stray client about.
 */
function requirePresenterCode<T extends WithPresenterCode>(
  resolveRoom: () => RoomState | undefined,
  handler: (room: RoomState, payload: T) => void,
) {
  return (payload: T) => {
    const room = resolveRoom()
    if (!room || !isValidPresenterCode(authConfigOf(room), payload.presenterCode))
      return
    handler(room, payload)
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
  /**
   * The presenter's own "drive this deck" URL — `buildPresenterUrl`, the
   * same one `POST /api/launch`/`POST /api/register` hand back. Lets the
   * dashboard's "Presenter code" row offer an actual link (open the
   * presenter view) instead of just the bare code to copy elsewhere. Safe to
   * echo back for the identical reason `roomCode`/`presenterCode` already
   * are here: reaching this line already proved the caller holds this exact
   * presenter code. Always present alongside `ok: true`, matching
   * `buildPresenterUrl`'s own "never undefined" contract — unlike `joinUrl`,
   * there's no "nothing valid to show yet" case for it.
   */
  presenterUrl?: string
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

/**
 * Sockets that have joined a room's dashboard get every `state:update`
 * broadcast for *that room* — participant sockets never join it, so the full
 * roster/step-status payload isn't sent to every participant on every other
 * participant's keystroke (plan 027 Step 1 / STOP condition 3).
 *
 * Plan 032a: one Socket.io room per workshop session (`dashboard:${roomCode}`)
 * rather than the single global `'dashboard'` this used to be — 031 Q2
 * identified this existing room mechanism as "exactly the right primitive to
 * extend", and this is that extension. Room A's dashboard is not in room B's
 * Socket.io room, so it never receives room B's roster, step status, help
 * requests, or pending connections; there is no filtering step that could be
 * forgotten, because the wrong room's payload is never sent in the first
 * place.
 */
function dashboardRoomFor(roomCode: string): string {
  return `dashboard:${roomCode}`
}

/**
 * The cross-session "home" feed room — new in plan 032a, with no equivalent
 * in 031. A future home view (032b) that lists every live session across
 * rooms subscribes here and gets a fresh `home:update` whenever a session is
 * created or destroyed, instead of polling or being rebuilt on every
 * `state:update`.
 *
 * Plan 032a left this room deliberately unjoinable, because
 * `buildHomeUpdate`'s payload necessarily carries every live room's code
 * (that's what a session list is), a room code is the participant-level
 * credential for its session, and no credential existed that was *at least
 * as strong as* a per-room presenter code without being scoped to one room.
 * A cross-room view is strictly more privileged than any single room's
 * dashboard, so it must not be reachable with less.
 *
 * **032b answers that with the admin code** (`adminAuth.ts`): the
 * `home:join` handler below is the only thing that ever calls
 * `socket.join(HOME_DASHBOARD_ROOM)`, and it does so only after
 * `isValidAdminCode` passes. Nothing about the per-room gates changed — the
 * admin code is new surface layered above them, never an alternative way in
 * to any single room's dashboard or `presenter:*` events.
 */
export const HOME_DASHBOARD_ROOM = 'dashboard:home'

/**
 * Length of an auto-generated admin code (plan 032b). Same 10 characters as
 * `PRESENTER_CODE_LENGTH` (`session.ts`), deliberately — this credential
 * is _at least_ as privileged as a presenter code (it enumerates every room
 * and, from 032c, launches processes on the host), so it must not have less
 * entropy than the weakest thing it outranks. Not imported from `session.ts`
 * despite matching its value today: that constant is documented as the length
 * of a *session's* presenter code, and tying an unrelated credential's
 * entropy to it would silently re-length this one if a future review changed
 * that for session-specific reasons.
 */
const ADMIN_CODE_LENGTH = 10

/** One row of the `home:update` feed — a live session, summarized. */
export interface HomeSessionSummary {
  roomCode: string
  deckUrl: string
  createdAt: number
  currentSlideIndex: number
  currentStepId: string
  participantCount: number
  /** Participants currently `connected` — the "how full is this room right now" number a home view actually wants. */
  connectedCount: number
  openHelpRequestCount: number
  /**
   * The `Presentation.title` this session was launched from (Flow A —
   * `RoomState.presentationTitle`, set by `POST /api/launch`), so the home
   * view's session table can show *which deck* is running instead of just
   * its room code. `undefined` for the boot session and every Flow-B
   * (`POST /api/register`) session — neither came from discovery, so there
   * is no `Presentation` to name; the home view falls back to `deckUrl` for
   * those, same as it already does for `presenterUrl`'s absence elsewhere.
   */
  presentationTitle?: string
  /**
   * The participant-facing join link — `buildJoinUrl(room.deckUrl,
   * room.roomCode)`. Both of its inputs (`deckUrl`, `roomCode`) are already
   * plain fields on this same summary, so including the precomputed URL adds
   * no new exposure — it just saves every subscriber re-deriving the same
   * template string `server.ts` already owns the one definition of.
   * `undefined` in lockstep with `buildJoinUrl`'s own "no room code, no
   * link" case, which cannot actually happen for a session `createSession`
   * produced (it always has a real room code) but is typed to match the
   * function's real signature rather than asserted away.
   */
  joinUrl?: string
}

/**
 * Builds the `home:update` payload. Exported so 032b's home view can render
 * an immediate snapshot to a newly-subscribed socket (mirroring how
 * `dashboard:join` emits `buildStateUpdate()` to the joining socket) rather
 * than making it wait for the next session to be created or destroyed.
 *
 * Deliberately a *summary*, not the rooms themselves: no participant names,
 * no help-request text, no presenter codes. A home view needs to know which
 * sessions exist and roughly how busy they are; handing it every room's full
 * state would make one subscription equivalent to N dashboards.
 */
export function buildHomeUpdate(): { sessions: HomeSessionSummary[] } {
  return {
    sessions: listRooms().map(room => ({
      roomCode: room.roomCode,
      deckUrl: room.deckUrl,
      createdAt: room.session.createdAt,
      currentSlideIndex: room.session.currentSlideIndex,
      currentStepId: room.session.currentStepId,
      participantCount: room.participants.size,
      connectedCount: [...room.participants.values()].filter(p => p.connected).length,
      openHelpRequestCount: room.errorReports.filter(r => r.status === 'open' || r.status === 'reopened').length,
      presentationTitle: room.presentationTitle,
      joinUrl: buildJoinUrl(room.deckUrl, room.roomCode),
    })),
  }
}

function broadcastHomeUpdate(io: SocketIOServer) {
  io.to(HOME_DASHBOARD_ROOM).emit('home:update', buildHomeUpdate())
}

/**
 * The `home:join` ack (plan 032b) — `{ ok: false }` on a bad/missing admin
 * code, otherwise `ok` plus the same `sessions` array a `home:update`
 * carries, so the joining page renders immediately instead of waiting for
 * the next session create/destroy. Exported and shaped as a spread of
 * `buildHomeUpdate()`'s return type rather than a hand-copied `sessions`
 * field, so the snapshot in the ack and the payload in the broadcast are the
 * same type by construction and cannot drift.
 */
export interface HomeJoinAck extends Partial<ReturnType<typeof buildHomeUpdate>> {
  ok: boolean
}

/**
 * The `home:dashboardUrl` ack (plan 032b) — see that handler's own comment
 * for why a per-room dashboard link is fetched on demand instead of being
 * folded into the `home:update` feed. `url` is present iff `ok`.
 */
export interface HomeDashboardUrlAck {
  ok: boolean
  url?: string
}

/**
 * The `home:joinQrDataUrl` ack — the participant-link twin of
 * `home:dashboardUrl` above. `url` is the same `joinUrl` a `home:update` row
 * already carries (returned again here so a caller that only wired up this
 * one event doesn't also have to read the broadcast); `qrDataUrl` is a
 * `data:image/png;base64,...` string encoding it, via the same
 * `getJoinQrDataUrl` the per-room dashboard already uses — one QR-encoding
 * implementation for the one join link, not a second copy for this page.
 * Both are `undefined` together whenever `ok` is `false`, or when the room
 * has no room code to build a link from (matches `HomeSessionSummary.joinUrl`
 * and `buildJoinUrl`'s own "nothing to encode" case).
 */
export interface HomeJoinQrDataUrlAck {
  ok: boolean
  url?: string
  qrDataUrl?: string
}

/**
 * The per-session dashboard URL for one room, in the exact shape
 * `requireDashboardCode`/`roomOfRequest` expect to read back: `?code=` is
 * the *presenter* code (that route's own credential — the admin code is not
 * accepted there and must not be), and `?roomCode=` selects which room's
 * presenter code is checked (032a's `ROOM_CODE_QUERY_PARAM`, defaulted to
 * the boot session when absent, which is why an older link with no room
 * parameter still works).
 *
 * Root-relative rather than absolute: the home page and the dashboard are
 * served by this same process on the same origin, so there is no host to
 * compute — and computing one would mean trusting a `Host` header, which is
 * client-controlled.
 */
function dashboardUrlFor(room: RoomState): string {
  return `/dashboard?code=${encodeURIComponent(room.presenterCode)}&roomCode=${encodeURIComponent(room.roomCode)}`
}

// The dashboard (plan 027 Step 3) is served as a small static page by this
// same process — same origin as the Socket.io server, so no CORS
// configuration is needed for it. See this package's README for why (option
// 1 of the two considered in the plan).
const DASHBOARD_PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'dashboard')

/**
 * The cross-room home view (plan 032b), served exactly the way
 * `/dashboard` is — same `sirv` mount, same CSP, same `?code=` gate, just a
 * different credential (the admin code) and a different directory. Written
 * with the same no-build-step posture as the dashboard page: one HTML file
 * with inline `<style>`/`<script>` and no framework, so there is nothing to
 * compile before this package can serve it.
 */
const HOME_PUBLIC_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'public', 'home')

/**
 * The query-string / handshake-query parameter a client uses to say which
 * session it means, at points in its life where nothing else can say it.
 *
 * Plan 032a decision (031 Q2's Addendum explicitly left this open — "a query
 * param at connection time? a field on `participant:connecting` itself? —
 * worth deciding explicitly rather than rediscovering it mid-implementation"):
 * **a Socket.io handshake query parameter**, read once in `io.on('connection')`
 * and cached on `socket.data.roomCode`, mirroring exactly how
 * `socket.data.participantId` is set once at join time and read by every
 * later handler.
 *
 * Chosen over a field on `participant:connecting` because a payload field
 * only answers the question for that one event, whereas the room is needed
 * before* any event at all: `slide:sync` is emitted synchronously the
 * instant a socket connects, and it must carry the right room's slide index.
 * One mechanism that covers the connection handshake, `participant:connecting`,
 * and every subsequent handler beats two that each cover part of it.
 *
 * This hint is **not a credential and grants nothing**. It only selects
 * which room's auth config a later check runs against: `participant:join`
 * still validates the supplied room code against that room
 * (`isValidRoomCode`, constant-time, unchanged), every `presenter:*` event
 * and `dashboard:join` still require that room's presenter code, and naming
 * a room that doesn't exist resolves to nothing and no-ops. The only thing an
 * unauthenticated socket gets by naming a room is that room's `slide:sync`
 * — which is already emitted to every connecting socket with no
 * authentication whatsoever today, so scoping it to a named room is strictly
 * narrower than the status quo, not a new exposure.
 *
 * Same parameter name as the participant-facing join link's own query param
 * (`buildJoinUrl` above, and the addon's `roomCode.ts`), so 032b's client
 * work is "pass the room code you already read out of the URL into
 * `io(url, { query })`", not a second name to learn.
 */
const ROOM_CODE_QUERY_PARAM = 'roomCode'

/**
 * A `Content-Security-Policy` for this package's two static pages —
 * `/dashboard` and (plan 032b) `/home` — specifically, not applied
 * globally (`/uploads` serves participant-supplied image bytes and
 * `/api/screenshot` returns plain JSON, neither of which executes script or
 * benefits from a policy scoped to *this* page's own known-safe resource
 * list). `public/dashboard/index.html` and `public/home/index.html` both
 * inline their own `<style>`/`<script>` (no build step — see this package's
 * README) and load exactly one same-origin script, Socket.io's own client
 * bundle (`/socket.io/socket.io.js`, served by Socket.io itself, not sirv) —
 * this policy is written to permit precisely that and nothing else external.
 * One policy for both pages rather than a second near-copy for `/home`:
 * their resource needs are identical (the home page's `fetch`es to
 * `/api/presentations` and, when 032d lands, `/api/connect-key` are
 * same-origin and already covered by `connect-src 'self'`), and two
 * separately-maintained policies is how one of them quietly gets weaker.
 *
 * - `'unsafe-inline'` on `script-src`/`style-src` is required for the page's
 *   existing inline `<script>`/`<style>` to keep running at all (there's no
 *   nonce/hash plumbing here, and adding one is a larger change than this
 *   pass's "hardening without breaking the page" scope) — this does **not**
 *   defeat the point of the policy: what it still blocks is any *external*
 *   script/style/connection a future XSS gap might try to pull in (a
 *   `<script src="https://evil">`, an `img`/`fetch` to an attacker's own
 *   host to exfiltrate data), which is exactly the realistic exploitation
 *   step for a reflected/stored XSS bug on this page (none is known to
 *   exist today — `escapeHtml()` covers every dynamic value rendered here —
 *   this is defense-in-depth for a future regression, not a response to a
 *   found bug).
 * - `img-src 'self' data:` — `data:` is required for the QR code image
 *   (`dashboard:join`'s `joinQrDataUrl`, set directly as an `<img>` `src`);
 *   `'self'` covers the screenshot thumbnails/lightbox, which point at this
 *   same server's `/uploads/:room/:filename`.
 * - `connect-src 'self'` — Socket.io's handshake (`ws:`/`wss:` and the
 *   polling fallback) is same-origin; nothing on this page ever calls out to
 *   another host.
 * - `frame-ancestors 'none'` — see the global `X-Frame-Options` comment
 *   above; this is the CSP-native, more expressive equivalent for browsers
 *   that honor it.
 * - `object-src 'none'`/`base-uri 'none'`/`form-action 'self'` — this page
 *   has no plugin content and no `<base>`/form use; locking these down is
 *   free hardening with no functional cost.
 */
function staticPageContentSecurityPolicy() {
  const directives = [
    'default-src \'self\'',
    'script-src \'self\' \'unsafe-inline\'',
    'style-src \'self\' \'unsafe-inline\'',
    'img-src \'self\' data:',
    'connect-src \'self\'',
    'font-src \'self\'',
    'frame-ancestors \'none\'',
    'base-uri \'none\'',
    'object-src \'none\'',
    'form-action \'self\'',
  ]
  return (_req: IncomingMessage, res: ServerResponse, next: () => void) => {
    res.setHeader('Content-Security-Policy', directives.join('; '))
    next()
  }
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
 *
 * Plan 032a: which room's presenter code is expected now comes from the same
 * `?roomCode=` hint every socket uses (`ROOM_CODE_QUERY_PARAM`), defaulting
 * to the boot session when absent so an existing dashboard URL keeps working
 * verbatim. Naming an unknown room is a 401 with the exact same body as a
 * wrong code — a caller learns nothing about which room codes exist from the
 * response, and there is no path where an unresolvable room means "let it
 * through".
 */
function requireDashboardCode(resolveRoomFromRequest: (req: IncomingMessage) => RoomState | undefined) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://internal')
    const supplied = url.searchParams.get('code') ?? undefined
    const room = resolveRoomFromRequest(req)
    if (room && isValidPresenterCode(authConfigOf(room), supplied)) {
      next()
      return
    }
    res.statusCode = 401
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Presenter code required (append ?code=<presenterCode> to this URL).')
  }
}

/**
 * `requireDashboardCode`'s sibling for the **cross-room** routes plan 032b
 * adds (`/home`, `GET /api/presentations`), gating on the admin code
 * (`adminAuth.ts`) instead of a room's presenter code.
 *
 * Deliberately a separate function rather than a generalization of
 * `requireDashboardCode` over "which credential". The two differ in more
 * than the comparison: this one has no room to resolve at all (that's the
 * point of a cross-room credential), and its rejection body names a
 * different parameter for the operator to go find. Folding them together
 * would mean a middleware that takes a resolver it sometimes ignores and a
 * message it sometimes swaps — more moving parts guarding a *more*
 * privileged surface, which is the wrong direction to trade. What is shared
 * is the part that matters: the same `?code=` convention, the same
 * check-before-any-data-access ordering (mounted ahead of `sirv` / ahead of
 * any filesystem scan), the same 401-with-nothing-extra-revealed body, and
 * the same fail-closed `isValidCode` primitive underneath.
 *
 * The body deliberately reveals nothing beyond how to authenticate: not
 * whether an admin code is configured, not whether discovery is enabled, not
 * how many presentations or sessions exist. A caller without the credential
 * learns only that one is required.
 */
function requireAdminCode(adminCode: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://internal')
    if (isValidAdminCode(adminCode, url.searchParams.get('code') ?? undefined)) {
      next()
      return
    }
    res.statusCode = 401
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    res.end('Admin code required (append ?code=<adminCode> to this URL).')
  }
}

/**
 * Builds the sync server's http+Socket.io instances without starting to
 * listen — kept separate from `index.ts`'s entrypoint so tests can drive it
 * against an ephemeral port, and so 027+ can extend the event handling here
 * without touching process bootstrapping.
 */
export function createMuanCompanionServer(options: CreateMuanCompanionServerOptions = {}): MuanCompanionServer {
  const deckUrl = options.deckUrl ?? DEFAULT_DECK_URL

  // Plan 032c: `SLIDEV_MUAN_COMPANION_PUBLIC_URL` gets baked, unmodified, into
  // every launched deck's own environment (`resolvePublicUrl` below, read by
  // `deckLauncher.ts`'s `childEnv` as `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL`)
  // with no validation anywhere on that path — unlike `deckLaunchRoutes.ts`'s
  // `deckUrlFor`, which already guards the *participant-facing link* built
  // from this same value. Found live: an env var accidentally set to the
  // literal string `"true"` (a copy-paste mix-up with the unrelated
  // `SLIDEV_MUAN_COMPANION_SPAWN_REMOTE=true`) produced a deck whose join
  // link and QR code looked completely normal — `deckUrlFor`'s `try`/`catch`
  // fell back to `localhost` for those — while every participant's browser
  // tried to open a socket to the literal hostname `true` (`io("true", ...)`
  // reads a schemeless string as a bare host) and failed with an opaque
  // `ERR_NAME_NOT_RESOLVED` in *their* console, with nothing at all in this
  // server's own logs pointing at the cause. Validated once, here, with the
  // same `normalizeDeckUrl` this package already trusts for the identical
  // class of value (`registrationRoutes.ts`'s caller-supplied `deckUrl`)
  // rather than a second hand-rolled check — an invalid value is dropped
  // back to `undefined`, the same "unconfigured" state `resolvePublicUrl`
  // already has a well-formed `localhost` fallback for, and logged loudly
  // exactly once, at construction, rather than resurfacing on every launch
  // or (worse) silently on none.
  if (options.publicUrl !== undefined && normalizeDeckUrl(options.publicUrl) === undefined) {
    console.error(
      `[muan-companion-server] SLIDEV_MUAN_COMPANION_PUBLIC_URL is set to `
      + `${JSON.stringify(options.publicUrl)}, which is not a valid absolute `
      + `http(s) URL — ignoring it and falling back to `
      + `http://localhost:<port>. Every deck launched via /api/launch bakes `
      + `this value into its own bundle as the sync server's address; a bad `
      + `value here means every participant's browser fails to connect with `
      + `no visible error beyond a raw network failure in their own console.`,
    )
  }
  const validatedPublicUrl = options.publicUrl !== undefined ? normalizeDeckUrl(options.publicUrl) : undefined

  // Plan 032b: the cross-room admin credential, resolved once for the life
  // of the process. `undefined` means "generate one", the same posture
  // `createSession` applies to a session's own two codes — see
  // `CreateMuanCompanionServerOptions.adminCode` for why an unset credential
  // must become a real generated secret rather than an empty string that
  // rejects everything. `??`, not `||`: an explicit empty string is honored
  // verbatim and fails closed, matching `createSession`'s treatment of an
  // explicit empty room code (the caller who passes `''` is asking for a
  // surface nobody can reach, and that is a legitimate thing to ask for).
  const adminCode = options.adminCode ?? generateCode(ADMIN_CODE_LENGTH)

  // Plan 032a: the boot session goes through the *same* `createSession` that
  // 032b/032d will call at runtime — there is deliberately no second,
  // special-cased path for "the first session". Everything that's true of a
  // session created later (its own codes, its own uploads directory, an
  // entry in `rooms`, a `home:update` for subscribers) is therefore true of
  // this one too, without this function having to remember to do any of it.
  //
  // Both codes are passed straight through, `undefined` included: to
  // `createSession`, `undefined` means "generate one" — 031a's posture,
  // which `index.ts` used to implement on its own for the single session it
  // booted, now applied to every session from one place. The visible
  // consequence is that a server constructed with no codes at all no longer
  // sits in the old "no code is configured, therefore nothing works"
  // state — it gets a real, unguessable pair instead. That is strictly
  // *more* usable and no less safe: `auth.ts`'s gates are untouched, and a
  // generated 8/10-character code is a real secret rather than an empty
  // string nobody can satisfy. An explicit empty string is still honored
  // verbatim (and still fails closed) for a caller that genuinely wants
  // that — see `createSession`'s own doc comment.
  //
  // No `broadcastHomeUpdate` for this one: `io` doesn't exist yet at this
  // point in construction, and by definition no socket can have subscribed
  // to a server that isn't built.
  const bootSession = createSession({
    roomCode: options.roomCode,
    presenterCode: options.presenterCode,
    deckUrl,
  })
  const defaultRoomCode = bootSession.roomCode

  /**
   * Resolves the room a socket belongs to. `socket.data.roomCode` is set
   * once, in `io.on('connection')` below, from the handshake's room hint
   * (see `ROOM_CODE_QUERY_PARAM`) — exactly mirroring how
   * `socket.data.participantId` is set once at `participant:join` and read
   * by every later handler rather than re-derived.
   *
   * Returns `undefined` for a socket naming a room that doesn't exist (or
   * one destroyed since it connected). Every caller below treats that as the
   * same no-op it already treats an unjoined socket / unknown id as — the
   * established "no-op rather than a guess" posture of this whole file —
   * rather than falling back to some other room, which would be exactly the
   * cross-room leak this plan exists to prevent.
   */
  function roomOf(socket: Socket): RoomState | undefined {
    return getRoom(socket.data.roomCode as string | undefined)
  }

  /**
   * Computes this room's join URL on demand rather than once at construction
   * time: before 032a both the deck URL and the room code were fixed for the
   * process's entire lifetime, so one precomputed value could serve every
   * caller. With N sessions, each created at a different moment with its own
   * deck URL, that's no longer true — but the value is still pure and cheap
   * (one template string), so there's nothing to cache. `undefined` whenever
   * `buildJoinUrl` finds no room code configured — see that function's own
   * doc comment for why that's the right behavior rather than emitting a
   * link that doesn't actually work.
   */
  function joinUrlOf(room: RoomState): string | undefined {
    return buildJoinUrl(room.deckUrl, room.roomCode)
  }

  /**
   * `QRCode.toDataURL` is async (it's doing real PNG encoding work), and
   * deliberately *not* awaited at session-creation time: sessions are created
   * synchronously by every test in `server.test.ts` (and by `index.ts`
   * before `httpServer.listen`), and forcing all of them to pay for a PNG
   * encode up front — for a value most of them never touch — would slow the
   * whole suite for no benefit. Instead this is computed lazily, the *first*
   * time anything actually asks for it (called from the `dashboard:join`
   * handler), and the resulting `Promise` (not just its resolved value) is
   * cached so a second dashboard tab opening moments later reuses the same
   * in-flight/completed encode instead of re-generating identical bytes.
   * Caching the `Promise` rather than waiting for it once and caching the
   * string is what makes that safe against two `dashboard:join` calls racing
   * before the first encode finishes.
   *
   * Plan 032a / 031 Q2's Addendum: the cache lives on the `RoomState`, one
   * promise per room, rather than in a single closure variable per process.
   * The encoded payload is derived from the room code, so a process-wide
   * cache would have handed the second room's dashboard the *first* room's
   * QR code — a wrong-workshop join link, silently, forever.
   */
  function getJoinQrDataUrl(room: RoomState): Promise<string | undefined> {
    const joinUrl = joinUrlOf(room)
    if (!joinUrl)
      return Promise.resolve(undefined)
    if (!room.joinQrDataUrlPromise) {
      // `.catch(() => undefined)` rather than letting a rejection propagate:
      // `dashboard:join`'s handler `await`s this directly, and socket.io
      // doesn't catch a listener's own async rejections for you — an
      // unhandled one here would surface as a process-level
      // `unhandledRejection`, not a contained failure. The QR code is a
      // convenience on top of the plain `joinUrl` text link (still shown
      // regardless), not load-bearing, so degrading to "no QR image" beats
      // crashing the dashboard connection over it.
      room.joinQrDataUrlPromise = QRCode.toDataURL(joinUrl).catch(() => undefined)
    }
    return room.joinQrDataUrlPromise
  }

  function buildStateUpdate(room: RoomState) {
    return {
      currentSlideIndex: room.session.currentSlideIndex,
      currentStepId: room.session.currentStepId,
      participants: [...room.participants.values()],
      // Sockets that connected and announced themselves (`participant:connecting`
      // below) but haven't completed `participant:join` yet — the "someone's
      // here but we don't know their name" visibility feature. A *separate*
      // field from `participants` above, not folded in as a fake participant
      // row: `Participant` requires a real `name`/`id`, and every other
      // consumer of `participants` (error reports, step status, the resume
      // flow) genuinely needs that to be true. The dashboard renders the two
      // together (see `public/dashboard/index.html`).
      pendingConnections: listPendingConnections(room),
      stepStatus: listStepStatus(room),
      // PRD §10's literal `state:update` shape (`{ currentSlideIndex,
      // participants[], errors[] }`) — folded straight into the existing
      // payload rather than a separate event (plan 028 Step 1's decision):
      // error reports are rare compared to step-status churn, so the combined
      // payload isn't a size/frequency problem at realistic volumes, and the
      // dashboard client needs no restructuring beyond rendering a new field.
      errors: listErrorReports(room),
    }
  }

  /**
   * Broadcasts one room's state to *that room's* dashboard subscribers only
   * (plan 032a). Every call site passes the room it just mutated, resolved
   * from the acting socket — so a mutation in room A can't reach room B's
   * dashboard even by accident, because room B's Socket.io room is never
   * named.
   */
  function broadcastStateUpdate(io: SocketIOServer, room: RoomState) {
    io.to(dashboardRoomFor(room.roomCode)).emit('state:update', buildStateUpdate(room))
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
    // Baseline hardening applied to every response this process serves
    // (`/dashboard`, `/uploads`, `/api/screenshot`), not just the dashboard
    // below — cheap, standard, and has no legitimate functionality relying
    // on their *absence* anywhere in this app:
    // - `nosniff` stops a browser from MIME-sniffing a response into
    //   executing as something other than its declared `content-type` — most
    //   relevant for `/uploads`, where the content type comes from what the
    //   uploader claimed (`uploads.ts`'s `ALLOWED_SCREENSHOT_MIME_TYPES`),
    //   not sniffed content, and for `/dashboard`'s static HTML/JS/CSS files
    //   sirv already serves with correct types.
    // - `X-Frame-Options: DENY` — nothing this server serves is meant to be
    //   embedded in a frame; a workshop dashboard shown in one isn't a
    //   feature, it's a clickjacking surface. Superseded by the more
    //   expressive `frame-ancestors 'none'` in `/dashboard`'s own CSP below
    //   for browsers that honor it, kept here too as the older/simpler
    //   fallback for the routes that don't set a CSP.
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('X-Frame-Options', 'DENY')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    next()
  })

  /**
   * The HTTP-side twin of `roomOf` above: reads the same `?roomCode=` hint
   * off a plain request's query string, falling back to the boot session so
   * a `/dashboard?code=...` URL an operator was handed before 032a keeps
   * working with no room parameter at all.
   */
  function roomOfRequest(req: IncomingMessage): RoomState | undefined {
    const url = new URL(req.url ?? '/', 'http://internal')
    return getRoom(url.searchParams.get(ROOM_CODE_QUERY_PARAM) ?? defaultRoomCode)
  }

  app.use('/dashboard', staticPageContentSecurityPolicy())
  app.use('/dashboard', requireDashboardCode(roomOfRequest))
  app.use('/dashboard', sirv(DASHBOARD_PUBLIC_DIR, { single: true, dev: true, etag: true }))

  // Plan 032b's cross-room home view. Mounted in exactly the same three-step
  // shape as `/dashboard` directly above — CSP, then credential, then
  // `sirv` — so the two pages are trivially comparable and neither can
  // acquire a gate the other quietly lacks. The only difference is which
  // credential the middle step checks.
  app.use('/home', staticPageContentSecurityPolicy())
  app.use('/home', requireAdminCode(adminCode))
  app.use('/home', sirv(HOME_PUBLIC_DIR, { single: true, dev: true, etag: true }))

  // `GET /api/presentations` — the discovered deck list, admin-gated.
  //
  // The gate is mounted as its own middleware *ahead* of the handler, not
  // checked inside it, for the same reason `requireDashboardCode` sits ahead
  // of `sirv`: no filesystem access of any kind (not even the `readdirSync`
  // of the configured root) happens on an unauthenticated request. An
  // attacker without the admin code cannot use this route to learn whether
  // the discovery directory exists, how long a scan of it takes, or anything
  // else about the host's disk.
  //
  // The response carries `listPresentations`' projection — id and title
  // only. The absolute path of every deck is dropped inside
  // `presentations.ts` (see `Presentation`'s doc comment), one layer below
  // this handler, so a future edit here cannot accidentally serialize it.
  app.use('/api/presentations', requireAdminCode(adminCode))
  app.use('/api/presentations', (req, res, next) => {
    // Anything other than a plain GET falls through to whatever else may
    // handle it (today: nothing, so connect's own 404). This route is
    // read-only by construction — 032c's launch action is a *different*,
    // state-changing endpoint and must not be reachable by POSTing here.
    if (req.method !== 'GET') {
      next()
      return
    }
    res.statusCode = 200
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ presentations: listPresentations(options.presentationsDir) }))
  })

  // Staging directory for in-flight screenshot uploads (plan 032a). The
  // per-*room* directories every accepted upload actually lands in are
  // created by `createSession` (`session.ts`) as siblings under
  // `getUploadsRootDir()`; this one is a sibling of those, holding bytes
  // only for as long as it takes to parse the rest of the multipart body and
  // work out which room the upload belongs to. See
  // `createScreenshotUploadHandler`'s own doc comment for why the room can't
  // be known before the first byte of the file arrives.
  const uploadsStagingDir = mkdtempSync(join(getUploadsRootDir(), 'staging-'))

  // `GET /uploads/:roomDir/:filename` — served by the same `sirv` used for
  // the dashboard, from the shared uploads root, with each room's own
  // `mkdtemp`-ed subdirectory underneath it (`RoomState.uploadsDir`). Both
  // path segments are checked *first*, ahead of sirv, so a path-traversal
  // attempt, an unknown room directory, or any filename that doesn't match
  // the server's own `${randomUUID()}.${ext}` naming scheme is rejected
  // before sirv ever touches the filesystem — defense-in-depth on top of
  // sirv's own path normalization, not a replacement for it.
  //
  // The room segment is matched against live rooms' `uploadsDirName` rather
  // than merely pattern-checked: a directory belonging to a session that has
  // been destroyed is no longer servable, and a segment that never named a
  // room is a 404 rather than a filesystem probe. Note the room *code* never
  // appears in this URL (see `RoomState.uploadsDirName`), so serving a
  // screenshot leaks no credential.
  app.use('/uploads', (req, res, next) => {
    const raw = (req.url ?? '').replace(/^\/+/, '').split('?')[0]
    let segments: string[]
    try {
      // Decoded *before* the shape check below, deliberately: malformed
      // percent-encoding is a 400 ("that isn't a well-formed request")
      // rather than a 404 ("no such file"), and that has to stay true
      // regardless of how many path segments the request happened to carry.
      segments = raw.split('/').map(decodeURIComponent)
    }
    catch {
      // Malformed percent-encoding — not a path this server ever wrote,
      // reject rather than guess.
      res.writeHead(400).end()
      return
    }
    // Exactly `<room uploads dir>/<filename>` — plan 032a's two-segment
    // shape. Anything else (the pre-032a flat `/uploads/:filename`, or a
    // deeper path) never named a file this server wrote.
    if (segments.length !== 2) {
      res.writeHead(404).end()
      return
    }
    const [roomDir, requested] = segments
    const room = listRooms().find(r => r.uploadsDirName === roomDir)
    if (!room || !resolveUploadPath(room.uploadsDir, requested)) {
      res.writeHead(404).end()
      return
    }
    next()
  })
  app.use('/uploads', sirv(getUploadsRootDir(), { dev: true, etag: true }))

  const httpServer = createServer(app)
  const io = new SocketIOServer(httpServer, {
    cors: { origin: options.origin ?? '*' },
  })

  app.use(createScreenshotUploadHandler(uploadsStagingDir, room => broadcastStateUpdate(io, room)))

  /**
   * Creates a session *and* tells every `dashboard:home` subscriber about it —
   * the pairing `MuanCompanionServer.createSession` documents as its whole
   * reason for existing ("so no caller can create a session the home view
   * never hears about").
   *
   * Hoisted out of the returned object literal (where 032a defined it inline)
   * because 032d added a second caller: `POST /api/register`'s handler, which
   * is wired into the middleware chain *above* the return statement. Passing
   * the same function to both is what keeps the invariant true for a session
   * created over HTTP by a registering deck, not just for one created by an
   * external caller holding the returned server object.
   */
  function createSessionAndBroadcast(sessionOptions: CreateSessionOptions = {}): CreateSessionResult {
    const created = createSession({ deckUrl, ...sessionOptions })
    broadcastHomeUpdate(io)
    return created
  }

  /**
   * `createSessionAndBroadcast`'s symmetric half, hoisted out of the returned
   * object literal for the same reason that one was (plan 032c): it now has a
   * second and third caller inside this function — `POST /api/stop` and the
   * crash handler that reaps a session whose spawned deck died — and all three
   * must end a session the *same* way, or a session torn down by a crash would
   * vanish from `rooms` while every open home view kept showing its row.
   */
  function destroySessionAndBroadcast(roomCode: string): boolean {
    const destroyed = destroySession(roomCode)
    if (destroyed)
      broadcastHomeUpdate(io)
    return destroyed
  }

  /**
   * This server's own externally-reachable URL, for the two Flow-A purposes
   * `CreateMuanCompanionServerOptions.publicUrl` documents.
   *
   * A function rather than a value computed at construction time, because the
   * fallback needs `httpServer.address()` — which is `null` until `listen` has
   * happened, and every test (and `index.ts` itself) constructs the server
   * before listening. Resolved per launch, which is also what keeps the
   * fallback honest on a server listening on an ephemeral port.
   *
   * The `Host` header is deliberately *not* consulted. It is client-controlled,
   * and this value is baked into a spawned deck's client bundle where every
   * participant will resolve it — letting a request decide where every
   * participant's browser connects would be a genuine attack, not a
   * convenience. Same reasoning `dashboardUrlFor` gives for staying
   * root-relative.
   *
   * Reads `validatedPublicUrl`, not `options.publicUrl` directly — see that
   * constant's own doc comment for why an invalid env var must not reach
   * this point at all.
   */
  function resolvePublicUrl(): string {
    if (validatedPublicUrl)
      return validatedPublicUrl
    const address = httpServer.address()
    const port = address !== null && typeof address !== 'string' ? (address as AddressInfo).port : DEFAULT_SERVER_PORT
    return `http://localhost:${port}`
  }

  // Plan 032d's connect-key routes (`POST /api/connect-key`, `POST
  // /api/register`). Mounted after the screenshot handler and, like it, as a
  // fall-through middleware rather than a path mount — see
  // `createRegistrationRoutes`' own doc comment.
  //
  // Reconciled with 032b at merge time: this used to read `options.adminCode
  // ?? ''` directly, on the reasoning that an unset admin code should leave
  // the cross-room surface closed rather than silently generating a
  // credential nothing ever prints. 032b landed first and settled that
  // question the other way — `adminCode` (below, generated a few lines up
  // when `options.adminCode` is absent) is already the one resolved value
  // every other admin-gated surface on this server uses (`requireAdminCode`,
  // `home:join`, `home:dashboardUrl`) precisely so a zero-config server is
  // fully usable, same as the room/presenter codes, and `index.ts` prints it
  // either way (see its own `adminCode` log line). Using the raw option here
  // instead of the resolved variable would have meant `/api/connect-key`
  // silently required a *different, always-empty* code than every other
  // admin surface on the same running server — passing the resolved
  // `adminCode` is what keeps there being exactly one admin credential per
  // process, not a second one this route alone disagreed about.
  app.use(createRegistrationRoutes({
    adminCode,
    createSession: createSessionAndBroadcast,
    buildJoinUrl,
    buildPresenterUrl,
  }))

  // Plan 032c's Flow-A routes (`POST /api/launch`, `POST /api/stop`). Mounted
  // as a fall-through middleware next to the registration routes above, and
  // for the same reason — see `createDeckLaunchRoutes`' own doc comment for
  // why these are flat paths with their subject in the body rather than
  // `/api/presentations/:id/launch`, and in particular why living under the
  // `/api/presentations` prefix (whose `requireAdminCode` mount only reads
  // `?code=`) would give one route two contradictory answers to "how do I
  // authenticate".
  //
  // Every dependency is injected rather than imported by the routes module,
  // matching `createRegistrationRoutes`: session creation and destruction both
  // go through this file's broadcast-pairing wrappers, so a launched session
  // and a crashed one are indistinguishable from any other as far as the home
  // view is concerned.
  app.use(createDeckLaunchRoutes({
    adminCode,
    presentationsDir: options.presentationsDir,
    publicUrl: resolvePublicUrl,
    createSession: createSessionAndBroadcast,
    destroySession: destroySessionAndBroadcast,
    buildJoinUrl,
    buildPresenterUrl,
    remote: options.deckLaunch?.remote,
    slidevBinary: options.deckLaunch?.slidevBinary,
    maxConcurrent: options.deckLaunch?.maxConcurrent,
    readinessTimeoutMs: options.deckLaunch?.readinessTimeoutMs,
    readinessPollIntervalMs: options.deckLaunch?.readinessPollIntervalMs,
    spawn: options.deckLaunch?.spawn,
    allocatePort: options.deckLaunch?.allocatePort,
  }))

  function touchLastSeen(room: RoomState, participantId: string | undefined) {
    if (!participantId)
      return
    const participant = room.participants.get(participantId)
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
  function reporterOf(room: RoomState, report: { participantId: string }) {
    return room.participants.get(report.participantId)
  }

  // The ownership check `participant:confirmResolution` and
  // `participant:addMessage` below both need: a report exists *and* it
  // belongs to the calling socket's own participant. Returns the report
  // itself (not just a boolean) so callers don't need a second lookup.
  // Scoped to one room (plan 032a), so a report id learned from another
  // room resolves to nothing here rather than to that other room's report.
  function errorReportOwnedBy(room: RoomState, errorId: string, participantId: string) {
    return listErrorReports(room).find(r => r.id === errorId && r.participantId === participantId)
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
   * navigability — every closure captured here (`io`) is exactly what these
   * handlers already relied on, nothing changes about when or how they fire.
   */
  function registerSlideHandlers(socket: Socket) {
    socket.on('presenter:setSlide', requirePresenterCode(() => roomOf(socket), (room, { index }: { index: number, presenterCode?: string }) => {
      // Plan 029 Step 1: gated on the presenter credential, distinct from
      // the participant room code (`requirePresenterCode` above) — a
      // stray/misconfigured client shouldn't be able to crash the server,
      // so an invalid/missing code is a silent no-op, not a thrown error or
      // disconnect (matches this event's pre-029 shape — no ack — and the
      // plan's own verify step: "rejected/ignored, verified via ... the
      // fact that no other client's slide moves").
      room.session.currentSlideIndex = index
      // Plan 032a: `io.emit` (every connected socket in the process) would
      // now move *every room's* participants, including rooms this
      // presenter holds no credential for — the single most obvious
      // cross-room leak in this whole refactor. Targeted at this room's own
      // participant Socket.io room instead; `participantRoomFor` is joined
      // by every socket at connection time (see `io.on('connection')`
      // below), so a participant hears their own presenter and nobody
      // else's.
      io.to(participantRoomFor(room.roomCode)).emit('slide:changed', { index })
      broadcastStateUpdate(io, room)
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
    socket.on('presenter:setStep', requirePresenterCode(() => roomOf(socket), (room, { stepId }: { stepId: string, presenterCode?: string }) => {
      room.session.currentStepId = stepId
      broadcastStateUpdate(io, room)
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
    //
    // Plan 032a: "which dashboard should see this anonymous socket" is
    // answered by the connection-time room hint (`ROOM_CODE_QUERY_PARAM`),
    // which is precisely the gap 031 Q2's Addendum flagged — this event
    // carries no identity of its own and never could, since the whole point
    // is "before any identity exists". A socket that named no room falls
    // back to the boot session, which is what keeps today's single-session
    // addon working unchanged.
    socket.on('participant:connecting', () => {
      const room = roomOf(socket)
      if (!room)
        return
      addPendingConnection(room, socket.id)
      broadcastStateUpdate(io, room)
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
        const room = roomOf(socket)
        // A socket naming a room that doesn't exist is rejected with the
        // same `invalid_room_code` the wrong-code path uses, deliberately:
        // "that room isn't here" and "that isn't the code" are the same
        // answer as far as an unauthenticated caller is concerned, so
        // probing this event can't be used to enumerate which room codes
        // name live sessions.
        if (!room) {
          ack?.({ error: 'invalid_room_code' })
          return
        }
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
        //
        // Plan 032a: `room.participants` scopes that exemption to this room
        // — an id minted in another room is "unknown" here, so it earns no
        // free pass and falls through to the room-code gate like any other
        // stranger. Resume tokens do not cross rooms.
        const isKnownResume = participantId !== undefined && room.participants.has(participantId)
        if (!isKnownResume && !isValidRoomCode(authConfigOf(room), roomCode)) {
          ack?.({ error: 'invalid_room_code' })
          return
        }
        const { participant, outcome } = joinParticipant(room, name, participantId, randomUUID, socket.id)
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
        removePendingConnection(room, socket.id)
        ack?.({ participantId: participant.id, currentSlideIndex: room.session.currentSlideIndex, resumed: outcome === 'resumed' })
        broadcastStateUpdate(io, room)
      },
    )

    socket.on('disconnect', () => {
      const room = roomOf(socket)
      if (!room)
        return
      const participantId = getJoinedParticipantId(socket)
      if (!participantId) {
        // Never joined — if this socket had announced itself as pending
        // (`participant:connecting` above), it needs to disappear from the
        // dashboard too, not just linger as a "still connecting" row
        // forever. A presenter/dashboard socket (never pending in the first
        // place) hits `removePendingConnection`'s own no-op path here,
        // matching this handler's pre-existing behavior for those.
        if (removePendingConnection(room, socket.id))
          broadcastStateUpdate(io, room)
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
      if (removeParticipantSocket(room, participantId, socket.id))
        broadcastStateUpdate(io, room)
    })
  }

  /** M2's per-step `copied`/`done` tracking. */
  function registerStepTrackingHandlers(socket: Socket) {
    function handleStepAction(state: StepState) {
      return ({ stepId }: { stepId: string }, ack?: (payload: { stepId: string, state: StepState }) => void) => {
        const room = roomOf(socket)
        const participantId = getJoinedParticipantId(socket)
        // A client can only act on behalf of the participant it joined as
        // (set on `participant:join` above) — a socket that hasn't joined
        // yet has nothing to attach the status to, so this is a no-op
        // rather than a guess.
        if (!room || !participantId)
          return
        setStepStatus(room, participantId, stepId, state)
        touchLastSeen(room, participantId)
        ack?.({ stepId, state })
        broadcastStateUpdate(io, room)
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
      const room = roomOf(socket)
      const participantId = getJoinedParticipantId(socket)
      // Same "no-op rather than a guess" rule as `participant:copy`/`done`
      // above — a socket that hasn't joined has no participant to attach
      // the report to.
      if (!room || !participantId)
        return
      const participant = room.participants.get(participantId)
      // Defensive, not just theoretical: a presenter could in principle
      // `presenter:kickParticipant` this exact participant in the brief
      // window between this event being sent and being processed — the
      // record would already be gone by the time this handler runs, while
      // `socket.data.participantId` (set once, at join) still points at it.
      if (!participant)
        return
      addErrorReport(room, {
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
      touchLastSeen(room, participantId)
      broadcastStateUpdate(io, room)
    })

    socket.on('presenter:resolveError', requirePresenterCode(() => roomOf(socket), (room, { errorId, message }: { errorId: string, message?: string, presenterCode?: string }) => {
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
      const report = resolveErrorReport(room, errorId, message)
      // Only broadcast once something actually changed — an unknown
      // `errorId` (with an otherwise-valid presenter code) is a no-op, same
      // "nothing to tell the dashboard" posture as every other handler here
      // that checks its lookup's result before broadcasting. Under 032a an
      // errorId belonging to *another* room is likewise unknown here.
      if (!report)
        return
      broadcastStateUpdate(io, room)
      notifyReporter(reporterOf(room, report), 'participant:errorResolved', {
        errorId: report.id,
        stepId: report.stepId,
        status: report.status,
        // Read back off the report's own thread, not recomputed from the raw
        // `message` input — `resolveErrorReport` trims *and* length-caps
        // before storing (`session.ts`'s `MAX_TEXT_LENGTH`), so a naive
        // `message?.trim()` here could echo back more text than was actually
        // kept. `.at(-1)` is safe: a non-blank `message` is exactly what
        // causes `resolveErrorReport` to push one more thread entry, so it's
        // guaranteed to be the one just pushed, same reasoning as
        // `presenter:sendMessage` below.
        message: message?.trim() ? report.thread.at(-1)?.text : undefined,
      })
    }))

    // The "message box" redesign: lets the presenter reply on a report's
    // thread — "still looking into it", answering a question — without
    // forcing a binary "ignore or mark resolved" choice. Doesn't touch
    // `status` at all (unlike `presenter:resolveError` above); the dashboard
    // sees the new thread entry via the `state:update` broadcast below, and
    // the reporting participant is pushed the same message live so they
    // don't have to reopen the widget to notice it.
    socket.on('presenter:sendMessage', requirePresenterCode(() => roomOf(socket), (room, { errorId, text }: { errorId: string, text: string, presenterCode?: string }) => {
      const report = addPresenterMessage(room, errorId, text)
      if (!report)
        return
      broadcastStateUpdate(io, room)
      notifyReporter(reporterOf(room, report), 'participant:message', {
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
      const room = roomOf(socket)
      const participantId = getJoinedParticipantId(socket)
      if (!room || !participantId)
        return
      const report = errorReportOwnedBy(room, errorId, participantId)
      if (!report)
        return
      confirmResolution(room, errorId, confirmed, message)
      touchLastSeen(room, participantId)
      broadcastStateUpdate(io, room)
    })

    // Lets a participant add a follow-up on their own report's thread —
    // more detail on an open ticket, or a further question — without
    // waiting for a resolution offer to respond to (that's
    // `participant:confirmResolution` above; this never touches `status`).
    // Same ownership restriction as `participant:confirmResolution`, for the
    // same reason.
    socket.on('participant:addMessage', ({ errorId, text }: { errorId: string, text: string }) => {
      const room = roomOf(socket)
      const participantId = getJoinedParticipantId(socket)
      if (!room || !participantId)
        return
      const report = errorReportOwnedBy(room, errorId, participantId)
      if (!report)
        return
      addParticipantMessage(room, errorId, text)
      touchLastSeen(room, participantId)
      broadcastStateUpdate(io, room)
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
      const room = roomOf(socket)
      const participantId = getJoinedParticipantId(socket)
      if (!room || !participantId || (state !== 'visible' && state !== 'hidden'))
        return
      const participant = room.participants.get(participantId)
      // Defensive, not just theoretical — same kick-race reasoning as
      // `participant:error`'s identical check (`registerHelpRequestHandlers`
      // above): the record can vanish between this socket's last join and
      // this event actually being processed.
      if (!participant)
        return
      participant.visibility = state
      participant.lastSeen = Date.now()
      broadcastStateUpdate(io, room)
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
      const room = roomOf(socket)
      if (!room)
        return
      touchLastSeen(room, getJoinedParticipantId(socket))
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
    socket.on('presenter:kickParticipant', requirePresenterCode(() => roomOf(socket), (room, { participantId }: { participantId: string, presenterCode?: string }) => {
      // `removeParticipant` (session.ts) is the hard delete — see its own
      // doc comment for why a mere disconnect isn't enough to actually kick
      // someone (they could just silently auto-resume). Disconnect every
      // socket of theirs *after* deleting the record, not before: once the
      // record is gone, a same-tick `disconnect` firing synchronously for
      // any of these sockets would otherwise hit `removeParticipantSocket`
      // looking up an id `removeParticipant` already deleted — harmless
      // (it no-ops on an unknown id) but backwards from the intended order.
      //
      // Scoped to this presenter's own room (plan 032a): a participant id
      // from another room isn't in `room.participants`, so this is the same
      // no-op as an id that never existed — one room's presenter can't kick
      // another room's participants even knowing their id.
      const removed = removeParticipant(room, participantId)
      if (!removed)
        return
      for (const socketId of removed.socketIds)
        io.sockets.sockets.get(socketId)?.disconnect(true)
      broadcastStateUpdate(io, room)
    }))

    // The pending-connection equivalent — there's no `Participant` record to
    // delete (they never joined), just a socket to disconnect and a pending
    // entry to clear. `removePendingConnection` also runs from that
    // socket's own `disconnect` handler once it actually disconnects, so
    // this could arguably skip calling it here — but doing it eagerly means
    // the dashboard's row disappears immediately on the presenter's own
    // broadcast rather than waiting on a second round-trip for the
    // disconnect event to come back through.
    //
    // Likewise room-scoped: the pending entry has to be in *this* room's
    // `pendingConnections` for the disconnect to happen at all, so a socket
    // id observed on another room's dashboard is inert here.
    socket.on('presenter:kickPendingConnection', requirePresenterCode(() => roomOf(socket), (room, { socketId }: { socketId: string, presenterCode?: string }) => {
      if (!removePendingConnection(room, socketId))
        return
      io.sockets.sockets.get(socketId)?.disconnect(true)
      broadcastStateUpdate(io, room)
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
      const room = roomOf(socket)
      // Plan 029 Step 1: same presenter credential as `presenter:*` above —
      // opening the dashboard is exactly as privileged as moving everyone's
      // slide, so it shares the same gate rather than a weaker one. Plan
      // 032a: checked against *this socket's room* specifically, so room A's
      // presenter code opens room A's dashboard and nothing else. An
      // unresolvable room acks the same `{ ok: false }` as a wrong code —
      // see `participant:join`'s equivalent note on why the two failures are
      // deliberately indistinguishable.
      if (!room || !isValidPresenterCode(authConfigOf(room), presenterCode)) {
        ack?.({ ok: false })
        return
      }
      socket.join(dashboardRoomFor(room.roomCode))
      socket.emit('state:update', buildStateUpdate(room))
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
        roomCode: room.roomCode,
        presenterCode: room.presenterCode,
        deckUrl: room.deckUrl,
        presenterUrl: buildPresenterUrl(room.deckUrl, room.roomCode, room.presenterCode),
        joinUrl: joinUrlOf(room),
        joinQrDataUrl: await getJoinQrDataUrl(room),
      })
    })
  }

  /**
   * The cross-room home view's Socket.io entry point (plan 032b) — the
   * thing that finally gives `broadcastHomeUpdate` real subscribers, and
   * the _only_ place `HOME_DASHBOARD_ROOM` is ever joined.
   *
   * Modelled on `registerDashboardHandler` above, deliberately down to the
   * details: an `{ ok: false }` ack with no join on failure (not a silent
   * no-op, not a disconnect — the page needs to render "wrong code" rather
   * than hang), and an immediate snapshot folded into the success ack so a
   * freshly-opened home tab renders the current session list without waiting
   * for the next create/destroy. Like `dashboard:join`, it does not go
   * through `requirePresenterCode`: the credential is different *and* the
   * rejection shape is different.
   *
   * What is deliberately **not** shared with `dashboard:join` is the
   * credential itself. A room's presenter code opens that room's dashboard
   * and nothing else; it is worthless here. The admin code opens this view
   * and confers nothing inside any single room — it is not accepted by
   * `dashboard:join`, by any `presenter:*` event, or by `participant:join`.
   * Neither credential is a superset of the other on the wire, even though
   * the admin code is the more privileged of the two in practice, because
   * every existing gate is left exactly as it was: 032b adds surface, it
   * does not widen anything.
   */
  function registerHomeHandler(socket: Socket) {
    // The payload is read with `?.` rather than destructured behind a `= {}`
    // default. A default parameter only fires for `undefined`, and a client
    // that emits `socket.emit('home:join', null, ack)` — which is exactly
    // what a Socket.io client sends for an explicitly-`undefined` payload,
    // since `null` is what survives the JSON round-trip — would otherwise
    // throw a `TypeError` *inside* the listener. Socket.io does not catch a
    // listener's synchronous throw, so that surfaces as a process-level
    // uncaught exception: any socket, with no credential at all, could stop
    // the server. Reading defensively is the whole fix, and it costs a
    // question mark.
    socket.on('home:join', (payload: { adminCode?: string } | null | undefined, ack?: (result: HomeJoinAck) => void) => {
      if (!isValidAdminCode(adminCode, payload?.adminCode)) {
        ack?.({ ok: false })
        return
      }
      socket.join(HOME_DASHBOARD_ROOM)
      ack?.({ ok: true, ...buildHomeUpdate() })
    })

    // On-demand, per-room dashboard link for the home view's "open this
    // session's dashboard" action.
    //
    // **Why this exists at all**: `buildHomeUpdate`'s payload deliberately
    // carries no presenter codes (032a's decision, and its test pins it
    // down), but a working `/dashboard?code=…&roomCode=…` link needs one.
    // Rather than weaken the broadcast, the code is fetched *only when the
    // operator actually clicks a session*, through this separate,
    // individually-authenticated event.
    //
    // **Why that's the right trade**: an admin-code holder is already
    // entitled to every room's presenter code — this credential outranks
    // them all, and 032c will let it start and stop the very sessions those
    // codes belong to — so withholding the codes from them is not a
    // security boundary. What *is* worth avoiding is putting N presenter
    // codes into a feed that re-broadcasts on every session create/destroy,
    // where they accumulate in every subscriber's memory, devtools network
    // log, and any proxy in between for the whole life of the page. One code,
    // on an explicit action, is a fraction of that standing exposure for the
    // same functionality. The home page correspondingly never renders the
    // code into the DOM — it navigates straight to the returned URL (see
    // `public/home/index.html`).
    //
    // The admin code is re-checked here rather than trusting the socket's
    // earlier `home:join`, matching how every `presenter:*` event re-checks
    // its own code on every payload instead of trusting `dashboard:join`.
    // Same `?.`-not-destructuring posture as `home:join` above, for the same
    // reason — see its comment.
    socket.on('home:dashboardUrl', (payload: { adminCode?: string, roomCode?: string } | null | undefined, ack?: (result: HomeDashboardUrlAck) => void) => {
      if (!isValidAdminCode(adminCode, payload?.adminCode)) {
        ack?.({ ok: false })
        return
      }
      const room = getRoom(payload?.roomCode)
      // An unknown/destroyed room acks the same `{ ok: false }` as a bad
      // credential — the established "the two failures are deliberately
      // indistinguishable" posture of every other gate in this file.
      if (!room) {
        ack?.({ ok: false })
        return
      }
      ack?.({ ok: true, url: dashboardUrlFor(room) })
    })

    // `home:dashboardUrl`'s participant-link twin: the QR code and plain
    // join link for one room, fetched on demand rather than folded into
    // `home:update`.
    //
    // The plain `joinUrl` *is* already in every `home:update` row (it carries
    // no credential — see `HomeSessionSummary.joinUrl`'s own comment), so
    // this event exists specifically for the QR **image**: `getJoinQrDataUrl`
    // does a real PNG encode, and doing that unconditionally for every live
    // session on every create/destroy broadcast would pay that cost for
    // sessions no one is looking at. One encode per room, on first request,
    // matches the dashboard's own lazy-and-cached posture for the identical
    // value (`room.joinQrDataUrlPromise`) — a second dashboard, or this page,
    // opening moments later reuses the same cached PNG rather than
    // re-encoding it.
    socket.on('home:joinQrDataUrl', async (payload: { adminCode?: string, roomCode?: string } | null | undefined, ack?: (result: HomeJoinQrDataUrlAck) => void) => {
      if (!isValidAdminCode(adminCode, payload?.adminCode)) {
        ack?.({ ok: false })
        return
      }
      const room = getRoom(payload?.roomCode)
      if (!room) {
        ack?.({ ok: false })
        return
      }
      const url = joinUrlOf(room)
      const qrDataUrl = await getJoinQrDataUrl(room)
      ack?.({ ok: true, url, qrDataUrl })
    })
  }

  /**
   * Every socket in one session's *participant* broadcast room. Plan 032a
   * introduced this alongside `dashboardRoomFor`: `slide:changed` used to go
   * out via a bare `io.emit` (every socket in the process), which was
   * correct only because a process had exactly one session. With N sessions
   * that would move every room's deck at once, so each socket joins its own
   * room's participant room at connection time and slide broadcasts are
   * addressed to it.
   *
   * Distinct from the dashboard room even though a dashboard socket is also
   * in it: the two carry different events (`slide:changed` vs
   * `state:update`) with different privilege (`slide:changed` is the
   * unauthenticated deck sync every participant needs; `state:update` is the
   * presenter-gated roster feed), so collapsing them would push roster data
   * to participants.
   */
  function participantRoomFor(roomCode: string): string {
    return `participants:${roomCode}`
  }

  io.on('connection', (socket) => {
    // Plan 032a: resolve "which session is this socket talking about" once,
    // here, from the handshake's room hint, and cache it on `socket.data`
    // exactly the way `participant:join` caches `participantId` — every
    // handler below reads it back via `roomOf(socket)` rather than
    // re-deriving it. Falling back to the boot session when no hint is
    // supplied is what keeps every pre-032a client (the addon's `client.ts`,
    // which passes no query, and the dashboard page) working unchanged
    // against a server that now merely *can* hold more than one session.
    //
    // The hint is not authenticated and is not treated as a credential —
    // see `ROOM_CODE_QUERY_PARAM`'s own doc comment.
    const hinted = socket.handshake.query[ROOM_CODE_QUERY_PARAM]
    socket.data.roomCode = typeof hinted === 'string' && hinted ? hinted : defaultRoomCode

    const room = roomOf(socket)
    if (room) {
      socket.join(participantRoomFor(room.roomCode))
      // Sync the newly-connected client to current state immediately —
      // needed for M1's own acceptance bar (a participant who loads *after*
      // the presenter has already moved past slide 1 must still land on the
      // right slide). This event isn't in PRD §10's list; it's the minimum
      // addition needed to make `slide:changed` (a rebroadcast-only event)
      // useful to late joiners, and is a deliberate, documented addition —
      // not scope creep.
      socket.emit('slide:sync', { index: room.session.currentSlideIndex })
    }

    registerSlideHandlers(socket)
    registerParticipantLifecycleHandlers(socket)
    registerStepTrackingHandlers(socket)
    registerHelpRequestHandlers(socket)
    registerPresenceHandlers(socket)
    registerKickHandlers(socket)
    registerDashboardHandler(socket)
    // Plan 032b. Registered for every socket, exactly like the per-room
    // handlers above — the handler's own admin-code gate is what decides who
    // gets anything out of it, not which sockets it happens to be attached
    // to. Notably it needs no resolved room: the whole point of the home
    // view is that it isn't scoped to one, so a socket that connected with
    // no (or an unknown) room hint can still use it.
    registerHomeHandler(socket)
  })

  // Backstop for a *hung* connection that never fires a clean `disconnect`
  // (flaky workshop wifi) — see `presence.ts`'s own doc comment. Liveness is
  // checked against Socket.io's own live socket registry
  // (`io.sockets.sockets`, keyed by socket id) rather than trusting
  // `participant.connected` alone, which is exactly the signal this sweep
  // exists to correct when it's gone stale. A participant counts as
  // connected here if *any* of its `socketIds` is still live — same
  // multi-tab reasoning as the `disconnect` handler above.
  //
  // Plan 032a: sweeps every live room, not one process-wide participant map,
  // and broadcasts per room so only the rooms that actually changed pay for
  // an update.
  const sweepIntervalId = setInterval(() => {
    for (const room of listRooms()) {
      const changed = sweepStaleParticipants(room.participants, participant => participant.socketIds.some(id => io.sockets.sockets.has(id)))
      if (changed)
        broadcastStateUpdate(io, room)
    }
  }, options.sweepIntervalMs ?? HEARTBEAT_INTERVAL_MS)
  // Cleared when the http server closes (see `server.test.ts`'s `afterEach`)
  // so tests don't leak a running interval across runs. The boot session is
  // torn down at the same time (plan 032a): a closed server isn't serving
  // its room any more, and leaving the entry in `rooms` would make a later
  // `createSession` under the same code fail as a "duplicate" against a
  // session nothing can reach. No `broadcastHomeUpdate` here, unlike the
  // returned `destroySession` below — a server that's closing has no
  // sockets left to tell, and emitting into a shutting-down `io` would be
  // noise at best.
  httpServer.on('close', () => {
    clearInterval(sweepIntervalId)
    destroySession(defaultRoomCode)
  })

  return {
    httpServer,
    io,
    bootSession,
    adminCode,
    // Hoisted to `createSessionAndBroadcast` above (plan 032d) so `POST
    // /api/register`'s handler — wired into the middleware chain above this
    // return statement — creates a session through the exact same
    // create-and-broadcast pairing an external caller gets from the returned
    // server object, rather than a second copy of this closure.
    createSession: createSessionAndBroadcast,
    // Hoisted to `destroySessionAndBroadcast` above (plan 032c) so the stop
    // route and the spawned-deck crash handler — both wired into the
    // middleware chain above this return statement — end a session through
    // exactly the same destroy-and-broadcast pairing an external caller gets
    // from the returned server object.
    destroySession: destroySessionAndBroadcast,
  }
}
