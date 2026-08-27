import { defineConfig } from 'vitest/config'

// See packages/muan-companion-server/vitest.config.ts for why a local
// config is needed for `pnpm --filter ... test` to resolve correctly
// against this package's cwd, rather than the repo-root config's
// `test.projects` glob.
//
// `environment: 'jsdom'` (rather than the default `'node'`) is required so
// `participantIdentity.test.ts` can exercise a *real* `localStorage` — under
// the default node environment there's no global `localStorage` at all, and
// `participantIdentity.ts`'s try/catch around it would silently swallow a
// `ReferenceError` and report "nothing stored" for every test, never
// actually exercising the read/write/clear cycle it's meant to cover.
export default defineConfig({
  test: {
    environment: 'jsdom',
  },
})
