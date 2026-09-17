import type { ChildProcess } from 'node:child_process'
import type { Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Socket as ClientSocket } from 'socket.io-client'
import type { SpawnDeckProcess } from './deckLauncher'
import type { MuanCompanionServer } from './server'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { join } from 'pathe'
import { io as ioClient } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  allocateEphemeralPort,
  buildSlidevArgs,
  DeckLaunchError,
  killAllSpawnedDecks,
  launchPresentation,
  MAX_CONCURRENT_SPAWNED_DECKS,
  resetDeckLauncherStateForTests,
  resolveSlidevBinary,
  SERVER_URL_ENV,
  spawnedDeckCount,
} from './deckLauncher'
import { buildHomeUpdate, createMuanCompanionServer } from './server'
import { getRoom, resetSessionStateForTests } from './session'

// Plan 032c. The three credentials, deliberately distinct strings for the same
// reason `server.test.ts` keeps them distinct: a test that reached a launch
// route with a *presenter* code must fail loudly rather than silently pass.
const TEST_ROOM_CODE = 'room-secret'
const TEST_PRESENTER_CODE = 'presenter-secret'
const TEST_ADMIN_CODE = 'admin-secret'

/**
 * A stand-in for a spawned `slidev` process.
 *
 * Every test in this file drives the *real* launcher, the *real* readiness
 * probe and the *real* registry — only the process itself is fake, injected
 * through `LaunchPresentationOptions.spawn` the same way `createSession` takes
 * an injectable `generate` and `mintConnectKey` takes an injectable `now`. That
 * is the point: a test that had to install Slidev to assert "an unknown
 * presentation id spawns nothing" would be exercising a package manager, not
 * this code.
 *
 * When `attach`ed to a real `http.Server` it genuinely listens on the port the
 * launcher allocated, so the readiness probe is satisfied by a real TCP
 * connection rather than by a stub that returns `true`. That also makes the
 * port-collision test meaningful: two launches that were handed the same port
 * would produce an `EADDRINUSE` and a failed launch, not a silently-passing
 * assertion.
 */
class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  private server: HttpServer | undefined

  attach(server: HttpServer) {
    this.server = server
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.killed)
      return true
    this.killed = true
    this.server?.close()
    // Real children exit asynchronously; emitting synchronously here would let
    // a bug that depends on ordering pass. `setImmediate` keeps the fake honest.
    setImmediate(() => this.emit('exit', null, 'SIGTERM'))
    return true
  }

  /** Simulates the child dying on its own — a crash, or someone killing it directly. */
  crash(output = 'Error: something exploded\n') {
    this.stderr.write(output)
    setImmediate(() => this.emit('exit', 1, null))
  }
}

interface SpawnCall {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * Builds an injectable spawn plus the record of what it was asked to do.
 *
 * `listen: false` produces a child that starts nothing — the "this deck never
 * came up" case the readiness timeout exists for.
 */
function createFakeSpawn(options: { listen?: boolean } = {}) {
  const calls: SpawnCall[] = []
  const children: FakeChild[] = []
  const servers: HttpServer[] = []

  const spawn: SpawnDeckProcess = (command, args, spawnOptions) => {
    calls.push({ command, args, cwd: spawnOptions.cwd, env: spawnOptions.env })
    const child = new FakeChild()
    children.push(child)
    if (options.listen !== false) {
      const port = Number(/--port=(\d+)/.exec(args.join(' '))?.[1])
      const server = createHttpServer((_req, res) => res.end('ok'))
      // A collision (two launches handed the same port) surfaces here as an
      // `error` rather than an unhandled exception, and the launch then fails
      // its readiness probe — which is exactly the failure the collision test
      // is asserting the absence of.
      server.on('error', () => {})
      server.listen(port, '127.0.0.1')
      servers.push(server)
      child.attach(server)
    }
    return child as unknown as ChildProcess
  }

  return {
    spawn,
    calls,
    children,
    closeAll() {
      for (const server of servers)
        server.close()
    },
  }
}

/** A discovery root with one real, presentable deck in it (`presentations.ts`'s rules). */
function createPresentationsDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'muan-launch-test-'))
  mkdirSync(join(root, 'intro'), { recursive: true })
  writeFileSync(
    join(root, 'intro', 'slides.md'),
    '---\ntitle: Intro to Vue\naddons:\n  - muan-companion\n---\n',
  )
  return root
}

describe('deckLauncher (plan 032c)', () => {
  let presentationsDir: string
  let spawned: ReturnType<typeof createFakeSpawn>

  beforeEach(() => {
    resetDeckLauncherStateForTests()
    presentationsDir = createPresentationsDir()
  })

  afterEach(() => {
    // Real children would be signalled here; the fakes just stop listening.
    spawned?.closeAll()
    resetDeckLauncherStateForTests()
    rmSync(presentationsDir, { recursive: true, force: true })
  })

  function launch(overrides: Partial<Parameters<typeof launchPresentation>[0]> = {}) {
    return launchPresentation({
      presentationDir: join(presentationsDir, 'intro'),
      presentationId: 'intro',
      serverUrl: 'http://companion.example:3710',
      spawn: spawned.spawn,
      readinessTimeoutMs: 2000,
      readinessPollIntervalMs: 20,
      ...overrides,
    })
  }

  describe('the spawn call itself', () => {
    it('spawns with argv entries, in the resolved deck directory, with no shell', async () => {
      spawned = createFakeSpawn()

      const deck = await launch()

      expect(spawned.calls).toHaveLength(1)
      const [call] = spawned.calls
      // The deck's own directory — the one `resolvePresentationDir` produced,
      // never a string a request supplied.
      expect(call.cwd).toBe(join(presentationsDir, 'intro'))
      // Separate argv entries: nothing here is ever parsed by a shell, and the
      // `SpawnDeckProcess` signature has no `shell` option to pass even if a
      // caller wanted one.
      expect(call.args).toEqual([`--port=${deck.port}`, '--open=false', '--log=warn'])
      // No positional `dev`: the Slidev CLI's dev server is its *default*
      // command, and a literal `dev` would be read as the `[entry]` deck file.
      expect(call.args).not.toContain('dev')
    })

    it('injects the server URL into the child env and strips this server\'s own secrets', async () => {
      spawned = createFakeSpawn()

      await launch({
        env: {
          PATH: '/usr/bin',
          SLIDEV_MUAN_COMPANION_ADMIN_CODE: 'the-admin-code',
          SLIDEV_MUAN_COMPANION_PRESENTER_CODE: 'the-presenter-code',
          VITE_SLIDEV_MUAN_COMPANION_SERVER_URL: 'http://stale-inherited-value',
        },
      })

      const { env } = spawned.calls[0]
      // The one variable the deck's addon reads — this is the whole mechanism
      // by which Flow A needs no change to `client.ts`.
      expect(env[SERVER_URL_ENV]).toBe('http://companion.example:3710')
      // Unrelated environment is passed through untouched.
      expect(env.PATH).toBe('/usr/bin')
      // This server's credentials are not the child's business.
      expect(env.SLIDEV_MUAN_COMPANION_ADMIN_CODE).toBeUndefined()
      expect(env.SLIDEV_MUAN_COMPANION_PRESENTER_CODE).toBeUndefined()
    })

    it('adds --remote= only when asked, and never a non-empty password', () => {
      expect(buildSlidevArgs(3030, false)).toEqual(['--port=3030', '--open=false', '--log=warn'])
      expect(buildSlidevArgs(3030, true)).toEqual(['--port=3030', '--open=false', '--log=warn', '--remote='])
    })
  })

  describe('port allocation', () => {
    it('gives concurrent launches distinct ports', async () => {
      // The real `allocateEphemeralPort` is used here, and each fake child
      // *actually binds* the port it was given — so two launches handed the
      // same number would collide on `listen` and fail their readiness probes
      // rather than quietly passing this assertion.
      spawned = createFakeSpawn()

      const decks = await Promise.all([launch(), launch(), launch()])

      const ports = decks.map(deck => deck.port)
      expect(new Set(ports).size).toBe(3)
      expect(ports.every(port => port > 0)).toBe(true)
    })

    it('allocates a real, free port', async () => {
      const port = await allocateEphemeralPort()
      expect(port).toBeGreaterThan(0)
      // Free by construction: binding it immediately afterwards must work.
      const server = createHttpServer()
      await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve))
      expect((server.address() as AddressInfo).port).toBe(port)
      await new Promise<void>(resolve => server.close(() => resolve()))
    })
  })

  describe('readiness', () => {
    it('fails with a timeout, not a hang, when the deck never answers', async () => {
      spawned = createFakeSpawn({ listen: false })

      const error = await launch({ readinessTimeoutMs: 120, readinessPollIntervalMs: 20 })
        .catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(DeckLaunchError)
      expect((error as DeckLaunchError).reason).toBe('timeout')
      // The child is killed on the way out, so a launch that never came up
      // does not keep consuming one of the cap's slots forever.
      expect(spawned.children[0].killed).toBe(true)
      expect(spawnedDeckCount()).toBe(0)
    })

    it('reports the deck\'s own output when it exits before serving', async () => {
      spawned = createFakeSpawn({ listen: false })

      const pending = launch({ readinessTimeoutMs: 5000, readinessPollIntervalMs: 20 })
      // Let the first probe run, then kill the deck the way a broken deck dies.
      await new Promise<void>(resolve => setTimeout(resolve, 30))
      spawned.children[0].crash('Error: Cannot find module "@slidev/theme-nonexistent"\n')

      const error = await pending.catch((caught: unknown) => caught) as DeckLaunchError

      expect(error).toBeInstanceOf(DeckLaunchError)
      // Fails fast on the exit rather than waiting out the full 5s timeout.
      expect(error.reason).toBe('exited-early')
      // Plan 032's "surfacing 'this deck failed to start' instead of a silent
      // timeout" — the operator gets the real reason.
      expect(error.message).toContain('@slidev/theme-nonexistent')
    })
  })

  describe('the concurrency cap', () => {
    it('defaults to MAX_CONCURRENT_SPAWNED_DECKS and rejects past it with a clear error', async () => {
      spawned = createFakeSpawn()

      // Adopt nothing: an in-flight/unadopted child counts against the cap too,
      // which is the property that stops N simultaneous clicks from spawning N
      // processes before any of them has a session.
      await Promise.all(
        Array.from({ length: MAX_CONCURRENT_SPAWNED_DECKS }, () => launch()),
      )
      expect(spawnedDeckCount()).toBe(MAX_CONCURRENT_SPAWNED_DECKS)

      const error = await launch().catch((caught: unknown) => caught) as DeckLaunchError

      expect(error).toBeInstanceOf(DeckLaunchError)
      expect(error.reason).toBe('at-capacity')
      // Rejected *before* anything is spawned — the cap is a resource guard, so
      // it has to run before the resource is taken.
      expect(spawned.calls).toHaveLength(MAX_CONCURRENT_SPAWNED_DECKS)
    })

    it('honors a configured override', async () => {
      spawned = createFakeSpawn()

      await launch({ maxConcurrent: 1 })

      const error = await launch({ maxConcurrent: 1 }).catch((caught: unknown) => caught) as DeckLaunchError
      expect(error.reason).toBe('at-capacity')
      expect(spawned.calls).toHaveLength(1)
    })

    it('frees a slot again once a deck is stopped', async () => {
      spawned = createFakeSpawn()

      await launch({ maxConcurrent: 1 })
      expect(spawnedDeckCount()).toBe(1)

      expect(killAllSpawnedDecks()).toBe(1)
      expect(spawnedDeckCount()).toBe(0)

      await expect(launch({ maxConcurrent: 1 })).resolves.toBeDefined()
    })
  })

  describe('resolveSlidevBinary', () => {
    it('prefers an explicit override over any resolution', () => {
      expect(resolveSlidevBinary(presentationsDir, '/opt/slidev/bin/slidev')).toBe('/opt/slidev/bin/slidev')
    })

    it('finds the deck\'s own node_modules/.bin/slidev, then an ancestor\'s', () => {
      const deckDir = join(presentationsDir, 'intro')

      // Nothing installed anywhere above a temp directory: falls back to PATH,
      // which produces a clean ENOENT from spawn rather than a mystery timeout.
      expect(resolveSlidevBinary(deckDir)).toBe('slidev')

      // A workspace-root hoisted install (this monorepo's own shape).
      mkdirSync(join(presentationsDir, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(presentationsDir, 'node_modules', '.bin', 'slidev'), '#!/bin/sh\n')
      expect(resolveSlidevBinary(deckDir)).toBe(join(presentationsDir, 'node_modules', '.bin', 'slidev'))

      // A deck-local install wins over the hoisted one — a deck pinned to an
      // older Slidev must not be started by a newer binary.
      mkdirSync(join(deckDir, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(deckDir, 'node_modules', '.bin', 'slidev'), '#!/bin/sh\n')
      expect(resolveSlidevBinary(deckDir)).toBe(join(deckDir, 'node_modules', '.bin', 'slidev'))
    })
  })
})

describe('deck launch routes (plan 032c)', () => {
  let server: MuanCompanionServer
  let url: string
  let presentationsDir: string
  let spawned: ReturnType<typeof createFakeSpawn>
  const clients: ClientSocket[] = []

  async function startServer(overrides: Parameters<typeof createMuanCompanionServer>[0] = {}) {
    server = createMuanCompanionServer({
      roomCode: TEST_ROOM_CODE,
      presenterCode: TEST_PRESENTER_CODE,
      adminCode: TEST_ADMIN_CODE,
      presentationsDir,
      publicUrl: 'http://companion.example:3710',
      ...overrides,
      deckLaunch: {
        spawn: spawned.spawn,
        readinessTimeoutMs: 2000,
        readinessPollIntervalMs: 20,
        ...overrides.deckLaunch,
      },
    })
    await new Promise<void>(resolve => server.httpServer.listen(0, resolve))
    const { port } = server.httpServer.address() as AddressInfo
    url = `http://localhost:${port}`
  }

  async function stopServer() {
    server.io.close()
    await new Promise<void>(resolve => server.httpServer.close(() => resolve()))
  }

  // `null` means "send no credential at all", not `undefined`: a default
  // parameter only fires for `undefined`, so an explicit `undefined` here would
  // silently send the *correct* admin code and turn every "this must 401" test
  // into a test of the happy path.
  function post(path: string, body: unknown, code: string | null = TEST_ADMIN_CODE) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(code === null ? {} : { 'x-muan-companion-admin-code': code }),
      },
      body: JSON.stringify(body),
    })
  }

  /**
   * A socket subscribed to the cross-room `home:update` feed, the way the
   * `/home` page itself is. Used by the crash test to prove the teardown is
   * broadcast, not merely performed.
   */
  async function connectHomeClient(): Promise<ClientSocket> {
    const socket = ioClient(url, { forceNew: true, transports: ['websocket'] })
    clients.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('connect_error', reject)
    })
    await new Promise<void>(resolve => socket.emit('home:join', { adminCode: TEST_ADMIN_CODE }, () => resolve()))
    return socket
  }

  beforeEach(async () => {
    resetSessionStateForTests()
    resetDeckLauncherStateForTests()
    presentationsDir = createPresentationsDir()
    spawned = createFakeSpawn()
    await startServer()
  })

  afterEach(async () => {
    for (const client of clients.splice(0))
      client.disconnect()
    await stopServer()
    spawned.closeAll()
    resetDeckLauncherStateForTests()
    rmSync(presentationsDir, { recursive: true, force: true })
  })

  describe('the POST /api/launch route', () => {
    it('starts the deck and returns the same shape POST /api/register does', async () => {
      const response = await post('/api/launch', { presentationId: 'intro' })

      expect(response.status).toBe(201)
      const body = await response.json() as {
        roomCode: string
        presenterCode: string
        presenterUrl: string
        participantUrl: string
      }
      expect(body.roomCode).toBeTruthy()
      expect(body.presenterCode).toBeTruthy()

      // The deck URL is this server's public origin with the *child's* port —
      // the spawned deck runs on this same host, so only the port differs.
      const { port } = spawned.calls[0].args.join(' ').match(/--port=(?<port>\d+)/)!.groups as { port: string }
      // `roomCode` in the query string alongside `code` — bug found live: a
      // presenter URL with no room hint at all silently drove this server's
      // *boot* session instead of the one just launched (see
      // `buildPresenterUrl`'s own doc comment in server.ts).
      expect(body.presenterUrl).toBe(`http://companion.example:${port}/presenter/1?code=${encodeURIComponent(body.presenterCode)}&roomCode=${encodeURIComponent(body.roomCode)}`)
      expect(body.participantUrl).toBe(`http://companion.example:${port}?roomCode=${encodeURIComponent(body.roomCode)}`)

      // A real session, created through the same `createSession` every other
      // path uses — not a special-cased second kind of thing.
      expect(getRoom(body.roomCode)).toBeDefined()
      expect(spawnedDeckCount()).toBe(1)
    })

    it('labels the created session with the presentation\'s discovered title, for the home view', async () => {
      const response = await post('/api/launch', { presentationId: 'intro' })
      const body = await response.json() as { roomCode: string }

      // "intro"'s `slides.md` frontmatter (`createPresentationsDir` above)
      // sets `title: Intro to Vue` — that's what a home-view operator sees on
      // the Presentations table's "Present" row, and it should be the same
      // string that comes back labeling the *live session* the click just
      // created, not the bare id or an empty field.
      expect(getRoom(body.roomCode)?.presentationTitle).toBe('Intro to Vue')
      const summary = buildHomeUpdate().sessions.find(s => s.roomCode === body.roomCode)
      expect(summary?.presentationTitle).toBe('Intro to Vue')
    })

    it('falls back to a valid localhost URL — and warns loudly — when SLIDEV_MUAN_COMPANION_PUBLIC_URL is set but malformed', async () => {
      // Found live: `SLIDEV_MUAN_COMPANION_PUBLIC_URL=true` (a copy-paste
      // mix-up with the unrelated `SLIDEV_MUAN_COMPANION_SPAWN_REMOTE=true`)
      // used to flow straight through into every launched deck's own
      // `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL` with no validation at all —
      // the deck's own join link and QR code still looked completely normal
      // (`deckUrlFor` already guarded those), so nothing about the launch or
      // the home view hinted anything was wrong. Every participant's browser
      // then failed to open a socket to the literal hostname `true`, with
      // nothing in this server's own logs pointing at the cause.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      await stopServer()
      await startServer({ publicUrl: 'true' })

      // Logged once, at construction — not deferred until the first launch
      // that would actually suffer for it, and not silent.
      expect(errorSpy.mock.calls.some(args => String(args[0]).includes('SLIDEV_MUAN_COMPANION_PUBLIC_URL'))).toBe(true)

      const response = await post('/api/launch', { presentationId: 'intro' })
      expect(response.status).toBe(201)

      // The literal string `true` never reaches the child's environment —
      // it gets the same `localhost` fallback an entirely-unset `publicUrl`
      // produces, not a crash and not the invalid value passed through
      // verbatim (which is what made this bug invisible until a
      // participant's own browser console was inspected).
      const { port } = new URL(url)
      expect(spawned.calls[0].env[SERVER_URL_ENV]).toBe(`http://localhost:${port}`)

      errorSpy.mockRestore()
    })

    it('404s an unknown presentation id without attempting a spawn', async () => {
      const response = await post('/api/launch', { presentationId: 'no-such-deck' })

      expect(response.status).toBe(404)
      expect(await response.json()).toEqual({ error: 'unknown presentation' })
      expect(spawned.calls).toHaveLength(0)
    })

    it('404s a traversal attempt without attempting a spawn', async () => {
      // `resolvePresentationDir` is an exact-match lookup against a freshly
      // scanned root, so none of these name anything — there is no path
      // arithmetic anywhere in this feature that could be tricked.
      for (const presentationId of ['../intro', '../../etc', '/etc/passwd', 'intro/../intro', '.']) {
        const response = await post('/api/launch', { presentationId })
        expect(response.status).toBe(404)
      }
      expect(spawned.calls).toHaveLength(0)
    })

    it('401s without the admin code, and never spawns for an unauthenticated caller', async () => {
      expect((await post('/api/launch', { presentationId: 'intro' }, null)).status).toBe(401)
      expect((await post('/api/launch', { presentationId: 'intro' }, 'wrong-code')).status).toBe(401)
      // A room's presenter code is not an admin code.
      expect((await post('/api/launch', { presentationId: 'intro' }, TEST_PRESENTER_CODE)).status).toBe(401)
      expect(spawned.calls).toHaveLength(0)
    })

    it('400s a body with no presentationId', async () => {
      expect((await post('/api/launch', {})).status).toBe(400)
      expect((await post('/api/launch', { presentationId: 42 })).status).toBe(400)
      expect(spawned.calls).toHaveLength(0)
    })

    it('503s past the concurrency cap rather than degrading silently', async () => {
      await stopServer()
      await startServer({ deckLaunch: { maxConcurrent: 1 } })

      expect((await post('/api/launch', { presentationId: 'intro' })).status).toBe(201)

      const refused = await post('/api/launch', { presentationId: 'intro' })
      expect(refused.status).toBe(503)
      const body = await refused.json() as { reason: string, error: string }
      expect(body.reason).toBe('at-capacity')
      expect(body.error).toContain('refusing to launch')
    })

    it('502s a deck that never comes up, carrying its output', async () => {
      await stopServer()
      spawned = createFakeSpawn({ listen: false })
      await startServer({ deckLaunch: { readinessTimeoutMs: 120, readinessPollIntervalMs: 20 } })

      const response = await post('/api/launch', { presentationId: 'intro' })

      expect(response.status).toBe(502)
      const body = await response.json() as { reason: string }
      expect(body.reason).toBe('timeout')
      // Nothing left behind: the failed launch's child was killed and its slot
      // released.
      expect(spawnedDeckCount()).toBe(0)
    })

    it('404s every id when discovery is not configured at all', async () => {
      await stopServer()
      await startServer({ presentationsDir: undefined })

      const response = await post('/api/launch', { presentationId: 'intro' })

      expect(response.status).toBe(404)
      expect(spawned.calls).toHaveLength(0)
    })
  })

  describe('a spawned deck crashing', () => {
    it('tears down its session and tells the home view', async () => {
      // A subscribed home view, so this asserts the *broadcast* and not just
      // the map deletion — a session that vanished from `rooms` while every
      // open `/home` kept showing its row would be a worse bug than leaving
      // it alone.
      const home = await connectHomeClient()

      const launched = await (await post('/api/launch', { presentationId: 'intro' })).json() as { roomCode: string }
      expect(getRoom(launched.roomCode)).toBeDefined()

      const update = new Promise<{ sessions: { roomCode: string }[] }>((resolve) => {
        home.on('home:update', (payload: { sessions: { roomCode: string }[] }) => {
          if (!payload.sessions.some(session => session.roomCode === launched.roomCode))
            resolve(payload)
        })
      })

      spawned.children[0].crash()

      // Plan 032: "don't leave a Session pointing at a dead process."
      expect((await update).sessions.map(session => session.roomCode)).toEqual([TEST_ROOM_CODE])
      expect(getRoom(launched.roomCode)).toBeUndefined()
      // And the registry entry is gone too, so the slot is reusable.
      expect(spawnedDeckCount()).toBe(0)
    })

    it('does not fire the crash teardown for a deliberate stop', async () => {
      const launched = await (await post('/api/launch', { presentationId: 'intro' })).json() as { roomCode: string }

      const stopped = await post('/api/stop', { roomCode: launched.roomCode })
      expect(stopped.status).toBe(200)

      // The kill produces an `exit` event a moment later; it must not be
      // mistaken for a crash and re-destroy a room code that could by then
      // belong to something else.
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      expect(getRoom(launched.roomCode)).toBeUndefined()
      expect(spawnedDeckCount()).toBe(0)
    })
  })

  describe('the POST /api/stop route', () => {
    it('kills the spawned process and destroys the session', async () => {
      const launched = await (await post('/api/launch', { presentationId: 'intro' })).json() as { roomCode: string }

      const response = await post('/api/stop', { roomCode: launched.roomCode })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ stopped: true, hadProcess: true })
      expect(spawned.children[0].killed).toBe(true)
      expect(getRoom(launched.roomCode)).toBeUndefined()
    })

    it('destroys an externally-registered (Flow B) session with no process to kill', async () => {
      // A session this server did not start — exactly what `POST /api/register`
      // creates. There is no child of ours behind it, and the operator's own
      // `slidev dev` is emphatically not this server's to terminate.
      const external = server.createSession({ deckUrl: 'http://someones-laptop:3030' })

      const response = await post('/api/stop', { roomCode: external.roomCode })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ stopped: true, hadProcess: false })
      expect(getRoom(external.roomCode)).toBeUndefined()
      // No child was touched — the one live spawned deck is unaffected.
      expect(spawned.calls).toHaveLength(0)
    })

    it('404s an unknown room code, and 401s without the admin code', async () => {
      expect((await post('/api/stop', { roomCode: 'no-such-room' })).status).toBe(404)
      expect((await post('/api/stop', { roomCode: TEST_ROOM_CODE }, null)).status).toBe(401)
      expect((await post('/api/stop', { roomCode: TEST_ROOM_CODE }, TEST_PRESENTER_CODE)).status).toBe(401)
      // The boot session survived both rejected attempts.
      expect(getRoom(TEST_ROOM_CODE)).toBeDefined()
    })

    it('400s a body with no roomCode', async () => {
      expect((await post('/api/stop', {})).status).toBe(400)
    })

    it('accepts the admin code as ?code= too, for a plain curl', async () => {
      const response = await fetch(`${url}/api/stop?code=${TEST_ADMIN_CODE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roomCode: TEST_ROOM_CODE }),
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ stopped: true, hadProcess: false })
    })
  })

  describe('killAllSpawnedDecks (the SIGTERM/SIGINT path)', () => {
    it('signals every tracked child, adopted or still in flight', async () => {
      await post('/api/launch', { presentationId: 'intro' })
      await post('/api/launch', { presentationId: 'intro' })

      expect(killAllSpawnedDecks()).toBe(2)

      expect(spawned.children.every(child => child.killed)).toBe(true)
      expect(spawnedDeckCount()).toBe(0)
    })
  })
})
