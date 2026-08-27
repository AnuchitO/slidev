import type { AddressInfo } from 'node:net'
import type { Socket as ClientSocket } from 'socket.io-client'
import type { MuanCompanionServer } from './server'
import { Buffer } from 'node:buffer'
import { io as ioClient } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMuanCompanionServer } from './server'
import { errorReports, participants, resetSessionStateForTests, session, stepStatus } from './session'

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

  beforeEach(async () => {
    resetSessionStateForTests()
    server = createMuanCompanionServer({ roomCode: TEST_ROOM_CODE, presenterCode: TEST_PRESENTER_CODE })
    await new Promise<void>(resolve => server.httpServer.listen(0, resolve))
    const { port } = server.httpServer.address() as AddressInfo
    url = `http://localhost:${port}`
  })

  afterEach(async () => {
    for (const client of clients.splice(0))
      client.disconnect()
    server.io.close()
    await new Promise<void>(resolve => server.httpServer.close(() => resolve()))
  })

  it('sends the current slide index to a newly-connected client via slide:sync', async () => {
    session.currentSlideIndex = 3
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
      expect(participants.size).toBe(0)
    })

    it('rejects participant:join with a missing room code and does not create a participant', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ error: string } | { participantId: string }>(
        client,
        'participant:join',
        { name: 'Eve' },
      )

      expect(ack).toEqual({ error: 'invalid_room_code' })
      expect(participants.size).toBe(0)
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
        expect(participants.size).toBe(1)
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
        expect(participants.size).toBe(0)
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
      expect(session.currentSlideIndex).not.toBe(99)
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

      expect(session.currentSlideIndex).not.toBe(42)
    })

    it('ignores presenter:setStep with a wrong presenter code — currentStepId is untouched', async () => {
      const attacker = await connectClient()

      attacker.emit('presenter:setStep', { stepId: 'attacker-step', presenterCode: 'wrong-code' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(session.currentStepId).not.toBe('attacker-step')
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

      const ack = await emitWithAck<{ ok: boolean, roomCode?: string, presenterCode?: string }>(
        dashboard,
        'dashboard:join',
        { presenterCode: TEST_PRESENTER_CODE },
      )

      expect(ack).toEqual({ ok: true, roomCode: TEST_ROOM_CODE, presenterCode: TEST_PRESENTER_CODE })
    })

    it('a rejected dashboard:join does not leak either code', async () => {
      const dashboard = await connectClient()

      const ack = await emitWithAck<{ ok: boolean, roomCode?: string, presenterCode?: string }>(
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
      expect(participants.size).toBe(1)
      expect(participants.get(ack.participantId)?.name).toBe('Ada')
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
      expect(participants.size).toBe(1)
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
      expect(participants.size).toBe(1)
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

      expect(participants.get(firstAck.participantId)?.name).toBe('Ada')
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
      expect(stepStatus.get(`${participantId}:install-deps`)).toEqual({ state: 'copied', updatedAt: expect.any(Number) })
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
      expect(stepStatus.get(`${participantId}:install-deps`)).toEqual({ state: 'done', updatedAt: expect.any(Number) })
    })

    it('updatedAt refreshes on each state transition (copy, then done, are two different timestamps)', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }

      await emitWithAck(client, 'participant:copy', { stepId: 'install-deps' })
      const afterCopy = stepStatus.get(`${participantId}:install-deps`)!.updatedAt

      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await emitWithAck(client, 'participant:done', { stepId: 'install-deps' })
      const afterDone = stepStatus.get(`${participantId}:install-deps`)!.updatedAt

      expect(afterDone).toBeGreaterThan(afterCopy)
    })

    it('ignores participant:copy/done from a socket that has not joined yet', async () => {
      const client = await connectClient()

      client.emit('participant:copy', { stepId: 'install-deps' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(stepStatus.size).toBe(0)
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

      expect(participants.get(participantId)?.visibility).toBe('visible')
    })

    it('participant:heartbeat updates lastSeen without erroring for a joined participant', async () => {
      const client = await connectClient()
      const { participantId } = await join(client) as { participantId: string }
      const before = participants.get(participantId)!.lastSeen

      await new Promise<void>(resolve => setTimeout(resolve, 10))
      client.emit('participant:heartbeat', { stepId: 'install-deps' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(participants.get(participantId)!.lastSeen).toBeGreaterThan(before)
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
      expect(participants.get(participantId)?.connected).toBe(true)
      expect(participants.get(participantId)?.visibility).not.toBe('closed')

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
      await server.io.close()
      await new Promise<void>(resolve => server.httpServer.close(() => resolve()))
      server = createMuanCompanionServer({
        roomCode: TEST_ROOM_CODE,
        presenterCode: TEST_PRESENTER_CODE,
        sweepIntervalMs: 20,
      })
      await new Promise<void>(resolve => server.httpServer.listen(0, resolve))
      const { port } = server.httpServer.address() as AddressInfo
      url = `http://localhost:${port}`

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

      // Simulate a hung connection: the socket is force-closed at the
      // transport level (`io.engine` close, not a graceful client
      // `disconnect()`/server-side `socket.disconnect()`) so no clean
      // `disconnect` event fires, and back-date `lastSeen` past
      // `STALE_AFTER_MS` so the very next sweep tick sees it as stale.
      const serverSocket = [...server.io.sockets.sockets.values()].find(s => s.id === participant.id) ?? [...server.io.sockets.sockets.values()][0]
      participants.get(participantId)!.lastSeen = 0
      serverSocket?.conn.close()

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
      expect(errorReports).toHaveLength(1)
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

      expect(errorReports).toHaveLength(0)
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
      expect(errorReports.find(e => e.id === errorId)?.status).toBe('awaiting_confirmation')
    })

    it('presenter:resolveError on an unknown id is a no-op (no crash, no broadcast storm)', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join', { presenterCode: TEST_PRESENTER_CODE })
      await initialSnapshot

      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId: 'does-not-exist', presenterCode: TEST_PRESENTER_CODE })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(errorReports).toHaveLength(0)
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
      expect(errorReports.find(e => e.id === errorId)?.thread).toEqual([
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
      expect(errorReports.find(e => e.id === errorId)?.status).toBe('open')
      expect(errorReports.find(e => e.id === errorId)?.thread).toEqual([
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

      expect(errorReports.find(e => e.id === errorId)?.thread).toEqual([])
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
      expect(errorReports.find(e => e.id === errorId)?.thread.at(-1)).toEqual({ from: 'participant', text: 'yep, fixed!', ts: expect.any(Number) })
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

      expect(errorReports.find(e => e.id === errorId)?.status).toBe('open')
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
      expect(errorReports).toHaveLength(0)
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
      expect(errorReports).toHaveLength(0)
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
      expect(errorReports).toHaveLength(0)
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
      expect(errorReports).toHaveLength(0)
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
      await server.io.close()
      await new Promise<void>(resolve => server.httpServer.close(() => resolve()))
      server = createMuanCompanionServer({
        roomCode: TEST_ROOM_CODE,
        presenterCode: TEST_PRESENTER_CODE,
        origin: 'http://localhost:3030',
      })
      await new Promise<void>(resolve => server.httpServer.listen(0, resolve))
      const { port } = server.httpServer.address() as AddressInfo
      url = `http://localhost:${port}`

      const response = await fetch(`${url}/api/screenshot`, { method: 'OPTIONS' })

      expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:3030')
    })
  })
})
