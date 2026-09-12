import { afterEach, describe, expect, it } from 'vitest'
import { getRoomCodeFromUrl } from './roomCode'

// This package's vitest environment is plain `node` (see `vitest.config.ts`),
// so `window` doesn't exist by default — stub just enough of it
// (`location.search`) for each case, rather than pulling in jsdom for one
// small pure function. Mirrors `presenterCode.test.ts`'s own helper exactly.
function stubWindowSearch(search: string | undefined) {
  if (search === undefined) {
    delete (globalThis as { window?: unknown }).window
    return
  }
  ;(globalThis as { window?: unknown }).window = { location: { search } }
}

describe('getRoomCodeFromUrl', () => {
  afterEach(() => {
    stubWindowSearch(undefined)
  })

  it('reads roomCode from the URL query string', () => {
    stubWindowSearch('?roomCode=letmein')
    expect(getRoomCodeFromUrl()).toBe('letmein')
  })

  it('returns undefined when the query string has no roomCode', () => {
    stubWindowSearch('?other=1')
    expect(getRoomCodeFromUrl()).toBeUndefined()
  })

  it('returns undefined when there is no query string at all', () => {
    stubWindowSearch('')
    expect(getRoomCodeFromUrl()).toBeUndefined()
  })

  it('returns undefined when window is unavailable (e.g. SSR/build-time evaluation)', () => {
    stubWindowSearch(undefined)
    expect(getRoomCodeFromUrl()).toBeUndefined()
  })

  it('reads roomCode alongside other query params, in either order', () => {
    stubWindowSearch('?foo=bar&roomCode=xyz&baz=qux')
    expect(getRoomCodeFromUrl()).toBe('xyz')
  })
})
