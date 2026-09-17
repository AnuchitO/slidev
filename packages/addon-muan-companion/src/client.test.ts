import { afterEach, describe, expect, it, vi } from 'vitest'

// `getWorkshopSocket()` calls `io(...)` with `autoConnect: true, reconnection:
// true` — against a real `socket.io-client`, that immediately attempts (and,
// on `reconnection: true`, keeps retrying) a real network connection, which
// would leave an open handle hanging past this test file's own lifetime and
// could fail outright in a sandboxed/offline test environment. Stubbing the
// module here keeps this test scoped to `client.ts`'s own memoization/URL
// logic, not socket.io's actual connection behavior.
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ id: 'stub-socket' })),
}))

describe('getMuanCompanionServerUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('falls back to the default localhost URL when the env var is unset', async () => {
    const { getMuanCompanionServerUrl } = await import('./client')
    expect(getMuanCompanionServerUrl()).toBe('http://localhost:3710')
  })

  it('uses VITE_SLIDEV_MUAN_COMPANION_SERVER_URL when it is set', async () => {
    vi.stubEnv('VITE_SLIDEV_MUAN_COMPANION_SERVER_URL', 'https://workshop.example.com')
    const { getMuanCompanionServerUrl } = await import('./client')
    expect(getMuanCompanionServerUrl()).toBe('https://workshop.example.com')
  })
})

describe('getWorkshopSocket', () => {
  it('memoizes a single socket instance across calls — see this module\'s own doc comment on why', async () => {
    const { getWorkshopSocket } = await import('./client')
    const first = getWorkshopSocket()
    const second = getWorkshopSocket()
    expect(second).toBe(first)
  })

  it('connects to getMuanCompanionServerUrl() with autoConnect and reconnection enabled', async () => {
    const { io } = await import('socket.io-client')
    const { getWorkshopSocket, getMuanCompanionServerUrl } = await import('./client')
    getWorkshopSocket()
    expect(io).toHaveBeenCalledWith(getMuanCompanionServerUrl(), { autoConnect: true, reconnection: true })
  })
})

// Bug found live: with no room hint in the Socket.io handshake at all, every
// socket from a deck that isn't `muan-companion-server`'s own *boot* session
// (every `POST /api/launch`/`POST /api/register` session) silently resolved
// to the boot session server-side — the presenter's own `presenter:setSlide`
// moved the wrong room's slide, and neither a participant's `participant:join`
// nor a dashboard's `dashboard:join` could ever succeed against the room they
// actually meant. See `server.ts`'s `buildPresenterUrl` and `ROOM_CODE_QUERY_
// PARAM` doc comments for the full incident this is the client-side half of.
//
// `vi.resetModules()` per test (unlike the `describe` above, which relies on
// module-level memoization *persisting* across its own two tests): each case
// here needs a *fresh* `client.ts` — its `socket` singleton is set on the
// very first `getWorkshopSocket()` call, so reusing a module instance across
// these tests would mean only the first one's `window.location.search` was
// ever actually read.
describe('getWorkshopSocket (room-code hint)', () => {
  afterEach(() => {
    vi.resetModules()
    delete (globalThis as { window?: unknown }).window
  })

  it('passes the URL\'s roomCode as the Socket.io handshake query', async () => {
    ;(globalThis as { window?: unknown }).window = { location: { search: '?roomCode=ABCD1234' } }
    vi.resetModules()
    const { io } = await import('socket.io-client')
    vi.mocked(io).mockClear()
    const { getWorkshopSocket, getMuanCompanionServerUrl } = await import('./client')

    getWorkshopSocket()

    expect(io).toHaveBeenCalledWith(getMuanCompanionServerUrl(), {
      autoConnect: true,
      reconnection: true,
      query: { roomCode: 'ABCD1234' },
    })
  })

  it('omits query entirely (not an empty roomCode) when the URL carries none', async () => {
    ;(globalThis as { window?: unknown }).window = { location: { search: '' } }
    vi.resetModules()
    const { io } = await import('socket.io-client')
    vi.mocked(io).mockClear()
    const { getWorkshopSocket, getMuanCompanionServerUrl } = await import('./client')

    getWorkshopSocket()

    // Not `{ query: { roomCode: undefined } }` or `{ query: {} }` — omitted
    // altogether, so the server's own "no hint → boot session" default runs
    // exactly as it did before this fix, for the one deployment (a
    // single-boot-session server, pre-032a-style) where that default is
    // already correct.
    expect(io).toHaveBeenCalledWith(getMuanCompanionServerUrl(), { autoConnect: true, reconnection: true })
  })
})
