import type { AddressInfo } from 'node:net'
import type { Socket as ClientSocket } from 'socket.io-client'
import type { WorkshopTrackerServer } from './server'
import { io as ioClient } from 'socket.io-client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWorkshopTrackerServer } from './server'
import { session } from './session'

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

  function connectClient(): Promise<ClientSocket> {
    const socket = newClient()
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve(socket))
      socket.once('connect_error', reject)
    })
  }

  beforeEach(async () => {
    session.currentSlideIndex = 1
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
})
