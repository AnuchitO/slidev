import { defineConfig } from 'vitest/config'

// See packages/workshop-tracker-server/vitest.config.ts for why a local
// (even empty) config is needed for `pnpm --filter ... test` to resolve
// correctly against this package's cwd, rather than the repo-root config's
// `test.projects` glob.
export default defineConfig({})
