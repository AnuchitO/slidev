import process from 'node:process'
import { buildJoinUrl, createMuanCompanionServer, DEFAULT_DECK_URL } from './server'

const PORT = Number(process.env.PORT ?? 3710)

// Plan 031a: previously an unset code meant "fail closed until an operator
// configures one" — every join/presenter action/dashboard-open rejected
// (that enforcement, in `auth.ts`, is untouched). What changes is that
// "unconfigured" no longer means *no code exists* — a fresh one is generated
// instead, so `pnpm dev` with zero env vars set still produces a fully
// working server; the codes just come from the server process rather than an
// operator having to invent and remember one. An explicitly-set env var
// always wins over generation (a demo that wants the same code every run,
// or a scripted/CI setup, still works exactly as before).
//
// Plan 032a moved the *generation* itself into `session.ts`'s
// `createSession` — the one function through which every workshop session,
// including this boot-time one, now comes into existence (see its own doc
// comment, and `ROOM_CODE_LENGTH`/`PRESENTER_CODE_LENGTH` next to it for why
// the presenter code is the longer of the two). This file's remaining job is
// only to decide *what to ask for*: an env var if one is set, otherwise
// nothing, which `createSession` reads as "generate one". `|| undefined`,
// not the raw value — an explicitly-set-but-empty env var must be treated
// the same as unset (matching this file's pre-existing truthiness check),
// since an empty string is a code `createSession` would otherwise honor
// verbatim and `auth.ts` would then reject every credential against.
const roomCodeFromEnv = process.env.SLIDEV_MUAN_COMPANION_ROOM_CODE
const presenterCodeFromEnv = process.env.SLIDEV_MUAN_COMPANION_PRESENTER_CODE
// Plan 032b's third credential — the cross-room *operator* one, gating
// `/home`, `home:join` and `GET /api/presentations` (and, per plan 032, the
// deck launcher and connect-key minting later). Read exactly like the two
// above, `|| undefined` included, and for exactly the same reason: an
// explicitly-set-but-empty env var is treated as unset by every other code
// here, and quietly making this one the exception would be a trap. Where the
// generation happens differs — `createSession` owns a *session's* codes,
// while this one belongs to the process, so `createMuanCompanionServer`
// resolves it (see its `adminCode` option) — but what this file decides is
// the same in all three cases: supply an env var if there is one, otherwise
// nothing.
const adminCodeFromEnv = process.env.SLIDEV_MUAN_COMPANION_ADMIN_CODE
// Opt-in root directory scanned for presentable decks (plan 032b). No
// default, deliberately: guessing a directory would either find nothing
// (noise) or find decks the operator never meant to expose (worse). Unset
// means the presentation list is empty everywhere it appears and this whole
// feature is a no-op — see `presentations.ts` for what a subdirectory has to
// contain to be listed.
const presentationsDir = process.env.SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR || undefined
// Where participants should actually load the deck from — a *different*
// process/port than this one (this server is only the companion sync
// backend; see the package README). Defaults to Slidev's own default `dev`
// port so a quick local trial (no env configured at all) still produces a
// working link rather than an obviously-broken one — see `DEFAULT_DECK_URL`'s
// own doc comment in `server.ts` for why the literal lives there, not here.
const deckUrl = process.env.SLIDEV_MUAN_COMPANION_DECK_URL ?? DEFAULT_DECK_URL

const { httpServer, bootSession, adminCode } = createMuanCompanionServer({
  origin: process.env.SLIDEV_MUAN_COMPANION_ORIGIN ?? '*',
  roomCode: roomCodeFromEnv || undefined,
  presenterCode: presenterCodeFromEnv || undefined,
  adminCode: adminCodeFromEnv || undefined,
  presentationsDir,
  deckUrl,
})

// Read back off the session that was actually created rather than off
// locally-computed values (plan 032a): whichever of the two codes came from
// generation is only known once `createSession` has run, and reading both
// from one place means the log can't drift from what the server is really
// enforcing. `bootSession.roomCode` is also the room every client that
// arrives without an explicit room hint lands in — see
// `MuanCompanionServer.bootSession`.
const { roomCode, presenterCode } = bootSession

httpServer.listen(PORT, () => {
  // Prefixed with `[muan-companion-server]`, same as every other
  // operator-facing log line below (and in `server.ts`'s join/resume
  // logging) — this line used to be the one holdout without it, which
  // mattered once real workshop operators started running this alongside
  // other processes and grepping/eyeballing mixed stdout for this server's
  // own lines specifically.
  // eslint-disable-next-line no-console -- deliberate startup log for a CLI-run server process, not app logging.
  console.log(`[muan-companion-server] listening on :${PORT}`)
  // Answers "how does the presenter find out the codes to hand out" — every
  // code is now guaranteed to exist (generated by `createSession` if not
  // configured), so this always has something real to print, unlike the old
  // "only if both are configured" version of this block. Each line notes
  // whether its code was generated or came from an env var, since a
  // generated one changes every restart — an operator relying on a *fixed*
  // code across restarts (e.g. a recurring demo) needs to know to set the
  // env var instead. The dashboard page itself shows the same two values
  // once opened (via `dashboard:join`'s ack, gated on already knowing the
  // presenter code) as a second, harder-to-miss place to find them
  // mid-session.
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Room code (give to participants): ${roomCode}${roomCodeFromEnv ? '' : ' (auto-generated — set SLIDEV_MUAN_COMPANION_ROOM_CODE for a fixed one)'}`)
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Presenter code (yours only): ${presenterCode}${presenterCodeFromEnv ? '' : ' (auto-generated — set SLIDEV_MUAN_COMPANION_PRESENTER_CODE for a fixed one)'}`)
  // Plan 032b's cross-room operator credential, logged in the same shape as
  // the two above (same prefix, same "generated vs. env var" note) — a
  // generated one changes every restart, and an operator who wants a stable
  // `/home` bookmark needs to know to set the env var. Read back off the
  // server rather than off `adminCodeFromEnv`, for the same reason the two
  // session codes are read off `bootSession`: whichever came from generation
  // is only known once the server has resolved it, and one source means the
  // log can't drift from what's actually enforced.
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Admin code (server operator, all rooms): ${adminCode}${adminCodeFromEnv ? '' : ' (auto-generated — set SLIDEV_MUAN_COMPANION_ADMIN_CODE for a fixed one)'}`)
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Dashboard: http://localhost:${PORT}/dashboard?code=${presenterCode}`)
  // The cross-room home view (plan 032b): every live session, plus the
  // discovered presentation list when
  // `SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR` is set. Logged unconditionally
  // — the session list half is useful whether or not discovery is
  // configured, so this isn't gated on `presentationsDir` the way the line
  // below it is.
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Home (all sessions): http://localhost:${PORT}/home?code=${adminCode}`)
  if (presentationsDir) {
    // Only when the operator actually opted in — a line about an unset
    // feature is noise, and the whole point of the unset case is that this
    // server behaves exactly as it did before 032b.
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Scanning for presentations in: ${presentationsDir}`)
  }
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Append ?code=${presenterCode} to your own /presenter/N deck URL.`)
  // Same `buildJoinUrl` the dashboard's own `dashboard:join` ack uses (see
  // `server.ts`) — computed independently here rather than read back off the
  // running server, since `createMuanCompanionServer` doesn't return its
  // internal join-URL value; sharing the one pure function is what keeps
  // this log line and the dashboard panel from ever disagreeing on the
  // query-param name/encoding. Always a real link now that `roomCode` is
  // guaranteed non-empty (see above) — the `if` here is defensive, not
  // reachable in practice, but `buildJoinUrl`'s own contract still returns
  // `undefined` for an empty string, so this stays correct rather than
  // assuming.
  const joinUrl = buildJoinUrl(deckUrl, roomCode)
  if (joinUrl) {
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Participant join link: ${joinUrl}`)
  }
})
