import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { registerDeckIfConfigured, resetRegistrationStateForTests } from './register'

// Same reasoning as `client.test.ts`'s stub: `register.ts` imports
// `getMuanCompanionServerUrl` from `client.ts`, and importing that module for
// real would pull in `socket.io-client`. Nothing here touches the socket, but
// keeping the stub means this file can never accidentally open one.
vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({ id: 'stub-socket' })),
}))

const DECK_ORIGIN = 'http://localhost:3030'

function okResponse(body: unknown) {
  return { ok: true, status: 201, json: async () => body }
}

describe('registerDeckIfConfigured', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  // The console spies are held in variables rather than re-reached as
  // `console.info`/`console.error` at each assertion: this repo's lint config
  // forbids referencing `console.info` at all (`no-console` allows only
  // `warn`/`error`), and a captured spy reads better anyway.
  let infoSpy: ReturnType<typeof vi.spyOn>
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetRegistrationStateForTests()
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // jsdom's default origin — pinned explicitly so the assertions below
    // describe the contract ("this deck's own origin") rather than depending
    // on whatever the environment happens to serve.
    vi.spyOn(window, 'location', 'get').mockReturnValue({ origin: DECK_ORIGIN } as Location)
    infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  // The single most important property of this feature: every existing
  // deployment that hasn't opted in must be completely unaffected.
  describe('when VITE_SLIDEV_MUAN_COMPANION_CONNECT_KEY is unset', () => {
    it('is a complete no-op — no fetch at all', async () => {
      await registerDeckIfConfigured()

      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('logs nothing, at any severity', async () => {
      await registerDeckIfConfigured()

      expect(infoSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('treats an explicitly-empty env var the same as unset', async () => {
      vi.stubEnv('VITE_SLIDEV_MUAN_COMPANION_CONNECT_KEY', '')

      await registerDeckIfConfigured()

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('when a connect key is configured', () => {
    beforeEach(() => {
      vi.stubEnv('VITE_SLIDEV_MUAN_COMPANION_CONNECT_KEY', 'CONNECTKEY12')
    })

    it('posts the key and this deck\'s own origin to the server\'s /api/register', async () => {
      fetchMock.mockResolvedValue(okResponse({
        roomCode: 'ROOMCODE',
        presenterCode: 'PRESENTER1',
        presenterUrl: `${DECK_ORIGIN}/presenter/1?code=PRESENTER1`,
        participantUrl: `${DECK_ORIGIN}?roomCode=ROOMCODE`,
      }))

      await registerDeckIfConfigured()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [calledUrl, init] = fetchMock.mock.calls[0]
      // Default server URL, since `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL` is
      // unset here — the same `getMuanCompanionServerUrl` every other call
      // site uses, not a second env read.
      expect(calledUrl).toBe('http://localhost:3710/api/register')
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(JSON.parse(init.body)).toEqual({ connectKey: 'CONNECTKEY12', deckUrl: DECK_ORIGIN })
    })

    it('uses VITE_SLIDEV_MUAN_COMPANION_SERVER_URL when it is set', async () => {
      vi.stubEnv('VITE_SLIDEV_MUAN_COMPANION_SERVER_URL', 'https://sync.example')
      fetchMock.mockResolvedValue(okResponse({ roomCode: 'R', presenterCode: 'P', presenterUrl: 'u' }))

      await registerDeckIfConfigured()

      expect(fetchMock.mock.calls[0][0]).toBe('https://sync.example/api/register')
    })

    it('logs the room code, presenter URL and join link so the operator can actually use them', async () => {
      fetchMock.mockResolvedValue(okResponse({
        roomCode: 'ROOMCODE',
        presenterCode: 'PRESENTER1',
        presenterUrl: `${DECK_ORIGIN}/presenter/1?code=PRESENTER1`,
        participantUrl: `${DECK_ORIGIN}?roomCode=ROOMCODE`,
      }))

      await registerDeckIfConfigured()

      const logged = infoSpy.mock.calls[0][0] as string
      expect(logged).toContain('[muan-companion]')
      expect(logged).toContain('ROOMCODE')
      expect(logged).toContain(`${DECK_ORIGIN}/presenter/1?code=PRESENTER1`)
      expect(logged).toContain(`${DECK_ORIGIN}?roomCode=ROOMCODE`)
    })

    // The connect key is a credential. It goes into the request body and
    // nowhere else — in particular not into any console line, where it would
    // outlive its usefulness in a scrollback buffer.
    it('never logs the connect key itself', async () => {
      fetchMock.mockResolvedValue(okResponse({ roomCode: 'R', presenterCode: 'P', presenterUrl: 'u' }))

      await registerDeckIfConfigured()

      const infoCalls = infoSpy.mock.calls
      expect(JSON.stringify(infoCalls)).not.toContain('CONNECTKEY12')
    })

    it('reports a rejected registration as an error, without throwing', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: 'registration failed' }) })

      await expect(registerDeckIfConfigured()).resolves.toBeUndefined()

      expect(errorSpy).toHaveBeenCalledTimes(1)
      const message = errorSpy.mock.calls[0][0] as string
      expect(message).toContain('[muan-companion]')
      expect(message).toContain('400')
      // The server's own failure body is deliberately uninformative, so this
      // side has to echo back what it sent for the operator to diagnose.
      expect(message).toContain(DECK_ORIGIN)
      expect(message).not.toContain('CONNECTKEY12')
    })

    it('reports a rate-limit response as an error rather than retrying', async () => {
      fetchMock.mockResolvedValue({ ok: false, status: 429, json: async () => ({}) })

      await registerDeckIfConfigured()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)
    })

    it('reports an unreachable server as an error, without throwing', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))

      await expect(registerDeckIfConfigured()).resolves.toBeUndefined()

      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0][0]).toContain('could not reach')
    })

    // A connect key is single-use server-side, so a second attempt could only
    // fail — and would burn one of this source's rate-limit attempts doing it.
    it('registers at most once, even if app setup runs again (hot reload)', async () => {
      fetchMock.mockResolvedValue(okResponse({ roomCode: 'R', presenterCode: 'P', presenterUrl: 'u' }))

      await registerDeckIfConfigured()
      await registerDeckIfConfigured()

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    // The guard is set *before* the request goes out, so two near-simultaneous
    // callers can't both get past it while the first is still in flight.
    it('does not send a second request while the first is still in flight', async () => {
      let settle: (value: unknown) => void = () => {}
      fetchMock.mockReturnValue(new Promise((resolve) => {
        settle = resolve
      }))

      const first = registerDeckIfConfigured()
      const second = registerDeckIfConfigured()
      settle(okResponse({ roomCode: 'R', presenterCode: 'P', presenterUrl: 'u' }))
      await Promise.all([first, second])

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('falls back to the deck origin in the log when the server omits participantUrl', async () => {
      fetchMock.mockResolvedValue(okResponse({ roomCode: 'R', presenterCode: 'P', presenterUrl: 'u' }))

      await registerDeckIfConfigured()

      expect(infoSpy.mock.calls[0][0]).toContain(DECK_ORIGIN)
    })
  })
})
