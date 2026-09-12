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
