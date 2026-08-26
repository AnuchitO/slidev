import type { AddressInfo } from 'node:net'
import type { Socket as ClientSocket } from 'socket.io-client'
import type { WorkshopTrackerServer } from './server'
import { io as ioClient } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkshopTrackerServer } from './server'
import { participants, resetSessionStateForTests, session, stepStatus } from './session'

// Plan 029 (M4): every test below that exercises `participant:join`,
// `presenter:*`, or `dashboard:join` now has to supply the matching code —
// these are deliberately different strings (see `auth.ts`'s own comment on
// why room code and presenter code must never be conflated into one shared
// secret) so a test that accidentally used the wrong one for a surface would
// fail loudly rather than silently pass.
const TEST_ROOM_CODE = 'room-secret'
const TEST_PRESENTER_CODE = 'presenter-secret'

describe('createWorkshopTrackerServer', () => {
  let server: WorkshopTrackerServer
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
    server = createWorkshopTrackerServer({ roomCode: TEST_ROOM_CODE, presenterCode: TEST_PRESENTER_CODE })
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

      expect(ack).toEqual({ ok: true })
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
      const secondAck = await emitWithAck<{ participantId: string }>(
        second,
        'participant:join',
        { name: 'Ada', participantId: firstAck.participantId, roomCode: TEST_ROOM_CODE },
      )

      expect(secondAck.participantId).toBe(firstAck.participantId)
      expect(participants.size).toBe(1)
    })

    it('mints a fresh id when a client-supplied participantId is unknown to the server', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', participantId: 'guessed-id-from-a-different-server-run', roomCode: TEST_ROOM_CODE },
      )

      expect(ack.participantId).not.toBe('guessed-id-from-a-different-server-run')
      expect(participants.size).toBe(1)
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
      expect(stepStatus.get(`${participantId}:install-deps`)).toBe('copied')
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
      expect(stepStatus.get(`${participantId}:install-deps`)).toBe('done')
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
      server = createWorkshopTrackerServer({
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

      const update = waitForMatchingStateUpdate<{ stepStatus: Array<{ participantId: string, stepId: string, state: string }> }>(
        dashboard,
        payload => payload.stepStatus.some(s => s.participantId === participantId && s.stepId === 'install-deps'),
      )
      participant.emit('participant:copy', { stepId: 'install-deps' })
      const payload = await update

      expect(payload.stepStatus).toContainEqual({ participantId, stepId: 'install-deps', state: 'copied' })

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
})
