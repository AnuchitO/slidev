import type { AddressInfo } from 'node:net'
import type { Socket as ClientSocket } from 'socket.io-client'
import type { DashboardJoinAck, MuanCompanionServer } from './server'
import type { RoomState } from './session'
import { Buffer } from 'node:buffer'
import { rmSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { io as ioClient } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECT_KEY_TTL_MS, MAX_FAILED_ATTEMPTS, resetConnectKeyStateForTests } from './connectKey'
import { buildHomeUpdate, buildJoinUrl, buildPresenterUrl, createMuanCompanionServer, DEFAULT_DECK_URL, HOME_DASHBOARD_ROOM } from './server'
import { getRoom, MAX_TEXT_LENGTH, removeParticipant, resetSessionStateForTests } from './session'

// `DashboardJoinAck` (M4's two codes, plus the join-link/QR fields added for
// the shareable-join-link feature) is imported from `server.ts` itself now
// rather than re-declared here — this file used to keep an independent copy
// of the exact same shape purely for its own assertions, which could
// quietly drift from the real ack payload without either side noticing.

// A minimal, valid 1x1 PNG (the smallest real PNG that decodes) — used as
// the multipart `screenshot` file in the upload tests below so they exercise
// real bytes through Busboy's file stream rather than an empty/fake blob.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

// Plan 029 (M4): every test below that exercises `participant:join`,
// `presenter:*`, or `dashboard:join` now has to supply the matching code —
// these are deliberately different strings (see `auth.ts`'s own comment on
// why room code and presenter code must never be conflated into one shared
// secret) so a test that accidentally used the wrong one for a surface would
// fail loudly rather than silently pass.
const TEST_ROOM_CODE = 'room-secret'
const TEST_PRESENTER_CODE = 'presenter-secret'

describe('createMuanCompanionServer', () => {
  let server: MuanCompanionServer
  let url: string
  // Plan 032a: the state these tests assert against used to be module-level
  // singletons in `session.ts` (`participants`, `stepStatus`, `errorReports`,
  // `session`). It's now owned by a `RoomState`, so each test reads it off
  // the server's own boot session — the room every client below implicitly
  // lands in, since none of them passes a room hint. What each assertion
  // pins down is unchanged; it just has an address now. The dedicated
  // "multi-room isolation" block at the bottom of this file is where more
  // than one room is actually in play.
  let room: RoomState
  const clients: ClientSocket[] = []

  // Creates a client socket (connecting immediately) without waiting for
  // `connect` first — the server emits `slide:sync` synchronously on
  // connection, so any listener registered only *after* awaiting `connect`
  // can race and miss it. Registering listeners right after socket creation
  // (before the network round-trip completes) mirrors how the real addon's
  // `setup/main.ts` attaches its listeners immediately after creating the
  // socket, well before `connect` can fire.
  function newClient(): ClientSocket {
    // `transports: ['websocket']` skips engine.io's default HTTP
    // long-polling-then-upgrade handshake — with many real sockets opened
    // and torn down across this suite in quick succession, that upgrade
    // dance was an observed (if intermittent) source of multi-second stalls
    // in this sandboxed environment (a handshake that never completes,
    // starving a later `waitFor`/`waitForMatchingStateUpdate`). Connecting
    // over websocket from the start removes that step entirely.
    const socket = ioClient(url, { forceNew: true, transports: ['websocket'] })
    clients.push(socket)
    return socket
  }

  function waitFor<T>(socket: ClientSocket, event: string): Promise<T> {
    return new Promise(resolve => socket.once(event, resolve))
  }

  // Unlike `waitFor` (a one-shot `.once()`), this keeps listening until a
  // `state:update` matching `predicate` arrives. Needed because several
  // server-side actions broadcast `state:update` (join, copy, done,
  // presenter:setSlide, disconnect) — a plain `.once()` registered after an
  // earlier action can race against that action's *own* broadcast and
  // consume it instead of the one the test actually cares about.
  function waitForMatchingStateUpdate<T>(socket: ClientSocket, predicate: (payload: T) => boolean): Promise<T> {
    return new Promise((resolve) => {
      function handler(payload: T) {
        if (predicate(payload)) {
          socket.off('state:update', handler)
          resolve(payload)
        }
      }
      socket.on('state:update', handler)
    })
  }

  function connectClient(): Promise<ClientSocket> {
    const socket = newClient()
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket))
      socket.once('connect_error', reject)
    })
  }

  // Wraps a Socket.io ack-callback emit in a Promise. Used for the M2
  // events (`participant:join`/`copy`/`done`) whose honest pending/confirmed
  // client-side state (plan 027 Step 2) depends on a real ack round-trip,
  // not an optimistic local flip — so the server contract needs a test that
  // actually exercises the ack, not just the side-effecting broadcast.
  function emitWithAck<T = unknown>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
    return new Promise(resolve => socket.emit(event, payload, resolve))
  }

  // Plan 029: every real join in this suite goes through the correct room
  // code by default — tests that specifically exercise the *rejection* path
  // pass a wrong/missing code explicitly instead of calling this helper.
  async function join(client: ClientSocket, name = 'Ada') {
    return emitWithAck<{ participantId: string, currentSlideIndex: number } | { error: string }>(
      client,
      'participant:join',
      { name, roomCode: TEST_ROOM_CODE },
    )
  }

  async function joinAsDashboard(client: ClientSocket) {
    return emitWithAck<{ ok: boolean }>(client, 'dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
  }

  // Stands up a server and points `url`/`room` at it. Extracted (plan 032a)
  // because several tests below replace the shared server mid-test to
  // exercise a non-default `options` value, and each of them now also has to
  // re-resolve the boot room — `room` would otherwise still point at the
  // *closed* server's session, which `createMuanCompanionServer`'s own
  // `close` handler has already dropped from `rooms`.
  async function startServer(options: Parameters<typeof createMuanCompanionServer>[0] = {}) {
    server = createMuanCompanionServer(options)
    room = server.bootSession.room
    await new Promise<void>(resolve => server.httpServer.listen(0, resolve))
    const { port } = server.httpServer.address() as AddressInfo
    url = `http://localhost:${port}`
  }

  // Closes the shared server. Its boot session is destroyed as part of that
  // (see `createMuanCompanionServer`'s `close` handler), which is what lets
  // a replacement server be created under the same room code without
  // tripping `createSession`'s duplicate-room-code guard.
  async function stopServer() {
    server.io.close()
    await new Promise<void>(resolve => server.httpServer.close(() => resolve()))
  }

  beforeEach(async () => {
    resetSessionStateForTests()
    await startServer({ roomCode: TEST_ROOM_CODE, presenterCode: TEST_PRESENTER_CODE })
  })

  afterEach(async () => {
    for (const client of clients.splice(0))
      client.disconnect()
    await stopServer()
  })

  it('sends the current slide index to a newly-connected client via slide:sync', async () => {
    room.session.currentSlideIndex = 3
    const client = newClient()

    const payload = await waitFor<{ index: number }>(client, 'slide:sync')

    expect(payload).toEqual({ index: 3 })
  })

  it('rebroadcasts presenter:setSlide as slide:changed to all other connected clients', async () => {
    const presenter = await connectClient()
    const participant = await connectClient()

    const changed = waitFor<{ index: number }>(participant, 'slide:changed')

    presenter.emit('presenter:setSlide', { index: 2, presenterCode: TEST_PRESENTER_CODE })

    await expect(changed).resolves.toEqual({ index: 2 })
  })

  it('updates the in-memory session so late joiners land on the current slide', async () => {
    const presenter = await connectClient()
    presenter.emit('presenter:setSlide', { index: 5, presenterCode: TEST_PRESENTER_CODE })

    // Give the server a tick to process the event and mutate session state.
    await new Promise<void>(resolve => setTimeout(resolve, 50))

    const lateJoiner = newClient()
    const payload = await waitFor<{ index: number }>(lateJoiner, 'slide:sync')

    expect(payload).toEqual({ index: 5 })
  })

  describe('auth (M4)', () => {
    it('rejects participant:join with a wrong room code and does not create a participant', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ error: string } | { participantId: string }>(
        client,
        'participant:join',
        { name: 'Eve', roomCode: 'wrong-code' },
      )

      expect(ack).toEqual({ error: 'invalid_room_code' })
      expect(room.participants.size).toBe(0)
    })

    it('rejects participant:join with a missing room code and does not create a participant', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ error: string } | { participantId: string }>(
        client,
        'participant:join',
        { name: 'Eve' },
      )

      expect(ack).toEqual({ error: 'invalid_room_code' })
      expect(room.participants.size).toBe(0)
    })

    // Follow-up fix: a resume of an already-known identity no longer needs
    // the room code at all — the unguessable `participantId` is itself the
    // resume credential (see `server.ts`'s comment on this exemption). This
    // is what lets the addon stop persisting the room code in `localStorage`
    // just to auto-resume silently.
    describe('resuming a known identity is exempt from the room-code gate', () => {
      it('resumes successfully with no roomCode at all, given a participantId the server already knows', async () => {
        const original = await connectClient()
        const { participantId } = await emitWithAck<{ participantId: string }>(
          original,
          'participant:join',
          { name: 'Ada', roomCode: TEST_ROOM_CODE },
        )

        const resumer = await connectClient()
        const ack = await emitWithAck<{ participantId: string, resumed: boolean } | { error: string }>(
          resumer,
          'participant:join',
          { name: 'Ada', participantId },
        )

        expect(ack).toEqual({ participantId, currentSlideIndex: 1, resumed: true })
        expect(room.participants.size).toBe(1)
      })

      it('resumes successfully even with a wrong roomCode, given a participantId the server already knows', async () => {
        // Deliberately proves the room code is *ignored*, not just optional,
        // for a known resume — locks in that it provides no protection here
        // one way or the other, so nobody re-adds a check against it later
        // expecting it to matter.
        const original = await connectClient()
        const { participantId } = await emitWithAck<{ participantId: string }>(
          original,
          'participant:join',
          { name: 'Ada', roomCode: TEST_ROOM_CODE },
        )

        const resumer = await connectClient()
        const ack = await emitWithAck<{ participantId: string, resumed: boolean } | { error: string }>(
          resumer,
          'participant:join',
          { name: 'Ada', participantId, roomCode: 'definitely-not-the-real-code' },
        )

        expect(ack).toEqual({ participantId, currentSlideIndex: 1, resumed: true })
      })

      it('still requires a valid roomCode when the supplied participantId is unknown to the server (no free pass for a guessed id)', async () => {
        const client = await connectClient()

        const ack = await emitWithAck<{ error: string } | { participantId: string }>(
          client,
          'participant:join',
          { name: 'Eve', participantId: 'guessed-or-stale-id' },
        )

        expect(ack).toEqual({ error: 'invalid_room_code' })
        // Crucially, no participant was minted for the guessed id either —
        // the room-code gate runs *before* `joinParticipant`, so an unknown
        // id with no valid room code never reaches it at all (no orphaned
        // fallback participant to clean up, unlike the pre-fix flow). An
        // ordinary fresh join with no participantId at all is already
        // covered by the two tests just above this describe block.
        expect(room.participants.size).toBe(0)
      })
    })

    it('ignores presenter:setSlide with a wrong presenter code — no broadcast, no session mutation', async () => {
      const attacker = await connectClient()
      const bystander = await connectClient()

      let bystanderSawSlideChange = false
      bystander.on('slide:changed', () => {
        bystanderSawSlideChange = true
      })

      attacker.emit('presenter:setSlide', { index: 99, presenterCode: 'wrong-code' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(bystanderSawSlideChange).toBe(false)
      expect(room.session.currentSlideIndex).not.toBe(99)
    })

    it('ignores presenter:setSlide with a missing presenter code (a valid room code alone is not enough)', async () => {
      // Exercises the exact threat the plan calls out: a participant who
      // knows the room code (and could in principle attach it here too)
      // still must not be able to move the slide without the *separate*
      // presenter credential.
      const participant = await connectClient()
      await join(participant, 'Ada')

      participant.emit('presenter:setSlide', { index: 42 })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.session.currentSlideIndex).not.toBe(42)
    })

    it('ignores presenter:setStep with a wrong presenter code — currentStepId is untouched', async () => {
      const attacker = await connectClient()

      attacker.emit('presenter:setStep', { stepId: 'attacker-step', presenterCode: 'wrong-code' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.session.currentStepId).not.toBe('attacker-step')
    })

    it('dashboard:join with a wrong presenter code does not join the dashboard room or receive state:update', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ ok: boolean }>(client, 'dashboard:join', { presenterCode: 'wrong-code' })
      expect(ack).toEqual({ ok: false })

      let receivedStateUpdate = false
      client.on('state:update', () => {
        receivedStateUpdate = true
      })

      // Trigger a broadcast-worthy event from a second, legitimately-joined
      // socket, then confirm the rejected dashboard socket still never
      // receives state:update (it never actually joined the room).
      const other = await connectClient()
      await join(other, 'Bob')
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(receivedStateUpdate).toBe(false)
    })

    it('dashboard:join with the correct presenter code joins the room and acks ok', async () => {
      const dashboard = await connectClient()

      const ack = await joinAsDashboard(dashboard)

      expect(ack.ok).toBe(true)
    })

    // Follow-up after initial manual testing ("how does the presenter find
    // the codes"): the ack hands both codes back once the caller has
    // already proven it holds the presenter code — safe, since anyone who
    // could reach this point could already open the dashboard directly.
    it('dashboard:join ack includes both codes for the dashboard page to display', async () => {
      const dashboard = await connectClient()

      const ack = await emitWithAck<DashboardJoinAck>(
        dashboard,
        'dashboard:join',
        { presenterCode: TEST_PRESENTER_CODE },
      )

      expect(ack).toMatchObject({ ok: true, roomCode: TEST_ROOM_CODE, presenterCode: TEST_PRESENTER_CODE })
    })

    it('a rejected dashboard:join does not leak either code', async () => {
      const dashboard = await connectClient()

      const ack = await emitWithAck<DashboardJoinAck>(
        dashboard,
        'dashboard:join',
        { presenterCode: 'wrong-code' },
      )

      expect(ack).toEqual({ ok: false })
      expect(ack.roomCode).toBeUndefined()
      expect(ack.presenterCode).toBeUndefined()
    })

    it('a participant with a valid room code but no presenter code cannot open the dashboard', async () => {
      const participant = await connectClient()
      await join(participant, 'Ada')

      const ack = await emitWithAck<{ ok: boolean }>(participant, 'dashboard:join', {})
      expect(ack).toEqual({ ok: false })
    })

    // The "shareable join link + QR code" feature: `dashboard:join`'s ack
    // carries `deckUrl`/`joinUrl`/`joinQrDataUrl` alongside the two codes
    // above, computed by `buildJoinUrl`/`getJoinQrDataUrl` (`server.ts`).
    // This describe block's own `beforeEach` stands up a *second* server
    // (mirroring the pattern the `cors`/staleness-sweep tests above already
    // use for a non-default `options` value) so both the "configured" and
    // "unconfigured" cases below get a real server instance rather than one
    // test having to mutate global state mid-run.
    describe('join link + QR code (dashboard:join)', () => {
      it('includes a well-formed joinUrl and a non-empty joinQrDataUrl when a room code is configured', async () => {
        const dashboard = await connectClient()

        const ack = await emitWithAck<DashboardJoinAck>(
          dashboard,
          'dashboard:join',
          { presenterCode: TEST_PRESENTER_CODE },
        )

        expect(ack.ok).toBe(true)
        expect(ack.deckUrl).toBe(DEFAULT_DECK_URL)
        expect(ack.joinUrl).toBe(`${DEFAULT_DECK_URL}?roomCode=${encodeURIComponent(TEST_ROOM_CODE)}`)
        // A real, decodable data URL, not just a non-empty string — a
        // truncated/corrupt encode would still be "non-empty" but wouldn't
        // start with the correct MIME prefix or carry a plausible amount of
        // base64 payload after it.
        expect(ack.joinQrDataUrl).toMatch(/^data:image\/png;base64,/)
        expect(ack.joinQrDataUrl!.length).toBeGreaterThan(100)
      })

      // `getJoinQrDataUrl` (`server.ts`) caches the *promise* from the first
      // encode and reuses it for every later call, rather than re-encoding
      // identical PNG bytes for every dashboard tab that opens against the
      // same server instance — see that function's own doc comment for why
      // it's the promise, not just the resolved string, that's cached (safe
      // against two `dashboard:join` calls racing before the first encode
      // finishes). A second dashboard socket joining the same running server
      // is what actually exercises that reuse path rather than always
      // taking the "generate fresh" branch.
      it('a second dashboard:join on the same server reuses the same cached QR code', async () => {
        const first = await connectClient()
        const firstAck = await emitWithAck<DashboardJoinAck>(first, 'dashboard:join', { presenterCode: TEST_PRESENTER_CODE })

        const second = await connectClient()
        const secondAck = await emitWithAck<DashboardJoinAck>(second, 'dashboard:join', { presenterCode: TEST_PRESENTER_CODE })

        expect(secondAck.joinQrDataUrl).toMatch(/^data:image\/png;base64,/)
        expect(secondAck.joinQrDataUrl).toBe(firstAck.joinQrDataUrl)
      })

      // Adapted for plan 032a (this test previously asserted the exact
      // opposite, and deliberately so — the change is explained here rather
      // than silently rewritten). Before 032a, `createMuanCompanionServer`
      // turned an unset `roomCode` into `''` and the server sat in a "no
      // code is configured, nothing works, nothing to share" state, which is
      // what this test pinned down. 032a routes the boot session through
      // `createSession`, to which an absent code means "generate one" —
      // 031a's already-shipped posture, previously implemented only in
      // `index.ts` for the one session it booted, now applied wherever a
      // session is created. So there is no longer a reachable "server with
      // no room code" state to assert against: a session always has a real,
      // unguessable code, and therefore always has a real join link.
      //
      // Nothing about the fail-closed *auth* behavior changed: `auth.ts` is
      // untouched, and `buildJoinUrl`/`isValidCode`'s handling of an empty
      // configured code is still covered — by `session.test.ts`'s "allows an
      // explicit empty room code, which stays permanently unreachable" case
      // (the state layer, where an empty code is still honored verbatim for
      // a caller that asks for one) and by `auth.test.ts` (the gate itself).
      it('a server constructed with no room code gets a generated one, and still produces a real join link', async () => {
        // A separate server instance with no `roomCode` at all — mirrors how
        // the `cors`/staleness-sweep tests below construct a server with
        // different `options` rather than mutating the shared one.
        await stopServer()
        await startServer({ presenterCode: TEST_PRESENTER_CODE })

        const generatedRoomCode = server.bootSession.roomCode
        expect(generatedRoomCode).toBeTruthy()
        expect(generatedRoomCode).not.toBe(TEST_ROOM_CODE)

        const dashboard = await connectClient()
        const ack = await emitWithAck<DashboardJoinAck>(
          dashboard,
          'dashboard:join',
          { presenterCode: TEST_PRESENTER_CODE },
        )

        expect(ack.ok).toBe(true)
        expect(ack.roomCode).toBe(generatedRoomCode)
        // `deckUrl` is independent, static server config (see its own doc
        // comment), so it's unaffected either way.
        expect(ack.deckUrl).toBe(DEFAULT_DECK_URL)
        expect(ack.joinUrl).toBe(`${DEFAULT_DECK_URL}?roomCode=${encodeURIComponent(generatedRoomCode)}`)
        expect(ack.joinQrDataUrl).toMatch(/^data:image\/png;base64,/)
      })
    })
  })

  // `requireDashboardCode` (`server.ts`) gates the HTTP GET for `/dashboard`
  // itself, separately from (and *before*) the `dashboard:join` socket gate
  // exercised above — a plain `fetch()` never reaches Socket.io at all, so
  // this needs its own HTTP-level coverage.
  describe('dashboard HTTP route (auth)', () => {
    it('a GET /dashboard with no ?code= is rejected with 401, not served', async () => {
      const response = await fetch(`${url}/dashboard`)

      expect(response.status).toBe(401)
      const body = await response.text()
      expect(body).toContain('Presenter code required')
    })

    it('a GET /dashboard with the wrong ?code= is rejected with 401', async () => {
      const response = await fetch(`${url}/dashboard?code=wrong-code`)

      expect(response.status).toBe(401)
    })

    it('a GET /dashboard with the correct ?code= is served', async () => {
      const response = await fetch(`${url}/dashboard?code=${TEST_PRESENTER_CODE}`)

      expect(response.status).toBe(200)
      const body = await response.text()
      expect(body).toContain('<title>')
    })
  })

  // Second-pass security hardening: `X-Content-Type-Options`/
  // `X-Frame-Options` are applied to every response this process serves,
  // and `/dashboard` additionally gets a `Content-Security-Policy` scoped to
  // exactly what its own inline script/style + same-origin Socket.io client
  // + QR code `data:` image need (`dashboardContentSecurityPolicy` in
  // `server.ts`) — asserted here as a contract, not just eyeballed once via
  // curl, so a future change to this middleware chain that accidentally
  // drops a header fails a test instead of only showing up in a browser's
  // devtools during a real workshop.
  describe('http security headers', () => {
    it('every response carries X-Content-Type-Options and X-Frame-Options', async () => {
      const dashboardResponse = await fetch(`${url}/dashboard?code=${TEST_PRESENTER_CODE}`)
      expect(dashboardResponse.headers.get('x-content-type-options')).toBe('nosniff')
      expect(dashboardResponse.headers.get('x-frame-options')).toBe('DENY')

      // Also present on a 401 (rejected before reaching sirv) and on an
      // unrelated route — this is applied once, globally, not re-derived
      // per route.
      const unauthorizedResponse = await fetch(`${url}/dashboard`)
      expect(unauthorizedResponse.headers.get('x-content-type-options')).toBe('nosniff')

      const optionsResponse = await fetch(`${url}/api/screenshot`, { method: 'OPTIONS' })
      expect(optionsResponse.headers.get('x-content-type-options')).toBe('nosniff')
      expect(optionsResponse.headers.get('x-frame-options')).toBe('DENY')
    })

    it('/dashboard carries a Content-Security-Policy permitting only same-origin script/style/img/connect', async () => {
      const response = await fetch(`${url}/dashboard?code=${TEST_PRESENTER_CODE}`)

      const csp = response.headers.get('content-security-policy')
      expect(csp).toBeTruthy()
      expect(csp).toContain('default-src \'self\'')
      // Inline <script>/<style> (this page has no build step — see the
      // package README) still needs to run, so 'unsafe-inline' is present —
      // but nothing external is permitted for either.
      expect(csp).toContain('script-src \'self\' \'unsafe-inline\'')
      expect(csp).toContain('style-src \'self\' \'unsafe-inline\'')
      // `data:` is required for the QR code <img> (dashboard:join's
      // joinQrDataUrl); 'self' covers screenshot thumbnails from /uploads.
      expect(csp).toContain('img-src \'self\' data:')
      expect(csp).toContain('frame-ancestors \'none\'')
    })

    it('the CSP is present even on a rejected (401) /dashboard request', async () => {
      const response = await fetch(`${url}/dashboard`)

      expect(response.status).toBe(401)
      expect(response.headers.get('content-security-policy')).toContain('frame-ancestors \'none\'')
    })

    it('a route other than /dashboard does not carry the dashboard-scoped CSP', async () => {
      const response = await fetch(`${url}/api/screenshot`, { method: 'OPTIONS' })

      expect(response.headers.get('content-security-policy')).toBeNull()
    })
  })

  describe('participant registry (M2)', () => {
    it('assigns a stable id on participant:join and acks the current slide index', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ participantId: string, currentSlideIndex: number }>(
        client,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      expect(ack.participantId).toBeTruthy()
      expect(ack.currentSlideIndex).toBe(1)
      expect(room.participants.size).toBe(1)
      expect(room.participants.get(ack.participantId)?.name).toBe('Ada')
    })

    it('reconnecting with the same stored participant id does not create a duplicate participant', async () => {
      const first = await connectClient()
      const firstAck = await emitWithAck<{ participantId: string }>(
        first,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const second = await connectClient()
      const secondAck = await emitWithAck<{ participantId: string, resumed: boolean }>(
        second,
        'participant:join',
        { name: 'Ada', participantId: firstAck.participantId, roomCode: TEST_ROOM_CODE },
      )

      expect(secondAck.participantId).toBe(firstAck.participantId)
      expect(secondAck.resumed).toBe(true)
      expect(room.participants.size).toBe(1)
    })

    it('mints a fresh id when a client-supplied participantId is unknown to the server, with resumed: false (plan 030)', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ participantId: string, resumed: boolean }>(
        client,
        'participant:join',
        { name: 'Ada', participantId: 'guessed-id-from-a-different-server-run', roomCode: TEST_ROOM_CODE },
      )

      expect(ack.participantId).not.toBe('guessed-id-from-a-different-server-run')
      expect(ack.resumed).toBe(false)
      expect(room.participants.size).toBe(1)
    })

    it('a resumed rejoin keeps the original name even if a different one is supplied (plan 030 STOP condition)', async () => {
      const first = await connectClient()
      const firstAck = await emitWithAck<{ participantId: string }>(
        first,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const second = await connectClient()
      await emitWithAck<{ participantId: string, resumed: boolean }>(
        second,
        'participant:join',
        { name: 'Someone Else Entirely', participantId: firstAck.participantId, roomCode: TEST_ROOM_CODE },
      )

      expect(room.participants.get(firstAck.participantId)?.name).toBe('Ada')
    })

    it('logs a resume distinctly from a fresh join and from a failed resume (plan 030 operator-visibility requirement)', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const first = await connectClient()
      const firstAck = await emitWithAck<{ participantId: string }>(first, 'participant:join', { name: 'Ada', roomCode: TEST_ROOM_CODE })
      expect(logSpy.mock.calls.some(args => String(args[0]).includes('participant joined'))).toBe(true)

      const second = await connectClient()
      await emitWithAck(second, 'participant:join', { name: 'Ada', participantId: firstAck.participantId, roomCode: TEST_ROOM_CODE })
      expect(logSpy.mock.calls.some(args => String(args[0]).includes('participant resumed'))).toBe(true)

      const third = await connectClient()
      await emitWithAck(third, 'participant:join', { name: 'Ada', participantId: 'unknown-id', roomCode: TEST_ROOM_CODE })
      expect(warnSpy.mock.calls.some(args => String(args[0]).includes('resume failed'))).toBe(true)

      logSpy.mockRestore()
      warnSpy.mockRestore()
    })
  })

  describe('step status (M2)', () => {
    it('participant:copy marks the step copied and acks the caller', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      const ack = await emitWithAck<{ stepId: string, state: string }>(
        client,
        'participant:copy',
        { stepId: 'install-deps' },
      )

      expect(ack).toEqual({ stepId: 'install-deps', state: 'copied' })
      expect(room.stepStatus.get(`${participantId}:install-deps`)).toEqual({ state: 'copied', updatedAt: expect.any(Number) })
    })

    it('participant:done marks the step done and acks the caller', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      const ack = await emitWithAck<{ stepId: string, state: string }>(
        client,
        'participant:done',
        { stepId: 'install-deps' },
      )

      expect(ack).toEqual({ stepId: 'install-deps', state: 'done' })
      expect(room.stepStatus.get(`${participantId}:install-deps`)).toEqual({ state: 'done', updatedAt: expect.any(Number) })
    })

    it('updatedAt refreshes on each state transition (copy, then done, are two different timestamps)', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      await emitWithAck(client, 'participant:copy', { stepId: 'install-deps' })
      const afterCopy = room.stepStatus.get(`${participantId}:install-deps`)!.updatedAt

      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await emitWithAck(client, 'participant:done', { stepId: 'install-deps' })
      const afterDone = room.stepStatus.get(`${participantId}:install-deps`)!.updatedAt

      expect(afterDone).toBeGreaterThan(afterCopy)
    })

    it('ignores participant:copy/done from a socket that has not joined yet', async () => {
      const client = await connectClient()

      client.emit('participant:copy', { stepId: 'install-deps' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.stepStatus.size).toBe(0)
    })
  })

  describe('presence (M4)', () => {
    it('participant:visibility updates the participant\'s visibility and broadcasts to the dashboard', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const participant = await connectClient()
      const { participantId } = await join(participant) as { participantId: string }
      await waitForMatchingStateUpdate<{ participants: Array<{ id: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId),
      )

      const update = waitForMatchingStateUpdate<{ participants: Array<{ id: string, visibility: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId && x.visibility === 'hidden'),
      )
      participant.emit('participant:visibility', { state: 'hidden' })
      const payload = await update

      expect(payload.participants.find(p => p.id === participantId)?.visibility).toBe('hidden')
    })

    it('ignores a client-reported visibility state of "closed" (only visible/hidden are trusted from the client)', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      client.emit('participant:visibility', { state: 'closed' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.participants.get(participantId)?.visibility).toBe('visible')
    })

    // Same kick-race reasoning as `participant:error`'s equivalent guard
    // (`error reports (M3)` describe block above): `socket.data.participantId`
    // can still point at a record that's already been deleted.
    it('participant:visibility from a socket whose participant record was removed mid-flight is a no-op', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }
      removeParticipant(room, participantId)

      expect(() => client.emit('participant:visibility', { state: 'hidden' })).not.toThrow()
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.participants.has(participantId)).toBe(false)
    })

    it('participant:heartbeat updates lastSeen without erroring for a joined participant', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }
      const before = room.participants.get(participantId)!.lastSeen

      await new Promise<void>(resolve => setTimeout(resolve, 10))
      client.emit('participant:heartbeat', { stepId: 'install-deps' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.participants.get(participantId)!.lastSeen).toBeGreaterThan(before)
    })

    it('participant:heartbeat from a socket that has not joined yet is a harmless no-op', async () => {
      const client = await connectClient()

      // No `participant:join` at all — `socket.data.participantId` is
      // undefined, so `touchLastSeen` (server.ts) hits its own early-return
      // rather than looking anything up.
      expect(() => client.emit('participant:heartbeat', { stepId: 'install-deps' })).not.toThrow()
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.participants.size).toBe(0)
    })

    it('a clean disconnect immediately marks the participant closed and broadcasts state:update', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const participant = await connectClient()
      const { participantId } = await join(participant) as { participantId: string }
      await waitForMatchingStateUpdate<{ participants: Array<{ id: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId),
      )

      const closedUpdate = waitForMatchingStateUpdate<{ participants: Array<{ id: string, connected: boolean, visibility: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId && !x.connected),
      )
      participant.disconnect()
      const payload = await closedUpdate

      const row = payload.participants.find(p => p.id === participantId)
      expect(row?.connected).toBe(false)
      expect(row?.visibility).toBe('closed')
    })

    // Follow-up bug found in live use: `JoinScreen.vue`'s "Not you? Join as
    // someone else" used to only clear the client's own local state, never
    // telling the server this socket was done with the old identity —
    // leaving a permanent ghost row on the dashboard (still `connected`)
    // since nothing ever ran `removeParticipantSocket` for it. The fix is
    // client-side (force a real disconnect + reconnect of the shared socket
    // before joining fresh — see that component's own comment), but the
    // server-side behavior it now relies on is exactly this: a socket that
    // disconnects and reconnects, then joins as a *different* identity, must
    // leave the old identity properly closed rather than still pointing at
    // the (now differently-used) live socket.
    it('disconnecting and rejoining fresh on the same underlying socket closes the old identity, not a ghost row', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const client = await connectClient()
      const { participantId: oldId } = await join(client, 'Ada') as { participantId: string }
      await waitForMatchingStateUpdate<{ participants: Array<{ id: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === oldId),
      )

      // Mirrors `joinAsSomeoneElse()`: disconnect, reconnect the same client
      // object (a new underlying socket id from the server's point of view),
      // then join as a brand-new identity with no `participantId` — exactly
      // what a participant typing a fresh name after clicking "Not you?"
      // produces.
      const oldClosed = waitForMatchingStateUpdate<{ participants: Array<{ id: string, connected: boolean }> }>(
        dashboard,
        p => p.participants.some(x => x.id === oldId && !x.connected),
      )
      client.disconnect()
      client.connect()
      await new Promise<void>(resolve => client.once('connect', () => resolve()))
      await oldClosed

      const { participantId: newId } = await join(client, 'Bob') as { participantId: string }
      const finalPayload = await waitForMatchingStateUpdate<{ participants: Array<{ id: string, connected: boolean, name: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === newId),
      )

      expect(newId).not.toBe(oldId)
      const oldRow = finalPayload.participants.find(p => p.id === oldId)
      const newRow = finalPayload.participants.find(p => p.id === newId)
      expect(oldRow?.connected).toBe(false)
      expect(newRow?.connected).toBe(true)
      expect(newRow?.name).toBe('Bob')
    })

    // Follow-up bug found in live use: open a second tab (localStorage
    // resume — plan 030's follow-on fix — means it resumes the *same*
    // participant, on a second socket), close that second tab, and the
    // first tab is still open/connected — the participant must stay
    // `viewing now`, not flip to `closed` just because one of its two
    // sockets disconnected.
    it('closing a second tab for the same participant does not mark them closed while the first tab is still connected', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const tab1 = await connectClient()
      const { participantId } = await join(tab1) as { participantId: string }
      await waitForMatchingStateUpdate<{ participants: Array<{ id: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId),
      )

      // Second tab, same browser: resumes by supplying the same participantId
      // (mirrors `JoinScreen.vue`'s localStorage-backed auto-resume).
      const tab2 = await connectClient()
      await emitWithAck(tab2, 'participant:join', { name: 'Ada', participantId, roomCode: TEST_ROOM_CODE })

      // Close only the second tab.
      const afterTab2Close = waitForMatchingStateUpdate<{ participants: Array<{ id: string, connected: boolean }> }>(
        dashboard,
        p => p.participants.find(x => x.id === participantId)?.connected === false,
      )
      tab2.disconnect()
      // No `state:update` marks this participant closed — removing one of
      // two live sockets isn't a user-visible change, so `server.ts` doesn't
      // even broadcast for it (see `removeParticipantSocket`'s return
      // value). Race a short timeout against the (should-never-resolve)
      // "closed" update to prove that.
      const raced = await Promise.race([
        afterTab2Close.then(() => 'closed (BUG)'),
        new Promise<string>(resolve => setTimeout(resolve, 300, 'still connected (expected)')),
      ])
      expect(raced).toBe('still connected (expected)')
      expect(room.participants.get(participantId)?.connected).toBe(true)
      expect(room.participants.get(participantId)?.visibility).not.toBe('closed')

      // Now close the *first* (last remaining) tab — this one really should
      // close the participant.
      const afterTab1Close = waitForMatchingStateUpdate<{ participants: Array<{ id: string, connected: boolean, visibility: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId && !x.connected),
      )
      tab1.disconnect()
      const finalPayload = await afterTab1Close
      const row = finalPayload.participants.find(p => p.id === participantId)
      expect(row?.connected).toBe(false)
      expect(row?.visibility).toBe('closed')
    })

    it('presenter:resolveError notifies every open tab of the reporting participant, not just the most recently joined one', async () => {
      const tab1 = await connectClient()
      const { participantId } = await join(tab1) as { participantId: string }
      const tab2 = await connectClient()
      await emitWithAck(tab2, 'participant:join', { name: 'Ada', participantId, roomCode: TEST_ROOM_CODE })

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      // Report from tab1 — before the fix, this made tab2 (the more
      // recently *joined* socket) the participant's sole `socketId`, so a
      // resolution notification could only ever reach tab2, never tab1.
      tab1.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const tab1Notified = waitFor<{ errorId: string }>(tab1, 'participant:errorResolved')
      const tab2Notified = waitFor<{ errorId: string }>(tab2, 'participant:errorResolved')
      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId, presenterCode: TEST_PRESENTER_CODE })

      const [tab1Result, tab2Result] = await Promise.all([tab1Notified, tab2Notified])
      expect(tab1Result.errorId).toBe(errorId)
      expect(tab2Result.errorId).toBe(errorId)
    })

    it('the periodic staleness sweep closes a hung participant whose socket is gone, without a clean disconnect', async () => {
      // A short sweep interval (instead of the production 5s default) keeps
      // this an integration smoke test for the *wiring*, not a re-test of
      // the sweep's own logic — that's `presence.test.ts`'s job, with fake
      // timers and no real waiting at all. A small real wait here (mirroring
      // this file's existing "give the server a tick" pattern) confirms
      // `server.ts` actually calls `sweepStaleParticipants` on a timer and
      // rebroadcasts when it changes something.
      await stopServer()
      await startServer({
        roomCode: TEST_ROOM_CODE,
        presenterCode: TEST_PRESENTER_CODE,
        sweepIntervalMs: 20,
      })

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const participant = await connectClient()
      const { participantId } = await join(participant) as { participantId: string }
      await waitForMatchingStateUpdate<{ participants: Array<{ id: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId),
      )

      // Simulate a genuinely *hung* connection — not just a fast one.
      // `serverSocket.conn.close()` was tried here first and looked
      // plausible, but it's actually indistinguishable from an ordinary
      // clean disconnect: closing the engine.io transport server-side still
      // fires Socket.io's own `disconnect` event (reason `'transport
      // close'`), which the `disconnect` handler above already handles on
      // its own, immediately — meaning that version of this test coincidentally
      // passed via the *ordinary* disconnect path, without the sweep's own
      // closing logic ever running at all. A real hang (dead wifi) never
      // fires any close event on either side; the only thing that's
      // actually true in that state is what `isSocketConnected`
      // (`server.ts`) checks — `io.sockets.sockets.has(id)` — so this
      // deletes the live socket from Socket.io's own registry directly,
      // with no disconnect event involved, then back-dates `lastSeen` past
      // `STALE_AFTER_MS` so the very next sweep tick sees it as both stale
      // and no-longer-registered.
      const serverSocket = [...server.io.sockets.sockets.values()].find(s => s.id === participant.id) ?? [...server.io.sockets.sockets.values()][0]
      room.participants.get(participantId)!.lastSeen = 0
      if (serverSocket)
        server.io.sockets.sockets.delete(serverSocket.id)

      const closedUpdate = waitForMatchingStateUpdate<{ participants: Array<{ id: string, connected: boolean, visibility: string }> }>(
        dashboard,
        p => p.participants.some(x => x.id === participantId && !x.connected),
      )
      const payload = await closedUpdate

      const row = payload.participants.find(p => p.id === participantId)
      expect(row?.connected).toBe(false)
      expect(row?.visibility).toBe('closed')
    })
  })

  describe('pending connections + kick (presenter roster management)', () => {
    it('participant:connecting adds a pending connection visible on the dashboard', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const client = await connectClient()
      const update = waitForMatchingStateUpdate<{ pendingConnections: Array<{ socketId: string }> }>(
        dashboard,
        p => p.pendingConnections.length > 0,
      )
      client.emit('participant:connecting')
      const payload = await update

      expect(payload.pendingConnections).toEqual([{ socketId: client.id, connectedAt: expect.any(Number) }])
    })

    it('participant:join removes the pending connection in the same update the participant appears in', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const client = await connectClient()
      const pending = waitForMatchingStateUpdate<{ pendingConnections: unknown[] }>(
        dashboard,
        p => p.pendingConnections.length > 0,
      )
      client.emit('participant:connecting')
      await pending

      const joined = waitForMatchingStateUpdate<{ pendingConnections: unknown[], participants: Array<{ name: string }> }>(
        dashboard,
        p => p.participants.some(x => x.name === 'Ada'),
      )
      await join(client, 'Ada')
      const payload = await joined

      expect(payload.pendingConnections).toEqual([])
    })

    it('disconnecting before ever joining removes the pending connection and notifies the dashboard', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const client = await connectClient()
      const pending = waitForMatchingStateUpdate<{ pendingConnections: unknown[] }>(
        dashboard,
        p => p.pendingConnections.length > 0,
      )
      client.emit('participant:connecting')
      await pending

      const gone = waitForMatchingStateUpdate<{ pendingConnections: unknown[] }>(
        dashboard,
        p => p.pendingConnections.length === 0,
      )
      client.disconnect()

      const payload = await gone
      expect(payload.pendingConnections).toEqual([])
    })

    it('presenter:kickPendingConnection disconnects the socket and clears it from the dashboard', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const client = await connectClient()
      const pending = waitForMatchingStateUpdate<{ pendingConnections: Array<{ socketId: string }> }>(
        dashboard,
        p => p.pendingConnections.length > 0,
      )
      client.emit('participant:connecting')
      const { pendingConnections } = await pending
      const socketId = pendingConnections[0].socketId

      // The exact reason string matters, not just "it disconnected" — the
      // addon's `JoinScreen.vue` distinguishes a server-initiated kick from
      // an ordinary network drop/reconnect by this value alone (see that
      // component's own comment on `onForciblyDisconnected`). A regression
      // here (e.g. socket.io ever changing this string, or this handler
      // switching to a different disconnect mechanism) would silently break
      // that client-side behavior without any other test catching it.
      const disconnectReason = waitFor<string>(client, 'disconnect')
      const presenter = await connectClient()
      presenter.emit('presenter:kickPendingConnection', { socketId, presenterCode: TEST_PRESENTER_CODE })

      expect(await disconnectReason).toBe('io server disconnect')
    })

    it('presenter:kickPendingConnection without a valid presenterCode is a no-op', async () => {
      const client = await connectClient()
      client.emit('participant:connecting')
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      let disconnected = false
      client.on('disconnect', () => {
        disconnected = true
      })

      const presenter = await connectClient()
      presenter.emit('presenter:kickPendingConnection', { socketId: client.id, presenterCode: 'wrong' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(disconnected).toBe(false)
    })

    it('presenter:kickPendingConnection with a valid presenterCode but an unknown socketId is a no-op (no crash)', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const presenter = await connectClient()
      presenter.emit('presenter:kickPendingConnection', { socketId: 'not-a-real-socket-id', presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      // Reaching here without throwing/hanging is the assertion — there was
      // never a pending connection under this socketId to clear, and
      // nothing else on the dashboard changed either.
      expect(room.participants.size).toBe(0)
    })

    it('presenter:kickParticipant disconnects every one of the participant\'s sockets and removes them from the dashboard', async () => {
      const tab1 = await connectClient()
      const { participantId } = await join(tab1, 'Ada') as { participantId: string }
      const tab2 = await connectClient()
      await emitWithAck(tab2, 'participant:join', { name: 'Ada', participantId, roomCode: TEST_ROOM_CODE })

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const removed = waitForMatchingStateUpdate<{ participants: Array<{ id: string }> }>(
        dashboard,
        p => !p.participants.some(x => x.id === participantId),
      )
      // Same reason-string assertion as the pending-connection kick test
      // above, for both tabs — see that test's own comment for why the
      // exact value matters.
      const tab1Disconnected = waitFor<string>(tab1, 'disconnect')
      const tab2Disconnected = waitFor<string>(tab2, 'disconnect')

      const presenter = await connectClient()
      presenter.emit('presenter:kickParticipant', { participantId, presenterCode: TEST_PRESENTER_CODE })

      const [tab1Reason, tab2Reason] = await Promise.all([tab1Disconnected, tab2Disconnected])
      await removed
      expect(tab1Reason).toBe('io server disconnect')
      expect(tab2Reason).toBe('io server disconnect')
      expect(room.participants.has(participantId)).toBe(false)
    })

    it('a kicked participant\'s old id cannot resume — a later join with it falls back to a fresh identity', async () => {
      const client = await connectClient()
      const { participantId } = await join(client, 'Ada') as { participantId: string }

      const presenter = await connectClient()
      presenter.emit('presenter:kickParticipant', { participantId, presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      // A fresh socket attempting to resume the now-deleted id, with the
      // correct room code (a real resume wouldn't need one, but this id no
      // longer resolves to anything the server considers "already known" —
      // see `isKnownResume` in this file — so the room-code gate applies
      // exactly like a brand-new join).
      const retry = await connectClient()
      const ack = await emitWithAck<{ participantId: string, resumed: boolean }>(
        retry,
        'participant:join',
        { name: 'Ada', participantId, roomCode: TEST_ROOM_CODE },
      )

      expect(ack.resumed).toBe(false)
      expect(ack.participantId).not.toBe(participantId)
    })

    it('presenter:kickParticipant without a valid presenterCode is a no-op', async () => {
      const client = await connectClient()
      const { participantId } = await join(client, 'Ada') as { participantId: string }

      let disconnected = false
      client.on('disconnect', () => {
        disconnected = true
      })

      const presenter = await connectClient()
      presenter.emit('presenter:kickParticipant', { participantId, presenterCode: 'wrong' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(disconnected).toBe(false)
      expect(room.participants.has(participantId)).toBe(true)
    })

    it('presenter:kickParticipant on an unknown id is a no-op (no crash, no broadcast storm)', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const presenter = await connectClient()
      presenter.emit('presenter:kickParticipant', { participantId: 'does-not-exist', presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      // Reaching here without throwing/hanging is the assertion; nothing
      // else should have changed.
      expect(room.participants.size).toBe(0)
    })
  })

  describe('dashboard broadcast (M2)', () => {
    it('sends an immediate state:update snapshot to a socket that joins the dashboard room', async () => {
      const client = await connectClient()
      await join(client)

      const dashboard = await connectClient()
      const snapshotPromise = waitFor<{ participants: unknown[] }>(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      const snapshot = await snapshotPromise

      expect(snapshot.participants).toHaveLength(1)
    })

    it('broadcasts state:update to dashboard-joined sockets only, not to every connected client', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const bystander = await connectClient()
      let bystanderReceivedUpdate = false
      bystander.on('state:update', () => {
        bystanderReceivedUpdate = true
      })

      const participant = await connectClient()
      const { participantId } = await join(participant) as { participantId: string }

      const update = waitForMatchingStateUpdate<{ stepStatus: Array<{ participantId: string, stepId: string, state: string, updatedAt: number }> }>(
        dashboard,
        payload => payload.stepStatus.some(s => s.participantId === participantId && s.stepId === 'install-deps'),
      )
      participant.emit('participant:copy', { stepId: 'install-deps' })
      const payload = await update

      expect(payload.stepStatus).toContainEqual({ participantId, stepId: 'install-deps', state: 'copied', updatedAt: expect.any(Number) })

      await new Promise<void>(resolve => setTimeout(resolve, 50))
      expect(bystanderReceivedUpdate).toBe(false)
    })
  })

  describe('presenter reports the active step (M2)', () => {
    // `presenter:setStep` is its own event, separate from
    // `presenter:setSlide` — the addon computes `stepId` from a real
    // mounted component's `useNav().currentFrontmatter` (see
    // `StepReporter.vue`), not from the router's resolved route object
    // `presenter:setSlide` derives its `index` from, so the two can't share
    // one event without one of them reading unreliable data (that's exactly
    // what plan 027 Step 1 asked to confirm empirically, and the original
    // combined-event approach failed that check during manual verification).
    it('presenter:setStep sets currentStepId and broadcasts state:update to the dashboard', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const presenter = await connectClient()
      const update = waitFor<{ currentStepId: string }>(dashboard, 'state:update')
      presenter.emit('presenter:setStep', { stepId: 'install-deps', presenterCode: TEST_PRESENTER_CODE })
      const payload = await update

      expect(payload.currentStepId).toBe('install-deps')
    })

    it('presenter:setSlide alone does not change currentStepId', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      await joinAsDashboard(dashboard)
      await initialSnapshot

      const presenter = await connectClient()
      presenter.emit('presenter:setStep', { stepId: 'install-deps', presenterCode: TEST_PRESENTER_CODE })
      await waitForMatchingStateUpdate<{ currentStepId: string }>(dashboard, p => p.currentStepId === 'install-deps')

      const update = waitFor<{ currentSlideIndex: number, currentStepId: string }>(dashboard, 'state:update')
      presenter.emit('presenter:setSlide', { index: 7, presenterCode: TEST_PRESENTER_CODE })
      const payload = await update

      expect(payload.currentSlideIndex).toBe(7)
      expect(payload.currentStepId).toBe('install-deps')
    })
  })

  describe('error reports (M3)', () => {
    // Reuses the top-level `join`/room-code-aware helper (plan 029) rather
    // than a local shadow — this describe block predates 029's auth work
    // (concurrent worktrees, reconciled at merge time); a `join` that didn't
    // supply `roomCode` would get `{ error: 'invalid_room_code' }` back with
    // no `participantId`, and every test below would hang waiting on a
    // `state:update`/ack that a never-actually-joined participant can't
    // trigger, rather than failing loudly.

    it('participant:error (text-only) creates an ErrorReport and broadcasts it to the dashboard', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const update = waitForMatchingStateUpdate<{ errors: Array<{ participantId: string, stepId: string, text?: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      client.emit('participant:error', { stepId: 'install-deps', text: 'npm install failed' })
      const payload = await update

      expect(payload.errors).toContainEqual(
        expect.objectContaining({ participantId, stepId: 'install-deps', text: 'npm install failed', kind: 'problem', status: 'open' }),
      )
      expect(room.errorReports).toHaveLength(1)
    })

    // Second-pass security fix: `text` had no length cap, so a socket that
    // already completed `participant:join` (an identity check, not a
    // content one) could spam arbitrarily large payloads into this
    // process's unbounded, in-memory `room.errorReports` array. Exercised here
    // end-to-end (the real WS handler, not just `session.ts`'s pure
    // `addErrorReport` — see `session.test.ts` for that unit coverage) to
    // confirm the cap is actually wired up on the path a real client uses.
    it('participant:error with oversized text is capped, not rejected outright', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const update = waitForMatchingStateUpdate<{ errors: Array<{ participantId: string, text?: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      const overlong = 'x'.repeat(10_000)
      client.emit('participant:error', { stepId: 'install-deps', text: overlong })
      const payload = await update

      const report = payload.errors.find(e => e.participantId === participantId)!
      expect(report.text).toHaveLength(MAX_TEXT_LENGTH)
      expect(report.text).toBe(overlong.slice(0, MAX_TEXT_LENGTH))
    })

    it('participant:error with kind: "question" creates a question-kind report', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const update = waitForMatchingStateUpdate<{ errors: Array<{ participantId: string, kind: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      client.emit('participant:error', { stepId: 'install-deps', text: 'how do I undo this?', kind: 'question' })
      const payload = await update

      expect(payload.errors).toContainEqual(expect.objectContaining({ participantId, kind: 'question' }))
    })

    it('ignores participant:error from a socket that has not joined yet', async () => {
      const client = await connectClient()

      client.emit('participant:error', { stepId: 'install-deps', text: 'hello' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports).toHaveLength(0)
    })

    it('presenter:resolveError moves a report to awaiting_confirmation and broadcasts the update', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      client.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const presenter = await connectClient()
      const resolved = waitForMatchingStateUpdate<{ errors: Array<{ id: string, status: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.id === errorId && e.status === 'awaiting_confirmation'),
      )
      presenter.emit('presenter:resolveError', { errorId, presenterCode: TEST_PRESENTER_CODE })
      const resolvedPayload = await resolved

      expect(resolvedPayload.errors.find(e => e.id === errorId)?.status).toBe('awaiting_confirmation')
      expect(room.errorReports.find(e => e.id === errorId)?.status).toBe('awaiting_confirmation')
    })

    it('presenter:resolveError on an unknown id is a no-op (no crash, no broadcast storm)', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      // "no broadcast storm" is an actual assertion, not just a comment: an
      // unknown `errorId` must not even trigger a wasted `state:update` —
      // nothing changed, so there's nothing for the dashboard room to be
      // told about, matching every other unknown-id handler in this file.
      let sawUpdate = false
      dashboard.on('state:update', () => {
        sawUpdate = true
      })

      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId: 'does-not-exist', presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports).toHaveLength(0)
      expect(sawUpdate).toBe(false)
    })

    it('presenter:resolveError with a wrong presenterCode is a no-op, even for a real report', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const attacker = await connectClient()
      attacker.emit('presenter:resolveError', { errorId, presenterCode: 'wrong-code' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports.find(e => e.id === errorId)?.status).toBe('open')
    })

    // Reports are append-only and outlive the participant record that filed
    // them (`removeParticipant`'s doc comment, `session.ts`) — a presenter
    // can still act on one after kicking its reporter. `notifyReporter`
    // (`server.ts`) is what has to no-op gracefully here: `reporterOf`
    // returns `undefined` once the participant record is gone, and there's
    // no live socket left to notify anyway.
    it('presenter:resolveError on a report whose reporting participant was already kicked does not crash', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      removeParticipant(room, participantId)

      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId, presenterCode: TEST_PRESENTER_CODE, message: 'fixed on our end' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      // The report itself still transitions normally — only the
      // now-pointless notification is skipped.
      expect(room.errorReports.find(e => e.id === errorId)?.status).toBe('awaiting_confirmation')
    })

    // Follow-up after initial manual testing: "Mark resolved" should close
    // the loop back to the reporting participant, optionally with a message
    // — targeted at *that participant's own socket*, not broadcast to
    // everyone and not just visible on the dashboard.
    it('presenter:resolveError with a message notifies only the reporting participant\'s own socket', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }

      const bystander = await connectClient()
      await join(bystander, 'Bob')
      let bystanderNotified = false
      bystander.on('participant:errorResolved', () => {
        bystanderNotified = true
      })

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const notified = waitFor<{ errorId: string, stepId: string, status: string, message?: string }>(reporter, 'participant:errorResolved')
      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId, presenterCode: TEST_PRESENTER_CODE, message: '  keep going, almost there!  ' })
      const notification = await notified

      expect(notification).toEqual({ errorId, stepId: 'install-deps', status: 'awaiting_confirmation', message: 'keep going, almost there!' })
      expect(room.errorReports.find(e => e.id === errorId)?.thread).toEqual([
        { from: 'presenter', text: 'keep going, almost there!', ts: expect.any(Number) },
      ])

      await new Promise<void>(resolve => setTimeout(resolve, 50))
      expect(bystanderNotified).toBe(false)
    })

    it('presenter:resolveError with no message still notifies the participant, with message undefined', async () => {
      const reporter = await connectClient()
      await join(reporter)

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string }> }>(
        dashboard,
        payload => payload.errors.length > 0,
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const notified = waitFor<{ errorId: string, message?: string }>(reporter, 'participant:errorResolved')
      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId, presenterCode: TEST_PRESENTER_CODE })
      const notification = await notified

      expect(notification.message).toBeUndefined()
    })

    it('presenter:sendMessage appends a thread message and pushes it to the reporting participant live', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const pushed = waitFor<{ errorId: string, stepId: string, text: string }>(reporter, 'participant:message')
      const presenter = await connectClient()
      presenter.emit('presenter:sendMessage', { errorId, presenterCode: TEST_PRESENTER_CODE, text: 'still looking into it' })
      const notification = await pushed

      expect(notification).toEqual({ errorId, stepId: 'install-deps', text: 'still looking into it' })
      expect(room.errorReports.find(e => e.id === errorId)?.status).toBe('open')
      expect(room.errorReports.find(e => e.id === errorId)?.thread).toEqual([
        { from: 'presenter', text: 'still looking into it', ts: expect.any(Number) },
      ])
    })

    it('presenter:sendMessage without a valid presenterCode is a no-op', async () => {
      const reporter = await connectClient()
      await join(reporter)

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string }> }>(
        dashboard,
        payload => payload.errors.length > 0,
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const presenter = await connectClient()
      presenter.emit('presenter:sendMessage', { errorId, presenterCode: 'wrong', text: 'nope' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports.find(e => e.id === errorId)?.thread).toEqual([])
    })

    it('presenter:sendMessage with a valid presenterCode but an unknown errorId is a no-op (no crash)', async () => {
      const presenter = await connectClient()

      presenter.emit('presenter:sendMessage', { errorId: 'does-not-exist', presenterCode: TEST_PRESENTER_CODE, text: 'hello?' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      // Reaching here without throwing/hanging is the assertion — there's no
      // report to have received the message in the first place.
      expect(room.errorReports).toHaveLength(0)
    })

    it('participant:confirmResolution from a socket that has not joined yet is a no-op', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      const errorId = room.errorReports.find(e => e.participantId === participantId)!.id

      // A socket with no `socket.data.participantId` at all (never called
      // `participant:join`) — distinct from `errorReportOwnedBy`'s ownership
      // rejection (already covered by the "does not own the report" test
      // above), this exercises the earlier "hasn't joined at all" guard.
      const neverJoined = await connectClient()
      neverJoined.emit('participant:confirmResolution', { errorId, confirmed: true })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports.find(e => e.id === errorId)?.status).toBe('open')
    })

    it('participant:addMessage from a socket that has not joined yet is a no-op', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      const errorId = room.errorReports.find(e => e.participantId === participantId)!.id

      const neverJoined = await connectClient()
      neverJoined.emit('participant:addMessage', { errorId, text: 'can I help?' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports.find(e => e.id === errorId)?.thread).toEqual([])
    })

    // Defensive, not just theoretical: a presenter could in principle kick a
    // participant in the brief window between an event they sent being
    // received and being processed — `socket.data.participantId` still
    // points at a now-deleted record. `participant:error`'s handler guards
    // against exactly this (`registerHelpRequestHandlers` in `server.ts`).
    it('participant:error from a socket whose participant record was removed mid-flight is a no-op', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }
      removeParticipant(room, participantId)

      client.emit('participant:error', { stepId: 'install-deps', text: 'ghost report' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports).toHaveLength(0)
    })

    it('participant:confirmResolution(true) resolves the report and updates the dashboard', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const presenter = await connectClient()
      const awaitingConfirmation = waitForMatchingStateUpdate<{ errors: Array<{ id: string, status: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.id === errorId && e.status === 'awaiting_confirmation'),
      )
      presenter.emit('presenter:resolveError', { errorId, presenterCode: TEST_PRESENTER_CODE, message: 'try this' })
      await awaitingConfirmation

      const confirmed = waitForMatchingStateUpdate<{ errors: Array<{ id: string, status: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.id === errorId && e.status === 'resolved'),
      )
      reporter.emit('participant:confirmResolution', { errorId, confirmed: true, message: 'yep, fixed!' })
      const resolvedPayload = await confirmed

      expect(resolvedPayload.errors.find(e => e.id === errorId)?.status).toBe('resolved')
      expect(room.errorReports.find(e => e.id === errorId)?.thread.at(-1)).toEqual({ from: 'participant', text: 'yep, fixed!', ts: expect.any(Number) })
    })

    it('participant:confirmResolution(false) reopens the report', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId, presenterCode: TEST_PRESENTER_CODE, message: 'try this' })

      const reopened = waitForMatchingStateUpdate<{ errors: Array<{ id: string, status: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.id === errorId && e.status === 'reopened'),
      )
      reporter.emit('participant:confirmResolution', { errorId, confirmed: false, message: 'still broken' })
      const reopenedPayload = await reopened

      expect(reopenedPayload.errors.find(e => e.id === errorId)?.status).toBe('reopened')
    })

    it('participant:confirmResolution from a socket that does not own the report is a no-op', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }
      const bystander = await connectClient()
      await join(bystander, 'Bob')

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      bystander.emit('participant:confirmResolution', { errorId, confirmed: true })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports.find(e => e.id === errorId)?.status).toBe('open')
    })

    it('participant:addMessage appends a follow-up to the reporter\'s own report', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'how do I fix this?', kind: 'question' })
      const { errors } = await created
      const errorId = errors[0].id

      const update = waitForMatchingStateUpdate<{ errors: Array<{ id: string, thread: Array<{ text: string }> }> }>(
        dashboard,
        payload => payload.errors.some(e => e.id === errorId && e.thread.length > 0),
      )
      reporter.emit('participant:addMessage', { errorId, text: 'also, does this affect step 2?' })
      const updatedPayload = await update

      expect(updatedPayload.errors.find(e => e.id === errorId)?.thread).toEqual([
        { from: 'participant', text: 'also, does this affect step 2?', ts: expect.any(Number) },
      ])
    })

    it('participant:addMessage from a socket that does not own the report is a no-op', async () => {
      const reporter = await connectClient()
      const { participantId } = await join(reporter) as { participantId: string }
      const bystander = await connectClient()
      await join(bystander, 'Bob')

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      reporter.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      bystander.emit('participant:addMessage', { errorId, text: 'not my report but let me add to it' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.errorReports.find(e => e.id === errorId)?.thread).toEqual([])
    })
  })

  describe('post /api/screenshot (M3)', () => {
    it('accepts a valid multipart upload, creates an ErrorReport, and broadcasts state:update', async () => {
      const client = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot
      const update = waitForMatchingStateUpdate<{ errors: Array<{ participantId: string, screenshotUrl?: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('text', 'blew up')
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })
      expect(response.status).toBe(201)
      const body = await response.json() as { id: string, screenshotUrl: string }
      expect(body.id).toBeTruthy()
      expect(body.screenshotUrl).toMatch(/^\/uploads\/.+\.png$/)

      const payload = await update
      expect(payload.errors).toContainEqual(
        expect.objectContaining({ participantId, screenshotUrl: body.screenshotUrl }),
      )

      // The uploaded screenshot is actually servable back.
      const imageResponse = await fetch(`${url}${body.screenshotUrl}`)
      expect(imageResponse.status).toBe(200)
      const bytes = Buffer.from(await imageResponse.arrayBuffer())
      expect(bytes).toEqual(ONE_PIXEL_PNG)
    })

    it('rejects an unknown participantId with 400 and does not create an ErrorReport', async () => {
      const form = new FormData()
      form.set('participantId', 'not-a-real-participant')
      form.set('stepId', 'install-deps')
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(400)
      expect(room.errorReports).toHaveLength(0)
    })

    it('rejects a request with no participantId field at all with 400', async () => {
      // Distinct from the "unknown participantId" case above (a truthy but
      // unrecognized value) — this omits the field entirely, exercising the
      // short-circuit in `screenshotUpload.ts` that skips the registry
      // lookup rather than calling `room.participants.get(undefined)`.
      const form = new FormData()
      form.set('stepId', 'install-deps')
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(400)
      expect(room.errorReports).toHaveLength(0)
    })

    it('rejects a request with no screenshot file (text-only reports use the participant:error WS event)', async () => {
      const client = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('text', 'no screenshot here')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(400)
      expect(room.errorReports).toHaveLength(0)
    })

    it('rejects an unsupported file content type', async () => {
      const client = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('screenshot', new Blob(['not an image'], { type: 'text/plain' }), 'shot.txt')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(400)
      expect(room.errorReports).toHaveLength(0)
    })

    it('rejects an upload larger than the size cap with 413', async () => {
      const client = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const oversized = Buffer.alloc(6 * 1024 * 1024, 1) // > UPLOAD_MAX_BYTES (5MB)
      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('screenshot', new Blob([oversized], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(413)
      expect(room.errorReports).toHaveLength(0)
    })

    it('rejects a path-traversal attempt against the uploads static route', async () => {
      // The upload handler only ever writes server-generated UUID filenames
      // (see `uploads.ts`), so this exercises the *serving* side: a crafted
      // request path can't escape the confined uploads directory to read an
      // arbitrary file (mirrors plans 014-016's discipline).
      const response = await fetch(`${url}/uploads/..%2f..%2f..%2f..%2f..%2fetc%2fpasswd`)
      expect(response.status).not.toBe(200)

      const response2 = await fetch(`${url}/uploads/not-a-real-uuid.png`)
      expect(response2.status).not.toBe(200)
    })

    it('rejects a request against /uploads with malformed percent-encoding with 400', async () => {
      // `decodeURIComponent` throws on a truncated/invalid escape sequence
      // (e.g. a lone `%` not followed by two hex digits) — `server.ts`'s
      // `/uploads` middleware catches that explicitly rather than letting it
      // escape as an unhandled error. `fetch()` itself won't send a raw `%`
      // in a URL without complaint (Node normalizes/rejects some malformed
      // URLs client-side), so the invalid escape is written directly onto
      // the raw HTTP request line instead of going through `fetch`'s own URL
      // parsing.
      const { port } = server.httpServer.address() as AddressInfo
      const status = await new Promise<number>((resolve, reject) => {
        const socket = netConnect(port, 'localhost', () => {
          socket.write('GET /uploads/%E0%A4%A HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
        })
        let data = ''
        socket.on('data', (chunk) => {
          data += chunk.toString()
        })
        socket.on('end', () => resolve(Number(data.split('\r\n')[0].split(' ')[1])))
        socket.on('error', reject)
      })

      expect(status).toBe(400)
    })

    it('a request to an unrelated path/method falls through the screenshot handler untouched (plain 404)', async () => {
      // Exercises `createScreenshotUploadHandler`'s own early `next()` for
      // anything that isn't `POST /api/screenshot` — every other request in
      // this suite that reaches this middleware is fully handled by an
      // earlier one (`sirv` for `/dashboard`/`/uploads`), so this is the
      // only way to observe this fallthrough actually firing and the
      // request reaching connect's own default 404 with nothing left to
      // handle it.
      const response = await fetch(`${url}/not-a-real-route`)

      expect(response.status).toBe(404)
    })

    it('rejects a POST /api/screenshot with a non-multipart Content-Type with 400', async () => {
      // Busboy's constructor throws synchronously for a missing/invalid
      // Content-Type rather than emitting an async error event
      // (`screenshotUpload.ts`'s own comment on this) — a JSON body is a
      // convenient way to trigger that from a real HTTP request.
      const response = await fetch(`${url}/api/screenshot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })

      expect(response.status).toBe(400)
      const body = await response.text()
      expect(body).toContain('multipart/form-data')
      expect(room.errorReports).toHaveLength(0)
    })

    it('rejects a multipart upload missing stepId with 400 and cleans up the saved file', async () => {
      const client = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(400)
      const body = await response.text()
      expect(body).toContain('stepId is required')
      expect(room.errorReports).toHaveLength(0)
    })

    // Second-pass security fix: the multipart `text` field went straight
    // into `addErrorReport` uncapped, same gap as the WS `participant:error`
    // path above — a screenshot upload's accompanying description is just
    // as unbounded a text field as any other.
    it('caps an oversized multipart text field rather than storing it unbounded', async () => {
      const client = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', roomCode: TEST_ROOM_CODE },
      )

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('text', 'x'.repeat(10_000))
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(201)
      const report = room.errorReports.find(e => e.participantId === participantId)
      expect(report?.text).toHaveLength(MAX_TEXT_LENGTH)
    })
  })

  // Bug found in manual browser testing: the participant's browser loads
  // the deck from a *different* origin (Slidev's own dev server) than this
  // sync server, so `POST /api/screenshot` is a cross-origin `fetch()`.
  // Node's own `fetch` (used throughout this file) doesn't enforce CORS —
  // the requests above always "worked" from Node's point of view even
  // before the fix — so this suite could never have caught the real
  // symptom (a *browser* refusing to let JS read a same-request response
  // lacking `Access-Control-Allow-Origin`) by itself. What it *can* verify,
  // and what the fix actually is, is that the header is present and correct
  // — that's sufficient for a browser to accept the response.
  describe('cors (cross-origin browser fetch from the Slidev deck)', () => {
    it('post /api/screenshot response carries Access-Control-Allow-Origin', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.headers.get('access-control-allow-origin')).toBe('*')
    })

    it('an OPTIONS preflight gets a 204 with the CORS headers, not a 404/405', async () => {
      const response = await fetch(`${url}/api/screenshot`, { method: 'OPTIONS' })

      expect(response.status).toBe(204)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(response.headers.get('access-control-allow-methods')).toContain('POST')
    })

    it('respects a configured origin instead of always using the wildcard', async () => {
      await stopServer()
      await startServer({
        roomCode: TEST_ROOM_CODE,
        presenterCode: TEST_PRESENTER_CODE,
        origin: 'http://localhost:3030',
      })

      const response = await fetch(`${url}/api/screenshot`, { method: 'OPTIONS' })

      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3030')
    })
  })

  // Plan 032a's whole point, end to end: one process, two concurrent
  // workshops, no leakage between them in either direction. `session.test.ts`
  // covers the same isolation at the state layer; these drive it over real
  // sockets and real HTTP, through the room hint that actually decides which
  // session a connection belongs to.
  describe('multi-room isolation (plan 032a)', () => {
    const ROOM_B_CODE = 'room-b-secret'
    const PRESENTER_B_CODE = 'presenter-b-secret'
    let roomB: RoomState

    // The room hint (`ROOM_CODE_QUERY_PARAM` in `server.ts`): a Socket.io
    // handshake query parameter, read once at connection time. Chosen over a
    // field on `participant:connecting` because the room is needed *before*
    // any event — `slide:sync` is emitted the instant a socket connects — so
    // one mechanism covers the handshake, the pre-join "someone's here"
    // signal, and every later handler. See that constant's own doc comment
    // for why it grants nothing on its own.
    function newClientInRoom(roomCode: string): ClientSocket {
      const socket = ioClient(url, { forceNew: true, transports: ['websocket'], query: { roomCode } })
      clients.push(socket)
      return socket
    }

    function connectClientInRoom(roomCode: string): Promise<ClientSocket> {
      const socket = newClientInRoom(roomCode)
      return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket))
        socket.once('connect_error', reject)
      })
    }

    async function joinRoomB(client: ClientSocket, name = 'Bob') {
      return emitWithAck<{ participantId: string, currentSlideIndex: number } | { error: string }>(
        client,
        'participant:join',
        { name, roomCode: ROOM_B_CODE },
      )
    }

    beforeEach(() => {
      // The seam 032b/032d will use to launch a session on a running server
      // — the same `createSession` the boot session above came through.
      roomB = server.createSession({ roomCode: ROOM_B_CODE, presenterCode: PRESENTER_B_CODE }).room
    })

    it('a socket with no room hint lands in the boot session (pre-032a clients keep working)', async () => {
      const client = await connectClient()
      const ack = await join(client, 'Ada') as { participantId: string }

      expect(room.participants.has(ack.participantId)).toBe(true)
      expect(roomB.participants.size).toBe(0)
    })

    it('a hinted socket joins only its own room, invisible to the other room\'s dashboard', async () => {
      const dashboardA = await connectClient()
      const snapshotA = waitFor(dashboardA, 'state:update')
      await joinAsDashboard(dashboardA)
      await snapshotA

      const dashboardB = await connectClientInRoom(ROOM_B_CODE)
      const snapshotB = waitFor(dashboardB, 'state:update')
      await emitWithAck(dashboardB, 'dashboard:join', { presenterCode: PRESENTER_B_CODE })
      await snapshotB

      // Registered *before* either join, not after: each join broadcasts to
      // its own room's dashboard once, so a listener attached afterwards
      // would have nothing left to observe (same reason
      // `waitForMatchingStateUpdate` exists at all — see its own comment).
      const sawAda = waitForMatchingStateUpdate<{ participants: Array<{ id: string, name: string }> }>(
        dashboardA,
        p => p.participants.length > 0,
      )
      const sawBob = waitForMatchingStateUpdate<{ participants: Array<{ id: string, name: string }> }>(
        dashboardB,
        p => p.participants.length > 0,
      )

      // One participant in each room.
      const inA = await connectClient()
      const { participantId: idA } = await join(inA, 'Ada') as { participantId: string }
      const inB = await connectClientInRoom(ROOM_B_CODE)
      const { participantId: idB } = await joinRoomB(inB, 'Bob') as { participantId: string }

      const finalB = await sawBob
      expect(finalB.participants.some(p => p.id === idB)).toBe(true)
      // Room B's dashboard sees Bob and *only* Bob — Ada's join broadcast
      // was addressed to `dashboard:${roomA}`, a Socket.io room this socket
      // is not in, so there is no filtering step that could have been
      // forgotten: the payload was never sent here at all.
      expect(finalB.participants.map(p => p.name)).toEqual(['Bob'])
      expect(finalB.participants.some(p => p.id === idA)).toBe(false)

      const finalA = await sawAda
      expect(finalA.participants.map(p => p.name)).toEqual(['Ada'])
      expect(finalA.participants.some(p => p.id === idB)).toBe(false)
    })

    it('presenter:setSlide in one room does not move the other room\'s participants', async () => {
      const participantA = await connectClient()
      await join(participantA, 'Ada')
      const participantB = await connectClientInRoom(ROOM_B_CODE)
      await joinRoomB(participantB, 'Bob')

      let bSawSlideChange = false
      participantB.on('slide:changed', () => {
        bSawSlideChange = true
      })

      const aMoved = waitFor<{ index: number }>(participantA, 'slide:changed')
      const presenterA = await connectClient()
      presenterA.emit('presenter:setSlide', { index: 9, presenterCode: TEST_PRESENTER_CODE })
      await expect(aMoved).resolves.toEqual({ index: 9 })

      await new Promise<void>(resolve => setTimeout(resolve, 50))
      expect(bSawSlideChange).toBe(false)
      expect(room.session.currentSlideIndex).toBe(9)
      expect(roomB.session.currentSlideIndex).toBe(1)
    })

    it('a newly-connected socket is synced to its own room\'s slide, not the other room\'s', async () => {
      const presenterA = await connectClient()
      presenterA.emit('presenter:setSlide', { index: 6, presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      // Each listener is attached in the same tick its socket is created,
      // before the connection round-trip can complete — `slide:sync` is
      // emitted synchronously on connection, so attaching the second one
      // only after awaiting the first would race it (see `newClient`'s own
      // comment).
      const lateA = newClient()
      const syncA = waitFor<{ index: number }>(lateA, 'slide:sync')
      const lateB = newClientInRoom(ROOM_B_CODE)
      const syncB = waitFor<{ index: number }>(lateB, 'slide:sync')

      await expect(syncA).resolves.toEqual({ index: 6 })
      await expect(syncB).resolves.toEqual({ index: 1 })
    })

    it('one room\'s presenter code is worthless against the other room\'s presenter events', async () => {
      // The core auth property of the re-key: the presenter credential is
      // checked against *the socket's own room*, so holding room A's code
      // grants nothing in room B even though both are served by one process.
      const attacker = await connectClientInRoom(ROOM_B_CODE)

      attacker.emit('presenter:setSlide', { index: 99, presenterCode: TEST_PRESENTER_CODE })
      attacker.emit('presenter:setStep', { stepId: 'attacker-step', presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(roomB.session.currentSlideIndex).toBe(1)
      expect(roomB.session.currentStepId).toBe('1')
      // ...and it didn't act on room A either, since that's not this
      // socket's room.
      expect(room.session.currentSlideIndex).toBe(1)
    })

    it('one room\'s presenter code cannot open the other room\'s dashboard', async () => {
      const attacker = await connectClientInRoom(ROOM_B_CODE)

      const ack = await emitWithAck<DashboardJoinAck>(attacker, 'dashboard:join', { presenterCode: TEST_PRESENTER_CODE })

      expect(ack).toEqual({ ok: false })
      expect(ack.roomCode).toBeUndefined()
      expect(ack.presenterCode).toBeUndefined()

      // And the correct code for *this* room does work, so the rejection
      // above is about the credential, not about room B being unreachable.
      const ok = await emitWithAck<DashboardJoinAck>(attacker, 'dashboard:join', { presenterCode: PRESENTER_B_CODE })
      expect(ok).toMatchObject({ ok: true, roomCode: ROOM_B_CODE, presenterCode: PRESENTER_B_CODE })
    })

    it('one room\'s room code cannot be used to join the other room', async () => {
      const client = await connectClientInRoom(ROOM_B_CODE)

      const ack = await emitWithAck<{ error: string } | { participantId: string }>(
        client,
        'participant:join',
        { name: 'Eve', roomCode: TEST_ROOM_CODE },
      )

      expect(ack).toEqual({ error: 'invalid_room_code' })
      expect(roomB.participants.size).toBe(0)
      expect(room.participants.size).toBe(0)
    })

    it('a participant id minted in one room cannot resume in the other', async () => {
      const inA = await connectClient()
      const { participantId } = await join(inA, 'Ada') as { participantId: string }

      // No room code at all — which is exactly what a genuine resume sends
      // (the known-id exemption). Room B has never seen this id, so the
      // exemption doesn't apply there and the room-code gate rejects it.
      const inB = await connectClientInRoom(ROOM_B_CODE)
      const ack = await emitWithAck<{ error: string } | { participantId: string }>(
        inB,
        'participant:join',
        { name: 'Ada', participantId },
      )

      expect(ack).toEqual({ error: 'invalid_room_code' })
      expect(roomB.participants.size).toBe(0)
      expect(room.participants.get(participantId)?.name).toBe('Ada')
    })

    it('a socket naming a room that does not exist is rejected, indistinguishably from a bad code', async () => {
      const client = await connectClientInRoom('no-such-room')

      // Deliberately the same rejections a wrong credential gets, so this
      // event can't be used to enumerate which room codes name live
      // sessions.
      await expect(emitWithAck(client, 'participant:join', { name: 'Eve', roomCode: TEST_ROOM_CODE }))
        .resolves
        .toEqual({ error: 'invalid_room_code' })
      await expect(emitWithAck(client, 'dashboard:join', { presenterCode: TEST_PRESENTER_CODE }))
        .resolves
        .toEqual({ ok: false })

      // Every other handler is a silent no-op rather than a crash.
      client.emit('participant:connecting')
      client.emit('participant:copy', { stepId: 's1' })
      client.emit('participant:heartbeat', { stepId: 's1' })
      client.emit('presenter:setSlide', { index: 42, presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(room.participants.size).toBe(0)
      expect(roomB.participants.size).toBe(0)
      expect(room.session.currentSlideIndex).toBe(1)
    })

    it('pending connections show only on their own room\'s dashboard', async () => {
      const dashboardA = await connectClient()
      const snapshotA = waitFor(dashboardA, 'state:update')
      await joinAsDashboard(dashboardA)
      await snapshotA

      const dashboardB = await connectClientInRoom(ROOM_B_CODE)
      const snapshotB = waitFor(dashboardB, 'state:update')
      await emitWithAck(dashboardB, 'dashboard:join', { presenterCode: PRESENTER_B_CODE })
      await snapshotB

      let aSawPending = false
      dashboardA.on('state:update', (payload: { pendingConnections: unknown[] }) => {
        if (payload.pendingConnections.length > 0)
          aSawPending = true
      })

      const pendingInB = await connectClientInRoom(ROOM_B_CODE)
      const seen = waitForMatchingStateUpdate<{ pendingConnections: Array<{ socketId: string }> }>(
        dashboardB,
        p => p.pendingConnections.length > 0,
      )
      pendingInB.emit('participant:connecting')
      const payload = await seen

      expect(payload.pendingConnections).toEqual([{ socketId: pendingInB.id, connectedAt: expect.any(Number) }])
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      expect(aSawPending).toBe(false)
      expect(room.pendingConnections.size).toBe(0)
    })

    it('a presenter cannot kick the other room\'s participant or pending connection', async () => {
      const inA = await connectClient()
      const { participantId } = await join(inA, 'Ada') as { participantId: string }
      const pendingInA = await connectClient()
      pendingInA.emit('participant:connecting')
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      let aDisconnected = false
      inA.on('disconnect', () => {
        aDisconnected = true
      })
      let pendingDisconnected = false
      pendingInA.on('disconnect', () => {
        pendingDisconnected = true
      })

      // Room B's presenter, holding room B's own valid code, aiming at room
      // A's ids — a no-op, because the lookup is scoped to their own room.
      const presenterB = await connectClientInRoom(ROOM_B_CODE)
      presenterB.emit('presenter:kickParticipant', { participantId, presenterCode: PRESENTER_B_CODE })
      presenterB.emit('presenter:kickPendingConnection', { socketId: pendingInA.id, presenterCode: PRESENTER_B_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(aDisconnected).toBe(false)
      expect(pendingDisconnected).toBe(false)
      expect(room.participants.has(participantId)).toBe(true)
      expect(room.pendingConnections.size).toBe(1)
    })

    it('a presenter cannot resolve or message the other room\'s help request', async () => {
      const inA = await connectClient()
      const { participantId } = await join(inA, 'Ada') as { participantId: string }
      inA.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))
      const errorId = room.errorReports.find(e => e.participantId === participantId)!.id

      const presenterB = await connectClientInRoom(ROOM_B_CODE)
      presenterB.emit('presenter:resolveError', { errorId, presenterCode: PRESENTER_B_CODE, message: 'not yours' })
      presenterB.emit('presenter:sendMessage', { errorId, presenterCode: PRESENTER_B_CODE, text: 'not yours either' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      const report = room.errorReports.find(e => e.id === errorId)!
      expect(report.status).toBe('open')
      expect(report.thread).toEqual([])
      expect(roomB.errorReports).toEqual([])
    })

    it('the /dashboard HTTP route is gated per room', async () => {
      // No room parameter → the boot session, exactly as before 032a.
      expect((await fetch(`${url}/dashboard?code=${TEST_PRESENTER_CODE}`)).status).toBe(200)

      // Room B needs room B's code; room A's is a 401 there, and vice versa.
      expect((await fetch(`${url}/dashboard?roomCode=${ROOM_B_CODE}&code=${PRESENTER_B_CODE}`)).status).toBe(200)
      expect((await fetch(`${url}/dashboard?roomCode=${ROOM_B_CODE}&code=${TEST_PRESENTER_CODE}`)).status).toBe(401)
      expect((await fetch(`${url}/dashboard?roomCode=${TEST_ROOM_CODE}&code=${PRESENTER_B_CODE}`)).status).toBe(401)

      // An unknown room is a 401 with the same body as a wrong code — a
      // caller learns nothing about which rooms exist, and there is no path
      // where an unresolvable room means "let it through".
      const unknown = await fetch(`${url}/dashboard?roomCode=no-such-room&code=${TEST_PRESENTER_CODE}`)
      expect(unknown.status).toBe(401)
      expect(await unknown.text()).toContain('Presenter code required')
    })

    it('screenshot uploads land in their own room\'s feed and are served from its own directory', async () => {
      const inB = await connectClientInRoom(ROOM_B_CODE)
      const { participantId } = await joinRoomB(inB, 'Bob') as { participantId: string }

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })
      expect(response.status).toBe(201)
      const body = await response.json() as { id: string, screenshotUrl: string }

      // The report is in room B's feed, and room A's is untouched.
      expect(roomB.errorReports.map(e => e.id)).toEqual([body.id])
      expect(room.errorReports).toEqual([])

      // The served path carries room B's own uploads directory name — the
      // server-generated `mkdtemp` suffix, never the room code, so serving a
      // screenshot leaks no credential.
      expect(body.screenshotUrl).toBe(`/uploads/${roomB.uploadsDirName}/${body.screenshotUrl.split('/').pop()}`)
      expect(body.screenshotUrl).not.toContain(ROOM_B_CODE)
      const image = await fetch(`${url}${body.screenshotUrl}`)
      expect(image.status).toBe(200)
      expect(Buffer.from(await image.arrayBuffer())).toEqual(ONE_PIXEL_PNG)

      // The same filename under the *other* room's directory is a 404 — the
      // per-room directories are real isolation, not just a naming scheme.
      const filename = body.screenshotUrl.split('/').pop()
      const crossRoom = await fetch(`${url}/uploads/${room.uploadsDirName}/${filename}`)
      expect(crossRoom.status).toBe(404)
    })

    it('rejects an /uploads request naming a directory that is not a live room, or a bad filename inside a real one', async () => {
      // The room segment is matched against live rooms' own `uploadsDirName`
      // rather than merely pattern-checked, so a directory belonging to no
      // session — or to one that has been destroyed — is a 404 rather than a
      // filesystem probe.
      const unknownRoom = await fetch(`${url}/uploads/room-nonexistent/4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.png`)
      expect(unknownRoom.status).toBe(404)

      // A real room directory, but a filename that doesn't match the
      // server's own `${randomUUID()}.${ext}` naming scheme — rejected by
      // `resolveUploadPath` before sirv ever touches the filesystem.
      const badFilename = await fetch(`${url}/uploads/${roomB.uploadsDirName}/not-a-uuid.png`)
      expect(badFilename.status).toBe(404)

      const destroyedRoom = server.createSession().room
      server.destroySession(destroyedRoom.roomCode)
      const gone = await fetch(`${url}/uploads/${destroyedRoom.uploadsDirName}/4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.png`)
      expect(gone.status).toBe(404)
    })

    it('an upload whose room directory has vanished fails cleanly instead of recording a report pointing at nothing', async () => {
      const inB = await connectClientInRoom(ROOM_B_CODE)
      const { participantId } = await joinRoomB(inB, 'Bob') as { participantId: string }

      // Removing the room's uploads directory out from under the handler is
      // the only practical way to make the staging→room `rename` fail. What
      // matters is the *shape* of the failure: no report is appended, so the
      // dashboard never renders a broken screenshot thumbnail.
      rmSync(roomB.uploadsDir, { recursive: true, force: true })

      const form = new FormData()
      form.set('participantId', participantId)
      form.set('stepId', 'install-deps')
      form.set('screenshot', new Blob([ONE_PIXEL_PNG], { type: 'image/png' }), 'shot.png')

      const response = await fetch(`${url}/api/screenshot`, { method: 'POST', body: form })

      expect(response.status).toBe(500)
      expect(await response.text()).toContain('could not store the uploaded screenshot')
      expect(roomB.errorReports).toEqual([])
    })

    // Plan 032a wires the `dashboard:home` room and its broadcast so 032b can
    // build the cross-room home view without reopening this refactor. What's
    // asserted here is the seam itself: the payload shape, and that creating
    // or destroying a session is what moves it. See `HOME_DASHBOARD_ROOM`'s
    // own doc comment for why nothing *joins* that room yet — the credential
    // gating a cross-room view is deliberately 032b's decision, and until it
    // exists the room is empty and the broadcast is a no-op on the wire.
    describe('dashboard:home feed (the 032b seam)', () => {
      it('summarizes every live session without leaking any presenter code', () => {
        const { sessions } = buildHomeUpdate()

        expect(sessions.map(s => s.roomCode).sort()).toEqual([ROOM_B_CODE, TEST_ROOM_CODE].sort())
        // A summary, not the rooms themselves — no presenter codes, no
        // participant names, no help-request text. One subscription must not
        // be equivalent to N dashboards.
        expect(JSON.stringify(sessions)).not.toContain(TEST_PRESENTER_CODE)
        expect(JSON.stringify(sessions)).not.toContain(PRESENTER_B_CODE)
        expect(Object.keys(sessions[0]).sort()).toEqual([
          'connectedCount',
          'createdAt',
          'currentSlideIndex',
          'currentStepId',
          'deckUrl',
          'openHelpRequestCount',
          'participantCount',
          'roomCode',
        ])
      })

      it('reflects roster and help-request activity per session', async () => {
        const inB = await connectClientInRoom(ROOM_B_CODE)
        await joinRoomB(inB, 'Bob')
        inB.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
        await new Promise<void>(resolve => setTimeout(resolve, 50))

        const summaryB = buildHomeUpdate().sessions.find(s => s.roomCode === ROOM_B_CODE)!
        const summaryA = buildHomeUpdate().sessions.find(s => s.roomCode === TEST_ROOM_CODE)!

        expect(summaryB.participantCount).toBe(1)
        expect(summaryB.connectedCount).toBe(1)
        expect(summaryB.openHelpRequestCount).toBe(1)
        expect(summaryA.participantCount).toBe(0)
        expect(summaryA.openHelpRequestCount).toBe(0)
      })

      it('creating and destroying a session through the server\'s own seam moves the feed', () => {
        const { roomCode } = server.createSession({ deckUrl: 'http://another-deck.test' })

        expect(buildHomeUpdate().sessions.map(s => s.roomCode)).toContain(roomCode)
        expect(buildHomeUpdate().sessions.find(s => s.roomCode === roomCode)?.deckUrl).toBe('http://another-deck.test')

        expect(server.destroySession(roomCode)).toBe(true)
        expect(buildHomeUpdate().sessions.map(s => s.roomCode)).not.toContain(roomCode)
        // Destroying one leaves the others alone.
        expect(buildHomeUpdate().sessions.map(s => s.roomCode).sort()).toEqual([ROOM_B_CODE, TEST_ROOM_CODE].sort())
        expect(server.destroySession(roomCode)).toBe(false)
      })

      it('a new session inherits the server\'s deck URL unless the caller overrides it', () => {
        const { room: inherited } = server.createSession()

        expect(inherited.deckUrl).toBe(DEFAULT_DECK_URL)
      })
    })
  })

  // Plan 032d — Flow B: a deck someone is already running registers *itself*
  // into this server using a one-time, server-minted connect key. Both routes
  // are exercised over plain `fetch`, deliberately: they must be independently
  // usable with `curl` alone, with no `/home` dashboard UI wired to them (032b
  // is a separate, parallel workstream).
  //
  // This block stands up its own server (the pattern the join-link tests above
  // established) because the shared one from the outer `beforeEach` has no
  // admin code configured — which is itself the fail-closed default, asserted
  // as its own case below.
  describe('connect-key registration (032d)', () => {
    const TEST_ADMIN_CODE = 'admin-secret'
    const DECK = 'http://registered-deck.test:3030'

    beforeEach(async () => {
      resetConnectKeyStateForTests()
      await stopServer()
      resetSessionStateForTests()
      await startServer({
        roomCode: TEST_ROOM_CODE,
        presenterCode: TEST_PRESENTER_CODE,
        adminCode: TEST_ADMIN_CODE,
      })
    })

    async function mintKey(): Promise<string> {
      const response = await fetch(`${url}/api/connect-key`, {
        method: 'POST',
        headers: { 'x-muan-companion-admin-code': TEST_ADMIN_CODE },
      })
      expect(response.status).toBe(201)
      return (await response.json() as { key: string }).key
    }

    function register(body: unknown) {
      return fetch(`${url}/api/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    }

    // A local copy of the multi-room block's own `connectClientInRoom` — that
    // one is scoped to its describe, and a registered session is only
    // reachable by naming its room in the handshake query
    // (`ROOM_CODE_QUERY_PARAM`), which is exactly the point of the isolation
    // test below.
    function connectInRoom(roomCode: string): Promise<ClientSocket> {
      const socket = ioClient(url, { forceNew: true, transports: ['websocket'], query: { roomCode } })
      clients.push(socket)
      return new Promise((resolve, reject) => {
        socket.once('connect', () => resolve(socket))
        socket.once('connect_error', reject)
      })
    }

    describe('post /api/connect-key (admin-gated)', () => {
      it('mints a key with an expiry for a caller holding the admin code', async () => {
        const before = Date.now()
        const response = await fetch(`${url}/api/connect-key`, {
          method: 'POST',
          headers: { 'x-muan-companion-admin-code': TEST_ADMIN_CODE },
        })

        expect(response.status).toBe(201)
        const body = await response.json() as { key: string, expiresAt: number }
        expect(body.key).toMatch(/^[A-HJKMNP-Z2-9]{12}$/)
        expect(body.expiresAt).toBeGreaterThanOrEqual(before + CONNECT_KEY_TTL_MS)
      })

      // The curl-friendly fallback carrier — see `ADMIN_CODE_HEADER`'s doc
      // comment for why both are accepted and why the header is preferred.
      it('also accepts the admin code as a ?code= query param', async () => {
        const response = await fetch(`${url}/api/connect-key?code=${TEST_ADMIN_CODE}`, { method: 'POST' })

        expect(response.status).toBe(201)
      })

      it('rejects a caller with no admin code at all', async () => {
        const response = await fetch(`${url}/api/connect-key`, { method: 'POST' })

        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({ error: 'not authorized' })
      })

      it('rejects a wrong admin code with the identical body as a missing one', async () => {
        const wrong = await fetch(`${url}/api/connect-key`, {
          method: 'POST',
          headers: { 'x-muan-companion-admin-code': 'guess' },
        })
        const missing = await fetch(`${url}/api/connect-key`, { method: 'POST' })

        expect(wrong.status).toBe(missing.status)
        expect(await wrong.text()).toBe(await missing.text())
      })

      // The presenter code is *not* the admin code. A cross-room action must
      // not be reachable with a single room's credential — 032a's
      // `HOME_DASHBOARD_ROOM` comment states this requirement directly.
      it('does not accept a room or presenter code in place of the admin code', async () => {
        for (const code of [TEST_PRESENTER_CODE, TEST_ROOM_CODE]) {
          const response = await fetch(`${url}/api/connect-key`, {
            method: 'POST',
            headers: { 'x-muan-companion-admin-code': code },
          })
          expect(response.status).toBe(401)
        }
      })

      // Fail closed, never open, when no admin code is configured — the same
      // posture `auth.ts` takes for an unset room/presenter code.
      it('is unreachable on a server with no admin code configured', async () => {
        await stopServer()
        resetSessionStateForTests()
        await startServer({ roomCode: TEST_ROOM_CODE, presenterCode: TEST_PRESENTER_CODE })

        const empty = await fetch(`${url}/api/connect-key`, {
          method: 'POST',
          headers: { 'x-muan-companion-admin-code': '' },
        })
        const anything = await fetch(`${url}/api/connect-key?code=anything`, { method: 'POST' })

        expect(empty.status).toBe(401)
        expect(anything.status).toBe(401)
      })

      // An unauthorized caller must never reach `mintConnectKey` — a key
      // minted and then discarded would still be redeemable. Verified by the
      // fact that a rejected mint leaves nothing behind that a later
      // registration could use.
      it('mints nothing when the admin gate rejects', async () => {
        await fetch(`${url}/api/connect-key`, { method: 'POST' })
        const key = await mintKey()

        // The one key that exists is the one the *authorized* call returned;
        // registering with it succeeds exactly once, so no second key was
        // silently minted by the rejected call.
        expect((await register({ connectKey: key, deckUrl: DECK })).status).toBe(201)
        expect((await register({ connectKey: key, deckUrl: DECK })).status).toBe(400)
      })

      it('falls through to 404 for a GET (this route is POST-only)', async () => {
        const response = await fetch(`${url}/api/connect-key?code=${TEST_ADMIN_CODE}`)

        expect(response.status).toBe(404)
      })
    })

    describe('post /api/register (connect-key gated)', () => {
      it('creates a real, isolated session and returns its codes and URLs', async () => {
        const key = await mintKey()

        const response = await register({ connectKey: key, deckUrl: DECK })

        expect(response.status).toBe(201)
        const body = await response.json() as {
          roomCode: string
          presenterCode: string
          presenterUrl: string
          participantUrl: string
        }

        // A genuinely new session, not the boot one re-labelled.
        expect(body.roomCode).not.toBe(TEST_ROOM_CODE)
        expect(body.presenterCode).not.toBe(TEST_PRESENTER_CODE)
        // Codes it generated for itself, at the same lengths every other
        // session gets — the caller never got to choose them.
        expect(body.roomCode).toMatch(/^[A-HJKMNP-Z2-9]{8}$/)
        expect(body.presenterCode).toMatch(/^[A-HJKMNP-Z2-9]{10}$/)
        // Exactly the shapes `buildJoinUrl`/`buildPresenterUrl` produce — the
        // same helpers every other surface in this package uses.
        expect(body.participantUrl).toBe(buildJoinUrl(DECK, body.roomCode))
        expect(body.presenterUrl).toBe(buildPresenterUrl(DECK, body.presenterCode))
        expect(body.presenterUrl).toBe(`${DECK}/presenter/1?code=${encodeURIComponent(body.presenterCode)}`)
      })

      it('registers the session in rooms with the supplied deck URL, isolated from the boot session', async () => {
        const key = await mintKey()
        const body = await (await register({ connectKey: key, deckUrl: DECK })).json() as { roomCode: string }

        const registered = getRoom(body.roomCode)!
        expect(registered.deckUrl).toBe(DECK)
        expect(registered.participants.size).toBe(0)
        // The boot session is untouched — a registration adds a room, it never
        // mutates an existing one.
        expect(getRoom(TEST_ROOM_CODE)!.deckUrl).toBe(DEFAULT_DECK_URL)
      })

      // The one seam 032a built for this: a session created over HTTP must be
      // visible to a home view exactly like one created through the server's
      // own `createSession`, without this handler arranging it.
      it('makes the new session appear in the home feed', async () => {
        const key = await mintKey()
        const body = await (await register({ connectKey: key, deckUrl: DECK })).json() as { roomCode: string }

        const summary = buildHomeUpdate().sessions.find(s => s.roomCode === body.roomCode)
        expect(summary).toBeDefined()
        expect(summary!.deckUrl).toBe(DECK)
      })

      // The other half of that seam: not just that `buildHomeUpdate` would
      // *report* the session, but that registering actually pushes a
      // `home:update` on the wire, so an already-open home view sees the deck
      // appear live (proposal Flow B step 4) rather than only on its next
      // reload.
      //
      // 032b owns the `dashboard:home` *join handler* and its gate (see
      // `HOME_DASHBOARD_ROOM`'s own comment on why that's deliberately its
      // decision, not 032a's or this one's), so nothing joins that room yet.
      // This test therefore joins it server-side by hand — standing in for
      // whatever credential check 032b lands — which is what makes the
      // broadcast observable today without pre-empting that decision.
      it('pushes home:update to a subscribed home socket when a deck registers', async () => {
        const home = await connectClient()
        server.io.sockets.sockets.get(home.id!)!.join(HOME_DASHBOARD_ROOM)
        const update = waitFor<{ sessions: { roomCode: string, deckUrl: string }[] }>(home, 'home:update')
        const key = await mintKey()

        const response = await register({ connectKey: key, deckUrl: DECK })
        expect(response.status).toBe(201)
        const { roomCode } = await response.json() as { roomCode: string }

        const payload = await update
        expect(payload.sessions.find(s => s.roomCode === roomCode)?.deckUrl).toBe(DECK)
      })

      it('the registered session actually works — a participant can join it with its own codes', async () => {
        const key = await mintKey()
        const body = await (await register({ connectKey: key, deckUrl: DECK })).json() as {
          roomCode: string
          presenterCode: string
        }

        const client = await connectInRoom(body.roomCode)
        const ack = await emitWithAck<{ participantId?: string, error?: string }>(
          client,
          'participant:join',
          { name: 'Ada', roomCode: body.roomCode },
        )

        expect(ack.participantId).toBeTruthy()
        // And the *boot* session's room code is worthless against it — real
        // isolation, not a shared namespace.
        const wrongCode = await connectInRoom(body.roomCode)
        const rejected = await emitWithAck<{ error?: string }>(
          wrongCode,
          'participant:join',
          { name: 'Eve', roomCode: TEST_ROOM_CODE },
        )
        expect(rejected.error).toBeTruthy()
      })

      it('refuses a key that has already been redeemed, without creating a second session', async () => {
        const key = await mintKey()
        const first = await register({ connectKey: key, deckUrl: DECK })
        expect(first.status).toBe(201)
        const roomsAfterFirst = buildHomeUpdate().sessions.length

        const second = await register({ connectKey: key, deckUrl: DECK })

        expect(second.status).toBe(400)
        expect(await second.json()).toEqual({ error: 'registration failed' })
        expect(buildHomeUpdate().sessions).toHaveLength(roomsAfterFirst)
      })

      it('refuses a key that was never minted', async () => {
        const response = await register({ connectKey: 'NEVERMINTED9', deckUrl: DECK })

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'registration failed' })
      })

      it('refuses a missing or non-string connectKey', async () => {
        for (const body of [{ deckUrl: DECK }, { connectKey: 42, deckUrl: DECK }, { connectKey: null, deckUrl: DECK }]) {
          const response = await register(body)
          expect(response.status).toBe(400)
        }
      })

      // "Reveal nothing extra" (see `REGISTRATION_FAILED_BODY`): a caller must
      // not be able to tell a valid-key-bad-URL failure from a bad-key
      // failure, or either from a malformed body — otherwise the endpoint is a
      // key oracle.
      it('returns byte-identical failures for a bad key, a bad deck URL, and a malformed body', async () => {
        const key = await mintKey()
        const badUrl = await register({ connectKey: key, deckUrl: 'not a url' })
        const badKey = await register({ connectKey: 'NEVERMINTED9', deckUrl: DECK })
        const malformed = await register('{ not json')

        expect(badUrl.status).toBe(400)
        expect(badKey.status).toBe(400)
        expect(malformed.status).toBe(400)
        const bodies = [await badUrl.text(), await badKey.text(), await malformed.text()]
        expect(new Set(bodies).size).toBe(1)
      })

      // Operator ergonomics, and the reason `deckUrl` is validated before the
      // key is consumed: a typo'd URL must not silently burn a good key.
      it('does not burn the key when the deck URL is rejected', async () => {
        const key = await mintKey()
        expect((await register({ connectKey: key, deckUrl: 'not a url' })).status).toBe(400)

        expect((await register({ connectKey: key, deckUrl: DECK })).status).toBe(201)
      })

      it('rejects deck URLs that are not well-formed absolute http(s) URLs', async () => {
        const rejected = [
          'not a url',
          '/relative/path',
          'localhost:3030',
          // Schemes that would be a genuine attack once rendered as a link or
          // encoded into a projected QR code — an allowlist, not a denylist.
          'javascript:alert(1)',
          'data:text/html,<script>alert(1)</script>',
          'file:///etc/passwd',
          // Embedded credentials — the classic look-alike-link trick.
          'http://evil@trusted.example',
          // A fragment would land *before* `?roomCode=`, silently producing a
          // join link whose query the deck never sees.
          'http://deck.test:3030#/1',
          '',
        ]

        for (const deckUrl of rejected) {
          // Reset between cases: this list is longer than `MAX_FAILED_ATTEMPTS`
          // and every entry is a genuine failure, so without this the rate
          // limiter (correctly) locks this source out partway through and the
          // remaining URLs would be "rejected" for the wrong reason. Resetting
          // keeps each assertion about `normalizeDeckUrl` alone.
          resetConnectKeyStateForTests()
          const key = await mintKey()
          const response = await register({ connectKey: key, deckUrl })
          expect(response.status, `expected ${JSON.stringify(deckUrl)} to be rejected`).toBe(400)
        }
      })

      it('rejects an absurdly long deck URL rather than storing it', async () => {
        const key = await mintKey()
        const response = await register({ connectKey: key, deckUrl: `http://deck.test/${'a'.repeat(4000)}` })

        expect(response.status).toBe(400)
      })

      it('rejects a body larger than the read cap', async () => {
        const key = await mintKey()
        const response = await register({ connectKey: key, deckUrl: DECK, padding: 'x'.repeat(8192) })

        expect(response.status).toBe(400)
      })

      it('rejects a JSON body that is not an object', async () => {
        for (const raw of ['null', '[]', '"a string"', '42']) {
          const response = await register(raw)
          expect(response.status).toBe(400)
        }
      })

      // Normalization (see `normalizeDeckUrl`): every session's links come out
      // in the same shape no matter how the operator typed the URL, so
      // `buildJoinUrl`'s bare concatenation never produces `host/?roomCode=`.
      it('normalizes a trailing slash off the deck URL before storing it', async () => {
        const key = await mintKey()
        const body = await (await register({ connectKey: key, deckUrl: `${DECK}/` })).json() as {
          roomCode: string
          participantUrl: string
        }

        expect(getRoom(body.roomCode)!.deckUrl).toBe(DECK)
        expect(body.participantUrl).toBe(`${DECK}?roomCode=${encodeURIComponent(body.roomCode)}`)
      })

      it('accepts an https deck URL with a path and query intact', async () => {
        const key = await mintKey()
        const deckUrl = 'https://decks.example/workshop?theme=dark'
        const body = await (await register({ connectKey: key, deckUrl })).json() as { roomCode: string }

        expect(getRoom(body.roomCode)!.deckUrl).toBe(deckUrl)
      })

      it('falls through to 404 for a GET (this route is POST-only)', async () => {
        const response = await fetch(`${url}/api/register`)

        expect(response.status).toBe(404)
      })
    })

    describe('rate limiting (032d — the new credential-free-ish surface)', () => {
      it('locks a source out after repeated failed attempts, then refuses even a valid key', async () => {
        const key = await mintKey()

        for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
          const response = await register({ connectKey: 'WRONGKEY1234', deckUrl: DECK })
          expect(response.status).toBe(400)
        }

        const locked = await register({ connectKey: key, deckUrl: DECK })

        expect(locked.status).toBe(429)
        expect(await locked.json()).toEqual({ error: 'too many attempts, try again shortly' })
        // A locked-out request does no work at all — the valid key it carried
        // was not consumed, and no session was created.
        expect(buildHomeUpdate().sessions).toHaveLength(1)
      })

      it('counts malformed bodies toward the lockout, not only bad keys', async () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++)
          expect((await register('{ not json')).status).toBe(400)

        expect((await register({ connectKey: await mintKey(), deckUrl: DECK })).status).toBe(429)
      })

      it('does not lock out a source that stays under the threshold', async () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++)
          expect((await register({ connectKey: 'WRONGKEY1234', deckUrl: DECK })).status).toBe(400)

        expect((await register({ connectKey: await mintKey(), deckUrl: DECK })).status).toBe(201)
      })

      it('clears a source failure history on a successful registration', async () => {
        for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++)
          await register({ connectKey: 'WRONGKEY1234', deckUrl: DECK })
        expect((await register({ connectKey: await mintKey(), deckUrl: DECK })).status).toBe(201)

        // Fresh budget: the pre-success failures no longer count, so another
        // near-threshold run still doesn't lock this source out.
        for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++)
          expect((await register({ connectKey: 'WRONGKEY1234', deckUrl: DECK })).status).toBe(400)
        expect((await register({ connectKey: await mintKey(), deckUrl: DECK })).status).toBe(201)
      })
    })
  })
})
