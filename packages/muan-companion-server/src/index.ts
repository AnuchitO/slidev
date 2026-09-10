import process from 'node:process'
import { killAllSpawnedDecks, MAX_CONCURRENT_SPAWNED_DECKS } from './deckLauncher'
import { buildJoinUrl, createMuanCompanionServer, DEFAULT_DECK_URL, DEFAULT_SERVER_PORT } from './server'

const PORT = Number(process.env.PORT ?? DEFAULT_SERVER_PORT)

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
// Plan 032c. Where *this* server is reachable from a participant's browser —
// injected into every server-launched deck as
// `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL`, and the origin a launched deck's own
// URL is built from. Unset falls back to `http://localhost:<PORT>` (resolved
// inside `createMuanCompanionServer`, see its `publicUrl` option), which is the
// same deliberately-local-but-well-formed posture `DEFAULT_DECK_URL` already
// takes. `|| undefined` for the same reason as every other read in this file.
const publicUrl = process.env.SLIDEV_MUAN_COMPANION_PUBLIC_URL || undefined
// Plan 032c's resource cap (plan 032's Security notes: "Cap concurrent spawned
// sessions (a config value, not a magic number)"). `Number.isFinite` +
// positivity check rather than a bare `Number(...)`: an unparseable or
// nonsensical value (`abc`, `0`, `-1`) must fall back to the documented
// default, not silently become `NaN` — which every `>=` comparison against
// would be false for, i.e. no cap at all, which is the one outcome this value
// exists to prevent.
const maxSpawnedDecksFromEnv = Number(process.env.SLIDEV_MUAN_COMPANION_MAX_SPAWNED_DECKS)
const maxSpawnedDecks = Number.isFinite(maxSpawnedDecksFromEnv) && maxSpawnedDecksFromEnv > 0
  ? Math.floor(maxSpawnedDecksFromEnv)
  : MAX_CONCURRENT_SPAWNED_DECKS
// Whether a server-launched deck binds to every interface (`--remote=`) rather
// than `localhost`. Off unless explicitly opted into — see `buildSlidevArgs`
// for why exposing a new port on every interface is an operator's decision to
// make knowingly rather than a default to inherit. Only the exact string
// `true` enables it: a half-set env var (`SLIDEV_MUAN_COMPANION_SPAWN_REMOTE=`,
// or a leftover `false`) must not open a port.
const spawnRemote = process.env.SLIDEV_MUAN_COMPANION_SPAWN_REMOTE === 'true'
// An explicit path to the Slidev CLI, for a deployment that installs it
// somewhere `resolveSlidevBinary`'s `node_modules/.bin` walk won't find. Almost
// always unset; see that function for the resolution order.
const slidevBinary = process.env.SLIDEV_MUAN_COMPANION_SLIDEV_BIN || undefined

const { httpServer, bootSession, adminCode } = createMuanCompanionServer({
  origin: process.env.SLIDEV_MUAN_COMPANION_ORIGIN ?? '*',
  roomCode: roomCodeFromEnv || undefined,
  presenterCode: presenterCodeFromEnv || undefined,
  adminCode: adminCodeFromEnv || undefined,
  presentationsDir,
  deckUrl,
  publicUrl,
  deckLaunch: {
    remote: spawnRemote,
    slidevBinary,
    maxConcurrent: maxSpawnedDecks,
  },
})

/**
 * Plan 032c / plan 032's Security notes: *"a spawned child survives its parent
 * unless explicitly killed on shutdown — wire `SIGTERM`/`SIGINT` handlers in
 * `index.ts` to kill every tracked child before exiting, or a server restart
 * leaves zombie `slidev dev` processes bound to ports the new server instance
 * then can't reuse."*
 *
 * This file had no shutdown handling at all before 032c (the process simply
 * died on its signal, which was correct when it owned nothing but sockets), so
 * this is new rather than an extension of something existing.
 *
 * Three deliberate choices a reviewer should check:
 *
 * - **`once`, not `on`.** A second `SIGINT` (an impatient operator hitting
 *   Ctrl-C again) must reach Node's default handler and kill this process
 *   outright, rather than re-entering a shutdown that is evidently already
 *   stuck.
 * - **`process.exit` is required.** Registering *any* handler for these
 *   signals suppresses Node's default terminate-on-signal behavior, so a
 *   handler that only cleaned up would leave the server running after Ctrl-C —
 *   a strictly worse outcome than the zombie children this is here to prevent.
 *   `128 + signum` is the conventional shell exit status for "killed by signal
 *   N", so `pnpm`/Docker/systemd read this the same way they read an
 *   unhandled signal.
 * - **No wait for the children to die.** `killAllSpawnedDecks` signals and
 *   returns. Waiting would mean an async shutdown with its own timeout, and it
 *   would buy nothing: `SIGTERM` is delivered by the kernel the moment it is
 *   sent, and it does not need this process to stay alive to be acted on.
 *   (`killAllSpawnedDecks` also arms a `SIGKILL` escalation, which is the part
 *   that genuinely cannot survive this process — accepted, because a child
 *   that ignores `SIGTERM` is a deck whose own code installed a handler, and
 *   reparenting to init with a SIGTERM already delivered is as far as this
 *   server's responsibility reasonably goes.)
 */
function shutdown(signal: 'SIGTERM' | 'SIGINT', signalNumber: number) {
  const killed = killAllSpawnedDecks()
  if (killed > 0) {
    // eslint-disable-next-line no-console -- deliberate shutdown log for a CLI-run server process, see the startup logs below.
    console.log(`[muan-companion-server] ${signal}: stopping ${killed} spawned deck${killed === 1 ? '' : 's'}`)
  }
  httpServer.close()
  process.exit(128 + signalNumber)
}

process.once('SIGTERM', () => shutdown('SIGTERM', 15))
process.once('SIGINT', () => shutdown('SIGINT', 2))

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
  // Plan 032d: a copy-pasteable example for the deck-initiated registration
  // flow, right under the code it needs — an operator who wants Flow B
  // shouldn't have to go find the admin code above and hand-assemble this.
  // eslint-disable-next-line no-console -- deliberate startup log, see above.
  console.log(`[muan-companion-server] Mint a connect key: curl -X POST -H 'x-muan-companion-admin-code: ${adminCode}' http://localhost:${PORT}/api/connect-key`)
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
    // Plan 032c. Printed only alongside the line above, for the same reason it
    // is gated: a deployment that never configured a discovery root can never
    // launch anything, so its launcher settings are noise. Both values are
    // ones an operator needs to be able to see without reading the source —
    // the cap is what a "refusing to launch" error will be measured against,
    // and whether spawned decks are reachable from other devices is the single
    // most likely thing to be wrong about a first Flow-A attempt.
    // eslint-disable-next-line no-console -- deliberate startup log, see above.
    console.log(`[muan-companion-server] Deck launcher: max ${maxSpawnedDecks} concurrent, spawned decks bound to ${spawnRemote ? 'all interfaces (--remote)' : 'localhost only (set SLIDEV_MUAN_COMPANION_SPAWN_REMOTE=true for LAN access)'}`)
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
