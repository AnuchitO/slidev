import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import process from 'node:process'
import { dirname, join } from 'pathe'

/**
 * Plan 032c, Flow A: starting a Slidev deck as a **child process of this
 * server**, on the server's own machine, because an operator clicked Present
 * on the `/home` dashboard.
 *
 * ## Read this before reviewing anything else in this file
 *
 * This module is, by construction, the most dangerous surface in this package:
 * an HTTP request causes a new operating-system process to run. Plan 032's own
 * sequencing table gives 032e ("security-review pass on 032c's spawn surface")
 * its own row, and this file is written to be *reviewable* rather than merely
 * correct — every property a reviewer would want to check has its reasoning
 * next to the code that implements it, in the same style `connectKey.ts` used
 * for its rate limiter.
 *
 * The four claims that make this defensible, each enforced somewhere concrete:
 *
 * 1. **No client-supplied path ever reaches `spawn`.** This module never
 *    accepts a presentation *id* at all — its caller
 *    (`deckLaunchRoutes.ts`) resolves an id to a directory through
 *    `presentations.ts`'s `resolvePresentationDir`, which is an exact-match
 *    lookup against a freshly-`readdirSync`-ed configured root and cannot
 *    escape it (see that function's own comment). `launchPresentation` takes
 *    the already-resolved absolute directory. There is no code path here that
 *    joins, normalizes, or otherwise constructs a path from anything a request
 *    carried.
 * 2. **`spawn`, never `exec`, never a shell string.** Command and arguments
 *    are separate argv entries handed to `child_process.spawn` with no
 *    `shell` option, so no value below is ever parsed by a shell. This is the
 *    same rule plan 006 already established elsewhere in this repo, and plan
 *    032's Security notes restate for exactly this feature.
 * 3. **Only an admin-code holder can reach it.** The route is gated on
 *    `adminAuth.ts`'s cross-room operator credential — see
 *    `deckLaunchRoutes.ts`.
 * 4. **The blast radius is capped.** `MAX_CONCURRENT_SPAWNED_DECKS` bounds how
 *    many children can exist at once, and every child is tracked so it can be
 *    killed on shutdown (`killAllSpawnedDecks`, wired to `SIGTERM`/`SIGINT` in
 *    `index.ts`).
 *
 * And the thing a reviewer should *not* be misled about: launching a deck is
 * **arbitrary code execution by design**, not by accident. A Slidev deck is a
 * Vite project — it can carry a `vite.config.ts`, `setup/*.ts` files, a local
 * theme, and npm dependencies, all of which run as this server's user the
 * moment `slidev` starts. Nothing in this file sandboxes any of that, and
 * nothing could without a container/user boundary this package does not own.
 * The real trust boundary is therefore **the discovery root plus the admin
 * code**: an operator who points `SLIDEV_MUAN_COMPANION_PRESENTATIONS_DIR` at
 * a directory anyone else can write to has handed that person code execution,
 * and no amount of care in this file changes that. That is stated here so the
 * 032e review can weigh it explicitly rather than rediscover it.
 */

/**
 * How many spawned decks may be live at once, counting launches still waiting
 * on their readiness probe.
 *
 * Plan 032's Security notes call this out by name: *"spawning arbitrary
 * numbers of `slidev dev` processes from a dashboard is a new way to run the
 * host out of ports/memory that didn't exist when this was 'one operator
 * manually starts one process'. Cap concurrent spawned sessions (a config
 * value, not a magic number) and reject Present requests past the cap with a
 * clear error rather than degrading silently."*
 *
 * **Why 4.** This is the default, overridable per deployment via
 * `SLIDEV_MUAN_COMPANION_MAX_SPAWNED_DECKS` (`index.ts`) — the proposal's own
 * open question 3 asked for exactly that shape, "a config value the owner sets
 * per-deployment with a sane default (e.g. 4)". The number itself is sized to
 * what a Vite dev server actually costs, not picked for roundness: each
 * `slidev` child is a full Node process with its own esbuild/Rollup dependency
 * optimizer and module graph — a few hundred MB resident for a realistic deck,
 * more while it is warming up. Four is comfortably survivable on the 2 GB
 * class of host this server is deployed to (see the package Dockerfile) and is
 * already more concurrent workshops than the "one operator, one room" story
 * this package was built for. An operator who genuinely runs more raises the
 * env var and takes responsibility for the host having the memory.
 *
 * The cap is deliberately *not* per-presentation. Launching the same deck
 * twice is a legitimate thing to do (two cohorts, two rooms, same material),
 * and the resource this protects is the host's, which does not care which deck
 * is consuming it.
 */
export const MAX_CONCURRENT_SPAWNED_DECKS = 4

/**
 * How long a freshly-spawned deck has to start answering HTTP on its port
 * before the launch is declared failed.
 *
 * 30 seconds because the first `slidev` start in a deck folder is not a
 * warm-start: Vite runs its dependency optimizer over the deck's imports,
 * which on a cold cache is genuinely tens of seconds on a modest host. A
 * shorter timeout would turn "this deck's first launch of the day" into a
 * spurious failure. It is a *timeout*, not a delay — a warm deck answers in
 * well under a second and the probe returns as soon as it does.
 */
export const READINESS_TIMEOUT_MS = 30_000

/**
 * How often the readiness probe retries while waiting. 250ms is short enough
 * that a warm start feels instant and long enough that a 30-second wait is
 * ~120 connection attempts rather than thousands.
 */
export const READINESS_POLL_INTERVAL_MS = 250

/**
 * How much of a failed child's output is kept for the error message.
 *
 * Plan 032's new-responsibilities list asks for *"log capture (at least
 * stderr, for surfacing 'this deck failed to start' instead of a silent
 * timeout)"*. A ring-buffered tail rather than the whole stream, because a
 * `slidev` child that fails in a loop (restart-on-config-change, a watcher
 * thrashing) can emit unbounded output and this server has no business
 * accumulating it. The *tail* specifically, not the head: the error that
 * actually killed the process is the last thing printed, not the first.
 *
 * 4 KiB is roughly 40-50 lines of Vite output — enough to carry a stack trace
 * plus the line before it, small enough that N of these sitting in memory is
 * not a consideration.
 */
export const OUTPUT_TAIL_BYTES = 4096

/**
 * The env var the spawned child is given so the deck's addon knows where to
 * find this server.
 *
 * This is the entire mechanism by which Flow A works without a single change
 * to `addon-muan-companion/src/client.ts`: `slidev` *is* a Vite dev server,
 * Vite inlines `VITE_*` variables it finds in `process.env` into the client
 * bundle, and the addon's `getMuanCompanionServerUrl()` already reads this
 * exact name. A process started by a human with the var exported and a process
 * started by this file with the var in its `env` are indistinguishable to
 * Vite.
 */
export const SERVER_URL_ENV = 'VITE_SLIDEV_MUAN_COMPANION_SERVER_URL'

/**
 * Env vars stripped from the child's environment before `SERVER_URL_ENV` is
 * set on it.
 *
 * The parent process holds this server's own secrets in its environment
 * (`SLIDEV_MUAN_COMPANION_ADMIN_CODE`, `..._PRESENTER_CODE`, `..._ROOM_CODE`)
 * and `{ ...process.env }` would hand every one of them to the child. Vite
 * does not expose a non-`VITE_` variable to the browser bundle, so this is not
 * a path to leaking a code to participants — but the child is a Vite project
 * whose config and setup files are operator-authored JavaScript that runs with
 * full `process.env` access, and there is no reason for a deck to be able to
 * read this server's admin code. Removing what the child provably does not
 * need is free; the one variable it *does* need is set explicitly below.
 *
 * Matches the `VITE_`-prefixed spellings too, so a stale
 * `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL` inherited from the operator's own
 * shell can never win over the one this launcher injects.
 */
const STRIPPED_CHILD_ENV_PATTERN = /^(?:VITE_)?SLIDEV_MUAN_COMPANION_/

/**
 * How long a stopped child gets to exit on `SIGTERM` before it is `SIGKILL`ed.
 *
 * A Vite dev server closes its own http server and watchers on SIGTERM, which
 * is quick but not instant. Escalating after 5 seconds means a wedged child
 * (a deck whose own `setup/` code installed a signal handler that hangs) still
 * releases its port instead of surviving as the zombie plan 032's Security
 * notes warn about.
 */
const KILL_ESCALATION_MS = 5000

/**
 * The path, relative to some ancestor directory, at which a deck's installed
 * Slidev CLI lives. See `resolveSlidevBinary`.
 */
const SLIDEV_BIN_RELATIVE_PATH = join('node_modules', '.bin', 'slidev')

/**
 * The `spawn` this module uses, narrowed to exactly the call shape
 * `launchPresentation` makes.
 *
 * Injectable for the same reason `createSessionOptions.generate` and
 * `mintConnectKeyOptions.now` are (this package's established
 * dependency-injection convention): the tests for port allocation, readiness
 * timeouts, the concurrency cap, and crash teardown all need to drive this
 * code without a real `slidev` installation — and a test that had to install
 * Slidev to assert "an unknown presentation id spawns nothing" would be
 * testing the wrong thing anyway. Injected as a parameter rather than mocked
 * at the module level so the production path is the *default value* of that
 * parameter, visible in this file, rather than something a test framework
 * replaces out of band.
 *
 * The narrow signature is deliberate: it does not accept a `shell` option, so
 * no caller — test or production — can turn this into a shell invocation.
 */
export type SpawnDeckProcess = (
  command: string,
  args: readonly string[],
  options: { cwd: string, env: NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] },
) => ChildProcess

/** Why a launch failed, for a caller that wants to map it onto an HTTP status. */
export type DeckLaunchFailure
  /** `MAX_CONCURRENT_SPAWNED_DECKS` (or the configured override) is already reached. */
  = | 'at-capacity'
  /** `spawn` itself failed — most often the `slidev` CLI is not installed/resolvable. */
    | 'spawn-failed'
  /** The child exited before it ever answered on its port. */
    | 'exited-early'
  /** The child is still running but never answered within the readiness timeout. */
    | 'timeout'

export class DeckLaunchError extends Error {
  constructor(readonly reason: DeckLaunchFailure, message: string) {
    super(message)
    this.name = 'DeckLaunchError'
  }
}

/** One live child process started by this module. */
export interface LaunchedDeck {
  /** The `Presentation.id` this was started from — for logs and the launch response. */
  presentationId: string
  /** The port the child was told to listen on, and is confirmed to be answering on. */
  port: number
  child: ChildProcess
  /** The tail of the child's combined stderr/stdout — see `OUTPUT_TAIL_BYTES`. */
  outputTail: () => string
  /** Set once the child's `exit`/`error` has fired. */
  exited: boolean
}

interface TrackedDeck extends LaunchedDeck {
  /**
   * Called when the child exits *without* having been stopped through
   * `stopSpawnedDeck`/`killAllSpawnedDecks` — i.e. it crashed, or someone
   * killed it directly. Set at adoption time; see `adoptLaunchedDeck`.
   */
  onUnexpectedExit?: () => void
  /** Set by every deliberate stop path, so `onUnexpectedExit` doesn't fire for it. */
  stopping: boolean
}

/**
 * Every child this process has started and not yet reaped, keyed by the room
 * code of the session it belongs to.
 *
 * Module-level, like `connectKey.ts`'s key store and `session.ts`'s `rooms`,
 * and for the same reason: it is process-wide state that outlives any one
 * request, and `index.ts`'s signal handlers need to reach it without holding a
 * server object. In-memory only — there is no persistence anywhere in this
 * package, and a restarted server does not (and must not pretend to) adopt
 * children a previous instance started.
 */
const spawnedDecks = new Map<string, TrackedDeck>()

/**
 * Children that have been spawned but do not yet belong to a session.
 *
 * A launch is two steps that cannot be one: spawn-and-wait-for-ready, then
 * create the session that will own the child. Between them the child exists
 * and is consuming a port and a few hundred MB, so it must already count
 * against the cap and must already be killable on shutdown — but it has no
 * room code to be keyed by yet. This set is that window. `adoptLaunchedDeck`
 * moves an entry out of it; `discardLaunchedDeck` kills and drops one when the
 * caller fails between the two steps.
 */
const unadoptedDecks = new Set<TrackedDeck>()

/** How many children exist right now, adopted or not — what the cap is checked against. */
export function spawnedDeckCount(): number {
  return spawnedDecks.size + unadoptedDecks.size
}

/** Whether this room's session owns a spawned child. Flow-B sessions do not. */
export function hasSpawnedDeck(roomCode: string): boolean {
  return spawnedDecks.has(roomCode)
}

/**
 * Finds the `slidev` executable to run for a deck.
 *
 * **Why a resolution walk rather than a hardcoded command.** This package
 * deliberately does not depend on `@slidev/cli` (see its `package.json` — its
 * dependencies are the sync server's own: socket.io, connect, sirv, busboy,
 * qrcode, pathe). It is deployed as a standalone process, often in its own
 * container. So the CLI it spawns is *the deck's own installed CLI*, which is
 * the correct one to use anyway: a deck pinned to Slidev 51 must not be
 * started by a Slidev 52 binary that happens to be on this server's `PATH`.
 *
 * The walk — `node_modules/.bin/slidev` in the deck folder, then each ancestor
 * up to the filesystem root — is exactly what a shell running `pnpm exec
 * slidev` or an npm script in that folder resolves, so a deck that works when
 * started by hand works when started here. It finds a deck-local install
 * first, then a workspace-root hoisted one (which is how a deck inside this
 * monorepo, or under a pnpm workspace with `shamefullyHoist`, gets its CLI).
 *
 * `PATH` is the last resort, not the first: falling back to the bare name
 * `slidev` lets a globally-installed CLI work, and produces a clean `ENOENT`
 * from `spawn` (surfaced as a `spawn-failed` `DeckLaunchError` with the
 * command in it) when there is no such thing — which is a far better operator
 * experience than a readiness timeout that says nothing about why.
 *
 * An explicit `override` (`SLIDEV_MUAN_COMPANION_SLIDEV_BIN`) wins over all of
 * it, for the deployment that installs the CLI somewhere unusual. That value
 * is operator configuration, never request input — the same status as
 * `presentationsDir`.
 *
 * Note the walk crosses out of the discovery root into its ancestors. That is
 * not a boundary this could violate: `spawn` runs the deck's own project code
 * regardless (see this module's header comment), so an attacker who can plant
 * a `node_modules/.bin/slidev` above the discovery root can already plant a
 * `vite.config.ts` inside it. The walk is chosen to match how the deck would
 * resolve its own tooling, not as a security control.
 *
 * Windows is not handled: the executable there is `slidev.CMD`, which `spawn`
 * cannot run without `shell: true`, and turning this call into a shell
 * invocation is exactly what rule 2 in this module's header forbids. This
 * package's supported deployment is Linux/macOS (`node:22-alpine` in its
 * Dockerfile); a Windows operator sets the override to a `node` + script path
 * or runs the server in WSL.
 */
export function resolveSlidevBinary(presentationDir: string, override?: string): string {
  if (override)
    return override
  let dir = presentationDir
  for (;;) {
    const candidate = join(dir, SLIDEV_BIN_RELATIVE_PATH)
    if (existsSync(candidate))
      return candidate
    const parent = dirname(dir)
    if (parent === dir)
      return 'slidev'
    dir = parent
  }
}

/**
 * Builds the argv for one deck, past the executable.
 *
 * **There is no `dev` subcommand.** Plan 032 and this repo's own prose both
 * say "spawns `slidev dev`", but that is shorthand: the Slidev CLI's dev
 * server is its *default* command (`cli.command('* [entry]')` in
 * `packages/slidev/node/cli.ts` — the named commands are `build`, `format`,
 * `mcp`, `theme`, `export`, `export-notes`, and no `dev` among them). Passing
 * a literal `dev` would be parsed as the `[entry]` positional, i.e. "open the
 * deck file named `dev`", and fail — or worse, prompt. This repo's own demo
 * decks confirm the real shape: `demo/starter`'s `dev` script is
 * `slidev ./slides.md --open=false --log=info`. So the argv is flags only.
 *
 * - `--port=<n>` — the port `allocateEphemeralPort` just reserved. The CLI
 *   sets Vite's `strictPort` when an explicit port is given, so if something
 *   grabbed the port in the gap (see `allocateEphemeralPort`'s TOCTOU note)
 *   the child fails loudly and immediately instead of silently listening
 *   somewhere else — which is exactly what we want, because the URL handed to
 *   participants is built from *our* number.
 * - `--open=false` — the CLI's own default is already `false`, but it has not
 *   always been, and a server that pops a browser window on the host every
 *   time an operator clicks Present would be a memorable bug. Written as one
 *   `--open=false` token rather than `--open false`: yargs would read the
 *   space-separated form as a bare boolean flag followed by a positional, and
 *   that positional is `[entry]` — the deck would try to open a file named
 *   `false`.
 * - `--log=warn` — the CLI's default too, restated for the same
 *   don't-depend-on-a-default reason, and because this server captures the
 *   child's output into a fixed-size tail (`OUTPUT_TAIL_BYTES`): at `info` the
 *   useful error would be pushed out of the tail by routine request logging.
 * - `--remote=` (only when `remote` is set) — binds the deck to every
 *   interface (`--bind`'s `0.0.0.0` default) instead of `localhost`. **Off by
 *   default, deliberately.** The participant URL this server hands back is
 *   only reachable from other devices if the deck listens on a reachable
 *   interface, so a real workshop needs this on — but "a click on a dashboard
 *   silently exposes a new port on every interface" is a decision for the
 *   operator to make knowingly, not a default to inherit, on the one feature
 *   plan 032 already singles out for a security review. Set
 *   `SLIDEV_MUAN_COMPANION_SPAWN_REMOTE=true` to opt in. The empty value
 *   matters: `--remote` takes an optional *password*, and `--remote=` with
 *   nothing after it is how the CLI reads "remote, no password" (its own
 *   `remote !== undefined` / `if (remote)` checks) — it also avoids the
 *   public-IP lookup the CLI does for a non-empty value, which would add a
 *   network round-trip to every launch.
 */
export function buildSlidevArgs(port: number, remote: boolean): string[] {
  const args = [`--port=${port}`, '--open=false', '--log=warn']
  if (remote)
    args.push('--remote=')
  return args
}

/**
 * Reserves a free TCP port by binding to port 0 and reading back what the
 * kernel assigned, then closing.
 *
 * **The race is real and accepted.** Between this listener closing and the
 * spawned `slidev` binding the same number, another process on the host could
 * take it. This is the same ephemeral-port-probe every tool in this ecosystem
 * uses (Vite, `get-port-please`, which Slidev's own CLI depends on), and it is
 * fine here for two reasons: the window is milliseconds on a host that is not
 * otherwise churning through ports, and the failure is *loud* rather than
 * silent — `--port=` makes the CLI set Vite's `strictPort`, so a lost race
 * kills the child with a "port already in use" message that lands in the
 * captured output tail and comes back to the operator as a failed launch they
 * can simply retry. What is emphatically not accepted is the alternative
 * failure mode of a fixed or incrementing port: two decks launched
 * back-to-back must never collide, and with kernel-assigned ports they cannot.
 *
 * Bound on `127.0.0.1` rather than `0.0.0.0`: the probe should not be briefly
 * reachable from the network, and a port free on the loopback interface is
 * free for the child to bind on any interface (Linux/macOS allocate the
 * ephemeral range per-protocol, not per-address, for this purpose).
 */
export function allocateEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer()
    // Unreferenced so this transient listener can never, even for the
    // milliseconds it exists, be the thing holding the event loop open.
    probe.unref()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (address === null || typeof address === 'string') {
        // Not reachable for a TCP listener that just fired `listening`, but
        // `address()` is typed to allow it (pipes/UDS) and guessing a port
        // number would be worse than failing the launch.
        probe.close(() => reject(new Error('[muan-companion-server] could not determine an ephemeral port')))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

/**
 * Attaches a bounded tail capture to one of the child's output streams.
 *
 * The listener also serves a second, less obvious purpose: a piped stream that
 * nobody reads fills its OS buffer and then **blocks the child** on its next
 * write. A `slidev` process that had logged 64 KiB and then frozen mid-render
 * would be an extremely confusing bug to chase, so both streams are consumed
 * here even though only the tail is kept.
 */
function captureTail(stream: Readable | null, appendChunk: (chunk: string) => void) {
  if (!stream)
    return
  stream.setEncoding('utf8')
  stream.on('data', (chunk: string) => appendChunk(chunk))
  // A child that dies mid-write can emit an error on its own pipe; there is
  // nothing to do about it and an unhandled `error` on a stream is a
  // process-level crash.
  stream.on('error', () => {})
}

/**
 * One HTTP probe against the child's port. Resolves `true` for *any* HTTP
 * response, including a 404 or a 500.
 *
 * "Answers HTTP on the port we assigned" is the property that actually
 * matters — it is precisely what a participant's browser needs to be true —
 * and it is the property that is stable across Slidev/Vite versions.
 *
 * The rejected alternative was scraping the child's stdout for Vite's "ready
 * in Nms" line, which plan 032 offers as an equally acceptable option. It is
 * not, quite: that string is formatted, ANSI-colored, localized by log level
 * (`--log=warn`, which this launcher passes, suppresses it entirely), and has
 * changed shape across Vite majors. Tying launch success to a log line's
 * wording would make a routine Slidev upgrade break this server in a way whose
 * only symptom is "every launch times out".
 *
 * **Probed at `localhost`, not a hardcoded `127.0.0.1`.** Without `--remote`,
 * `buildSlidevArgs` leaves the CLI's host at its own default, which is the
 * literal string `'localhost'` (`packages/slidev/node/cli.ts`) — Vite/Node
 * then resolve *that* at bind time via the host's own resolver, and on a
 * machine where `localhost` resolves to `::1` first (common on modern
 * macOS/Linux — Node 18+'s default DNS ordering), the child ends up bound to
 * the IPv6 loopback only. A probe hardcoded to the IPv4 literal never
 * connects to that socket at all — every launch times out after the full
 * `READINESS_TIMEOUT_MS` even though the deck came up and is reachable at
 * `http://localhost:<port>` the whole time. Probing the same `'localhost'`
 * hostname (rather than an IP literal) resolves through the identical
 * mechanism Vite used, on the same host, so the two agree regardless of
 * which family that host prefers.
 */
function probeReady(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpRequest({ host: 'localhost', port, method: 'GET', path: '/', timeout: timeoutMs }, (res) => {
      // Drain rather than parse: this is a liveness check, and leaving the
      // response unconsumed would keep the socket open.
      res.resume()
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.end()
  })
}

const defaultSpawn: SpawnDeckProcess = (command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions)

export interface LaunchPresentationOptions {
  /**
   * The deck's absolute directory, **already resolved by
   * `resolvePresentationDir`**. This module never resolves an id itself — see
   * the header comment's claim 1.
   */
  presentationDir: string
  /** The `Presentation.id` that resolved to `presentationDir`. Carried for logs/response only. */
  presentationId: string
  /** The externally-reachable URL of *this* server, injected as `SERVER_URL_ENV`. */
  serverUrl: string
  /** Pass `--remote=` to the child — see `buildSlidevArgs`. Defaults to `false`. */
  remote?: boolean
  /** Explicit path to the Slidev CLI — see `resolveSlidevBinary`. */
  slidevBinary?: string
  /** Defaults to `MAX_CONCURRENT_SPAWNED_DECKS`. */
  maxConcurrent?: number
  /** Defaults to `READINESS_TIMEOUT_MS`. */
  readinessTimeoutMs?: number
  /** Defaults to `READINESS_POLL_INTERVAL_MS`. */
  readinessPollIntervalMs?: number
  /** Injectable for tests — see `SpawnDeckProcess`. Defaults to `child_process.spawn`. */
  spawn?: SpawnDeckProcess
  /** Injectable for tests. Defaults to `allocateEphemeralPort`. */
  allocatePort?: () => Promise<number>
  /** The environment the child's env is derived from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

/**
 * Starts one deck and resolves once it is answering HTTP on its own port.
 *
 * Rejects with a `DeckLaunchError` — never hangs, never resolves a child that
 * is not actually serving. On every failure path the child is killed before
 * the rejection, so a timed-out launch does not leave a process behind that
 * would count against the cap forever.
 *
 * The returned `LaunchedDeck` is **not yet tracked by room code**: it lives in
 * `unadoptedDecks` (so it already counts against the cap and is already killed
 * on shutdown) until the caller either calls `adoptLaunchedDeck` with the room
 * code of the session it created for it, or `discardLaunchedDeck` if creating
 * that session failed. Splitting it this way is what keeps "spawn a process"
 * and "create a session" from having to happen inside one another — the
 * launcher knows nothing about sessions, and `session.ts` knows nothing about
 * processes.
 */
export async function launchPresentation(options: LaunchPresentationOptions): Promise<LaunchedDeck> {
  const maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_SPAWNED_DECKS
  // Checked *first*, before a port is reserved or anything is spawned — the
  // cap is a resource guard, so it must run before any resource is taken.
  if (spawnedDeckCount() >= maxConcurrent) {
    throw new DeckLaunchError(
      'at-capacity',
      `[muan-companion-server] refusing to launch: ${spawnedDeckCount()} of ${maxConcurrent} spawned decks already running`,
    )
  }

  const spawnProcess = options.spawn ?? defaultSpawn
  const allocatePort = options.allocatePort ?? allocateEphemeralPort
  const timeoutMs = options.readinessTimeoutMs ?? READINESS_TIMEOUT_MS
  const pollIntervalMs = options.readinessPollIntervalMs ?? READINESS_POLL_INTERVAL_MS

  const port = await allocatePort()
  const binary = resolveSlidevBinary(options.presentationDir, options.slidevBinary)
  const args = buildSlidevArgs(port, options.remote ?? false)

  let child: ChildProcess
  try {
    child = spawnProcess(binary, args, {
      // The only path handed to the child, and it came from
      // `resolvePresentationDir`. `slidev` with no positional entry opens
      // `slides.md` in its cwd, which is the file `presentations.ts` already
      // verified exists — so there is no entry argument to build, and
      // therefore no place a deck's own name could end up in argv at all.
      cwd: options.presentationDir,
      env: childEnv(options.env ?? process.env, options.serverUrl),
      // stdin ignored (the CLI's interactive shortcuts are guarded on
      // `process.stdin.isTTY`, so a /dev/null stdin is a no-op for it);
      // stdout/stderr piped so `captureTail` can explain a failed launch.
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }
  catch (error) {
    // `spawn` throws synchronously only for bad arguments; a missing binary
    // arrives as an async `error` event instead (handled below). Covered
    // anyway so a throw here can never escape as an unhandled rejection.
    throw new DeckLaunchError('spawn-failed', `[muan-companion-server] could not start "${binary}": ${String(error)}`)
  }

  let tail = ''
  const appendChunk = (chunk: string) => {
    tail = (tail + chunk).slice(-OUTPUT_TAIL_BYTES)
  }
  captureTail(child.stderr, appendChunk)
  captureTail(child.stdout, appendChunk)

  const tracked: TrackedDeck = {
    presentationId: options.presentationId,
    port,
    child,
    outputTail: () => tail,
    exited: false,
    stopping: false,
  }
  // In the registry *before* the first await after spawning, so a shutdown
  // signal arriving mid-readiness-probe still finds this child and kills it.
  unadoptedDecks.add(tracked)

  // Both listeners are attached immediately, not after readiness: a child that
  // dies during its own startup is the single most likely failure here (a deck
  // with a broken frontmatter, a missing theme, a port lost to the TOCTOU
  // race), and the readiness loop below reads `tracked.exited` to fail fast
  // instead of waiting out the full timeout for a process that is already
  // gone.
  child.on('error', (error) => {
    // `spawn`'s async failure — overwhelmingly `ENOENT`, i.e. no Slidev CLI
    // where `resolveSlidevBinary` looked. Recorded into the same tail the
    // error message reports, so the operator sees the cause rather than a
    // bare timeout.
    appendChunk(`\n[spawn error] ${String(error)}\n`)
    tracked.exited = true
    handleExit(tracked)
  })
  child.on('exit', () => {
    tracked.exited = true
    handleExit(tracked)
  })

  const ready = await waitForReady(tracked, timeoutMs, pollIntervalMs)
  if (ready)
    return tracked

  // Failed: kill it (a no-op if it already exited) and drop it, so a launch
  // that never came up does not permanently consume one of the cap's slots.
  discardLaunchedDeck(tracked)
  const detail = tracked.outputTail().trim()
  const suffix = detail ? `\n--- deck output (last ${OUTPUT_TAIL_BYTES} bytes) ---\n${detail}` : ''
  if (tracked.exited) {
    throw new DeckLaunchError(
      'exited-early',
      `[muan-companion-server] "${options.presentationId}" exited before it started serving on port ${port}.${suffix}`,
    )
  }
  throw new DeckLaunchError(
    'timeout',
    `[muan-companion-server] "${options.presentationId}" did not answer on port ${port} within ${timeoutMs}ms.${suffix}`,
  )
}

/**
 * The child's environment: the parent's, minus this server's own secrets (see
 * `STRIPPED_CHILD_ENV_PATTERN`), plus the one variable that makes the deck
 * find its way back here.
 */
function childEnv(base: NodeJS.ProcessEnv, serverUrl: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (!STRIPPED_CHILD_ENV_PATTERN.test(key))
      env[key] = value
  }
  env[SERVER_URL_ENV] = serverUrl
  return env
}

/**
 * Polls until the child answers, the child dies, or the deadline passes.
 *
 * The early-exit check is what turns "a deck that fails to start" from a
 * 30-second wait into an immediate, well-explained failure.
 */
async function waitForReady(deck: TrackedDeck, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (deck.exited)
      return false
    if (await probeReady(deck.port, Math.max(1, Math.min(pollIntervalMs * 4, timeoutMs))))
      return true
    if (deck.exited || Date.now() >= deadline)
      return false
    await delay(pollIntervalMs)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    // Unreferenced: a pending readiness poll must never be the reason a
    // process that is otherwise done refuses to exit.
    setTimeout(resolve, ms).unref()
  })
}

/**
 * Runs the crash callback for a child that died on its own, exactly once.
 *
 * `stopping` is what separates "the operator pressed Stop" from "this thing
 * fell over": both end with an `exit` event, and only the second one should
 * tear a session down as a surprise. A stopped deck's session is already being
 * destroyed by `stopSpawnedDeck`'s caller.
 */
function handleExit(deck: TrackedDeck) {
  if (deck.stopping)
    return
  deck.stopping = true
  const callback = deck.onUnexpectedExit
  deck.onUnexpectedExit = undefined
  callback?.()
}

/**
 * Binds a launched child to the session that now owns it.
 *
 * `onUnexpectedExit` is plan 032's *"react to the child exiting on its own
 * (crash, someone Ctrl-C'd it directly) by tearing down the Session and
 * notifying any connected dashboard/participants — don't leave a Session
 * pointing at a dead process"*. The callback is supplied by `server.ts` and is
 * the same `destroySession`-plus-`broadcastHomeUpdate` pairing every other
 * session-ending path uses; this module deliberately knows nothing about
 * sessions or sockets.
 *
 * The already-exited case is handled rather than assumed away: a child can die
 * in the microseconds between its readiness probe succeeding and its session
 * being created, and a crash callback registered onto an already-dead child
 * would otherwise never fire, leaving a session pointing at nothing forever.
 */
export function adoptLaunchedDeck(roomCode: string, deck: LaunchedDeck, onUnexpectedExit: () => void): void {
  const tracked = deck as TrackedDeck
  unadoptedDecks.delete(tracked)
  spawnedDecks.set(roomCode, tracked)
  tracked.onUnexpectedExit = () => {
    spawnedDecks.delete(roomCode)
    onUnexpectedExit()
  }
  if (tracked.exited) {
    tracked.stopping = false
    handleExit(tracked)
  }
}

/**
 * Kills and forgets a child that never became a session's — the failure path
 * of a launch, and the compensating action for a caller whose session creation
 * threw after a successful spawn.
 */
export function discardLaunchedDeck(deck: LaunchedDeck): void {
  const tracked = deck as TrackedDeck
  unadoptedDecks.delete(tracked)
  killDeck(tracked)
}

/**
 * Stops the child belonging to one session, if it has one.
 *
 * Returns whether there was a process to stop. **`false` is an ordinary
 * answer, not an error**: a Flow-B session (a deck that registered itself via
 * `POST /api/register`) is a URL this server does not control the lifecycle
 * of, and the correct treatment of "stop that one" is to destroy the session
 * and leave the operator's own `slidev` process alone. The caller destroys the
 * session either way — see `deckLaunchRoutes.ts`.
 */
export function stopSpawnedDeck(roomCode: string): boolean {
  const tracked = spawnedDecks.get(roomCode)
  if (!tracked)
    return false
  spawnedDecks.delete(roomCode)
  killDeck(tracked)
  return true
}

/**
 * Kills every child this process started. The answer to plan 032's *"a spawned
 * child survives its parent unless explicitly killed on shutdown — wire
 * `SIGTERM`/`SIGINT` handlers in `index.ts` to kill every tracked child before
 * exiting, or a server restart leaves zombie `slidev dev` processes bound to
 * ports the new server instance then can't reuse."*
 *
 * Synchronous by design (it signals and returns; it does not wait for the
 * children to be gone) because its caller is a signal handler that is about to
 * `process.exit`. On Unix, `SIGTERM` delivery is immediate and does not depend
 * on this process still being alive to observe the result — see `index.ts` for
 * why waiting would buy nothing here.
 *
 * Returns how many children were signalled, purely so the shutdown log can say
 * something true.
 */
export function killAllSpawnedDecks(): number {
  const all = [...spawnedDecks.values(), ...unadoptedDecks]
  spawnedDecks.clear()
  unadoptedDecks.clear()
  for (const tracked of all)
    killDeck(tracked)
  return all.length
}

/**
 * `SIGTERM`, then `SIGKILL` if the child is still there after
 * `KILL_ESCALATION_MS`. Marks the deck as deliberately stopping first, so the
 * resulting `exit` event is not mistaken for a crash.
 */
function killDeck(tracked: TrackedDeck) {
  tracked.stopping = true
  tracked.onUnexpectedExit = undefined
  if (tracked.exited)
    return
  tracked.child.kill('SIGTERM')
  // Unreferenced so a pending escalation cannot hold the event loop open —
  // if the process is exiting anyway, the child is getting SIGKILLed by the
  // OS on its parent's death or has already had its SIGTERM.
  setTimeout(() => {
    if (!tracked.exited)
      tracked.child.kill('SIGKILL')
  }, KILL_ESCALATION_MS).unref()
}

/**
 * Drops every tracked child without signalling anything — test-only, mirroring
 * `resetSessionStateForTests` and `resetConnectKeyStateForTests`.
 *
 * Deliberately *not* a kill: a test's fake children are plain objects with no
 * OS process behind them, and a reset that killed real ones would make an
 * afterEach in one test file able to reach into another's state in a way the
 * other two reset helpers cannot. Tests that spawn something real are
 * responsible for stopping it.
 */
export function resetDeckLauncherStateForTests(): void {
  spawnedDecks.clear()
  unadoptedDecks.clear()
}
