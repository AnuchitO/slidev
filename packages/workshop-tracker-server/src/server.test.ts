import type { AddressInfo } from 'node:net'
import type { Socket as ClientSocket } from 'socket.io-client'
import type { WorkshopTrackerServer } from './server'
import { Buffer } from 'node:buffer'
import { io as ioClient } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkshopTrackerServer } from './server'
import { errorReports, participants, resetSessionStateForTests, session, stepStatus } from './session'

// A minimal, valid 1x1 PNG (the smallest real PNG that decodes) — used as
// the multipart `screenshot` file in the upload tests below so they exercise
// real bytes through Busboy's file stream rather than an empty/fake blob.
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

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
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const presenter = await connectClient()
      const update = waitFor<{ currentStepId: string }>(dashboard, 'state:update')
      presenter.emit('presenter:setStep', { stepId: 'install-deps' })
      const payload = await update

      expect(payload.currentStepId).toBe('install-deps')
    })

    it('presenter:setSlide alone does not change currentStepId', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const presenter = await connectClient()
      presenter.emit('presenter:setStep', { stepId: 'install-deps' })
      await waitForMatchingStateUpdate<{ currentStepId: string }>(dashboard, p => p.currentStepId === 'install-deps')

      const update = waitFor<{ currentSlideIndex: number, currentStepId: string }>(dashboard, 'state:update')
      presenter.emit('presenter:setSlide', { index: 7 })
      const payload = await update

      expect(payload.currentSlideIndex).toBe(7)
      expect(payload.currentStepId).toBe('install-deps')
    })
  })

  describe('error reports (M3)', () => {
    async function join(client: ClientSocket, name = 'Ada') {
      return emitWithAck<{ participantId: string }>(client, 'participant:join', { name })
    }

    it('participant:error (text-only) creates an ErrorReport and broadcasts it to the dashboard', async () => {
      const client = await connectClient()
      const { participantId } = await join(client)

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const update = waitForMatchingStateUpdate<{ errors: Array<{ participantId: string, stepId: string, text?: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      client.emit('participant:error', { stepId: 'install-deps', text: 'npm install failed' })
      const payload = await update

      expect(payload.errors).toContainEqual(
        expect.objectContaining({ participantId, stepId: 'install-deps', text: 'npm install failed', resolved: false }),
      )
      expect(errorReports).toHaveLength(1)
    })

    it('ignores participant:error from a socket that has not joined yet', async () => {
      const client = await connectClient()

      client.emit('participant:error', { stepId: 'install-deps', text: 'hello' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(errorReports).toHaveLength(0)
    })

    it('presenter:resolveError marks a report resolved and broadcasts the update', async () => {
      const client = await connectClient()
      const { participantId } = await join(client)

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const created = waitForMatchingStateUpdate<{ errors: Array<{ id: string, participantId: string }> }>(
        dashboard,
        payload => payload.errors.some(e => e.participantId === participantId),
      )
      client.emit('participant:error', { stepId: 'install-deps', text: 'broken' })
      const { errors } = await created
      const errorId = errors[0].id

      const presenter = await connectClient()
      const resolved = waitForMatchingStateUpdate<{ errors: Array<{ id: string, resolved: boolean }> }>(
        dashboard,
        payload => payload.errors.some(e => e.id === errorId && e.resolved),
      )
      presenter.emit('presenter:resolveError', { errorId })
      const resolvedPayload = await resolved

      expect(resolvedPayload.errors.find(e => e.id === errorId)?.resolved).toBe(true)
      expect(errorReports.find(e => e.id === errorId)?.resolved).toBe(true)
    })

    it('presenter:resolveError on an unknown id is a no-op (no crash, no broadcast storm)', async () => {
      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
      await initialSnapshot

      const presenter = await connectClient()
      presenter.emit('presenter:resolveError', { errorId: 'does-not-exist' })
      await new Promise<void>(resolve => setTimeout(resolve, 50))

      expect(errorReports).toHaveLength(0)
    })
  })

  describe('post /api/screenshot (M3)', () => {
    it('accepts a valid multipart upload, creates an ErrorReport, and broadcasts state:update', async () => {
      const client = await connectClient()
      const { participantId } = await emitWithAck<{ participantId: string }>(
        client,
        'participant:join',
        { name: 'Ada' },
      )

      const dashboard = await connectClient()
      const initialSnapshot = waitFor(dashboard, 'state:update')
      dashboard.emit('dashboard:join')
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
        { name: 'Ada' },
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
        { name: 'Ada' },
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
        { name: 'Ada' },
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
})
