import process from 'node:process'
import { generateCode } from './codeGeneration'
import { buildJoinUrl, createMuanCompanionServer, DEFAULT_DECK_URL } from './server'

const PORT = Number(process.env.PORT ?? 3710)

// Plan 031a: previously an unset code meant "fail closed until an operator
// configures one" — every join/presenter action/dashboard-open rejected
// (that enforcement, in `auth.ts`, is untouched). What changes is that
// "unconfigured" no longer means *no code exists* — a fresh one is generated
// here instead, so `pnpm dev` with zero env vars set still produces a fully
// working server; the codes just come from this process rather than an
// operator having to invent and remember one. An explicitly-set env var
// always wins over generation (a demo that wants the same code every run,
// or a scripted/CI setup, still works exactly as before) — `||`, not `??`,
// so an explicitly-set-but-empty string is treated the same as unset,
// matching this file's pre-existing `!roomCode` truthiness check.
//
// Presenter code is longer than the room code: it's the higher-privilege of
// the two secrets (see `auth.ts`'s own comment on why they're never
// derivable from one another), so it gets more entropy for the same
// "readable/typeable" alphabet.
const ROOM_CODE_LENGTH = 6
const PRESENTER_CODE_LENGTH = 8

const roomCodeFromEnv = process.env.SLIDEV_MUAN_COMPANION_ROOM_CODE
const presenterCodeFromEnv = process.env.SLIDEV_MUAN_COMPANION_PRESENTER_CODE
const roomCode = roomCodeFromEnv || generateCode(ROOM_CODE_LENGTH)
const presenterCode = presenterCodeFromEnv || generateCode(PRESENTER_CODE_LENGTH)
// Where participants should actually load the deck from — a *different*
// process/port than this one (this server is only the companion sync
// backend; see the package README). Defaults to Slidev's own default `dev`
// port so a quick local trial (no env configured at all) still produces a
// working link rather than an obviously-broken one — see `DEFAULT_DECK_URL`'s
// own doc comment in `server.ts` for why the literal lives there, not here.
const deckUrl = process.env.SLIDEV_MUAN_COMPANION_DECK_URL ?? DEFAULT_DECK_URL

const { httpServer } = createMuanCompanionServer({
  origin: process.env.SLIDEV_MUAN_COMPANION_ORIGIN ?? '*',
  roomCode,
  presenterCode,
  deckUrl,
})

httpServer.listen(PORT, () => {
  // eslint-disable-next-line no-console -- deliberate startup log for a CLI-run server process, not app logging.
  console.log(`muan-companion-server listening on :${PORT}`)
  // Answers "how does the presenter find out the codes to hand out" — every
  // code is now guaranteed to exist (generated above if not configured), so
  // this always has something real to print, unlike the old "only if both
  // are configured" version of this block. Each line notes whether its code
  // was generated or came from an env var, since a generated one changes
  // every restart — an operator relying on a *fixed* code across restarts
  // (e.g. a recurring demo) needs to know to set the env var instead. The
  // dashboard page itself shows the same two values once opened (via
  // `dashboard:join`'s ack, gated on already knowing the presenter code) as
  // a second, harder-to-miss place to find them mid-session.
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Room code (give to participants): ${roomCode}${roomCodeFromEnv ? '' : ' (auto-generated — set SLIDEV_MUAN_COMPANION_ROOM_CODE for a fixed one)'}`)
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Presenter code (yours only): ${presenterCode}${presenterCodeFromEnv ? '' : ' (auto-generated — set SLIDEV_MUAN_COMPANION_PRESENTER_CODE for a fixed one)'}`)
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Dashboard: http://localhost:${PORT}/dashboard?code=${presenterCode}`)
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Append ?code=${presenterCode} to your own /presenter/N deck URL.`)
  // Same `buildJoinUrl` the dashboard's own `dashboard:join` ack uses (see
  // `server.ts`) — computed independently here rather than read back off the
  // running server, since `createMuanCompanionServer` only returns
  // `{ httpServer, io }`, not its internal join-URL value; sharing the one
  // pure function is what keeps this log line and the dashboard panel from
  // ever disagreeing on the query-param name/encoding. Always a real link
  // now that `roomCode` is guaranteed non-empty (see above) — the `if` here
  // is defensive, not reachable in practice, but `buildJoinUrl`'s own
  // contract still returns `undefined` for an empty string, so this stays
  // correct rather than assuming.
  const joinUrl = buildJoinUrl(deckUrl, roomCode)
  if (joinUrl) {
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Participant join link: ${joinUrl}`)
  }
})
