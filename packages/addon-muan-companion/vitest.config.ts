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
    coverage: {
      provider: 'v8',
      // Without an explicit `include`, v8's default coverage report only
      // lists files that were actually transformed/imported by a test run —
      // a file with zero tests (e.g. `client.ts` before this addon's
      // coverage pass added `client.test.ts`) would silently vanish from the
      // report instead of showing up as an honest 0%. Scoping to `src/**` —
      // this package's pure-logic modules — deliberately excludes the
      // `.vue` components and `setup/main.ts`: those have no dedicated test
      // harness today (see this addon's coverage-pass notes / README), so
      // including them here would just add permanent, misleading 0% rows
      // rather than reflecting a real gap this config is meant to catch.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
    },
  },
})
