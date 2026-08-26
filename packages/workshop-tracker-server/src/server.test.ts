import type { AddressInfo } from 'node:net'
import type { Socket as ClientSocket } from 'socket.io-client'
import type { WorkshopTrackerServer } from './server'
import { io as ioClient } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkshopTrackerServer } from './server'
import { participants, resetSessionStateForTests, session, stepStatus } from './session'

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
    const socket = ioClient(url, { forceNew: true })
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

  beforeEach(async () => {
    resetSessionStateForTests()
    server = createWorkshopTrackerServer()
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

    presenter.emit('presenter:setSlide', { index: 2 })

    await expect(changed).resolves.toEqual({ index: 2 })
  })

  it('updates the in-memory session so late joiners land on the current slide', async () => {
    const presenter = await connectClient()
    presenter.emit('presenter:setSlide', { index: 5 })

    // Give the server a tick to process the event and mutate session state.
    await new Promise<void>(resolve => setTimeout(resolve, 50))

    const lateJoiner = newClient()
    const payload = await waitFor<{ index: number }>(lateJoiner, 'slide:sync')

    expect(payload).toEqual({ index: 5 })
  })

  describe('participant registry (M2)', () => {
    it('assigns a stable id on participant:join and acks the current slide index', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ participantId: string, currentSlideIndex: number }>(
        client,
        'participant:join',
        { name: 'Ada' },
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
        { name: 'Ada' },
      )

      const second = await connectClient()
      const secondAck = await emitWithAck<{ participantId: string }>(
        second,
        'participant:join',
        { name: 'Ada', participantId: firstAck.participantId },
      )

      expect(secondAck.participantId).toBe(firstAck.participantId)
      expect(participants.size).toBe(1)
    })

    it('mints a fresh id when a client-supplied participantId is unknown to the server', async () => {
      const client = await connectClient()

      const ack = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada', participantId: 'guessed-id-from-a-different-server-run' },
      )

      expect(ack.participantId).not.toBe('guessed-id-from-a-different-server-run')
      expect(participants.size).toBe(1)
    })
  })

  describe('step status (M2)', () => {
    async function join(client: ClientSocket, name = 'Ada') {
      return emitWithAck<{ participantId: string }>(client, 'participant:join', { name })
    }

    it('participant:copy marks the step copied and acks the caller', async () => {
      const client = await connectClient()
      const { participantId } = await join(client)

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
      const { participantId } = await join(client)

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

  describe('dashboard broadcast (M2)', () => {
    it('sends an immediate state:update snapshot to a socket that joins the dashboard room', async () => {
      const client = await connectClient()
      await emitWithAck(client, 'participant:join', { name: 'Ada' })

      const dashboard = await connectClient()
      const snapshotPromise = waitFor<{ participants: unknown[] }>(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      const snapshot = await snapshotPromise

      expect(snapshot.participants).toHaveLength(1)
    })

    it('broadcasts state:update to dashboard-joined sockets only, not to every connected client', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const bystander = await connectClient()
      let bystanderReceivedUpdate = false
      bystander.on('state:update', () => {
        bystanderReceivedUpdate = true
      })

      const participant = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        participant,
        'participant:join',
        { name: 'Ada' },
      )

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
    it('presenter:setSlide with a stepId is reflected in state:update as currentStepId', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const presenter = await connectClient()
      const update = waitFor<{ currentStepId: string }>(dashboard, 'state:update')
      presenter.emit('presenter:setSlide', { index: 2, stepId: 'install-deps' })
      const payload = await update

      expect(payload.currentStepId).toBe('install-deps')
    })

    it('falls back to the slide index as the stepId when presenter:setSlide omits it', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const presenter = await connectClient()
      const update = waitFor<{ currentStepId: string }>(dashboard, 'state:update')
      presenter.emit('presenter:setSlide', { index: 4 })
      const payload = await update

      expect(payload.currentStepId).toBe('4')
    })
  })
})
