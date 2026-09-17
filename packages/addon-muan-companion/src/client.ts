import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'
import { getRoomCodeFromUrl } from './roomCode'

let socket: Socket | undefined

/**
 * Resolves the sync server's base URL from an env var (simplest option for
 * M1; revisit headmatter-driven config later if operators need a per-deck
 * override without env vars — not needed to hit M1's acceptance bar).
 * Shared by `getWorkshopSocket()` below (the Socket.io connection) and
 * `ErrorReportWidget.vue`'s plain `fetch()` call to `POST /api/screenshot`
 * (plan 028) — both need the *same* origin, so this is the one place that
 * reads the env var rather than each call site re-deriving it.
 */
export function getMuanCompanionServerUrl(): string {
  return import.meta.env.VITE_SLIDEV_MUAN_COMPANION_SERVER_URL ?? 'http://localhost:3710'
}

/**
 * Returns a single shared Socket.io connection to the sync server.
 *
 * Memoized at module scope rather than created fresh per call: `setup/main.ts`
 * (app-level, pre-mount) and the M2 components (`StepCommand.vue`,
 * `JoinScreen.vue`, both real mounted components) all need to talk to the
 * same socket — e.g. a component's `participant:copy` has to go out on the
 * connection that already carries this browser's `socket.data.participantId`
 * from `participant:join`. A plain ES module is a singleton per bundle, so
 * every importer of this file gets the same instance without provide/inject
 * (which `setup/main.ts` can't use — see its own comment on injection
 * context).
 */
export function getWorkshopSocket(): Socket {
  if (!socket) {
    // Bug found live: with no room hint at all, `muan-companion-server`'s
    // `io.on('connection')` resolves *every* socket from this deck to its
    // *boot* session (`ROOM_CODE_QUERY_PARAM`'s own comment describes this
    // fallback, and `server.ts`'s `buildPresenterUrl` doc comment has the
    // full incident) — fine for the one pre-032a deployment where this deck
    // *is* the boot session, silently wrong for every deck this server
    // launched itself (`POST /api/launch`) or that registered itself (`POST
    // /api/register`): the presenter's own `presenter:setSlide` moved the
    // *wrong* room's slide, participants' `participant:join` was checked
    // against the *wrong* room's code, and the dashboard's `dashboard:join`
    // was checked against the *wrong* room's presenter code — three
    // independent-looking failures with the one root cause.
    //
    // `getRoomCodeFromUrl()` reads the same `?roomCode=` param `buildJoinUrl`
    // embeds in every participant link and `buildPresenterUrl` now embeds in
    // every presenter link — so this one call covers both windows a deck
    // opens, with no route-specific branching needed here. `undefined` when
    // the URL carries none (a deck opened with no query string at all, or
    // pre-032a's single-boot-session workflow) omits `query` entirely rather
    // than sending an empty string, so the server's own "no hint → boot
    // session" default is exactly what runs — unchanged for every deployment
    // that predates multi-room support.
    const roomCode = getRoomCodeFromUrl()
    socket = io(getMuanCompanionServerUrl(), {
      autoConnect: true,
      reconnection: true,
      ...(roomCode ? { query: { roomCode } } : {}),
    })
  }
  return socket
}
