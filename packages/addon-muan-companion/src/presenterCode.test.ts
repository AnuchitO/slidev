import { afterEach, describe, expect, it } from 'vitest'
import { getPresenterCodeFromUrl } from './presenterCode'

// This package's vitest environment is plain `node` (see `vitest.config.ts`),
// so `window` doesn't exist by default — stub just enough of it
// (`location.search`) for each case, rather than pulling in jsdom for one
// small pure function.
function stubWindowSearch(search: string | undefined) {
  if (search === undefined) {
    delete (globalThis as { window?: unknown }).window
    return
  }
  ;(globalThis as { window?: unknown }).window = { location: { search } }
}

describe('getPresenterCodeFromUrl', () => {
  afterEach(() => {
    stubWindowSearch(undefined)
  })

  it('reads the code param from the URL query string', () => {
    stubWindowSearch('?code=letmein')
    expect(getPresenterCodeFromUrl()).toBe('letmein')
  })

  it('returns undefined when the query string has no code param', () => {
    stubWindowSearch('?other=1')
    expect(getPresenterCodeFromUrl()).toBeUndefined()
  })

  it('returns undefined when there is no query string at all', () => {
    stubWindowSearch('')
    expect(getPresenterCodeFromUrl()).toBeUndefined()
  })

  it('returns undefined when window is unavailable (e.g. SSR/build-time evaluation)', () => {
    stubWindowSearch(undefined)
    expect(getPresenterCodeFromUrl()).toBeUndefined()
  })

  it('reads the code param alongside other query params, in either order', () => {
    stubWindowSearch('?foo=bar&code=xyz&baz=qux')
    expect(getPresenterCodeFromUrl()).toBe('xyz')
  })
})
