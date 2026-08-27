import { defineConfig } from 'vitest/config'

// A local config (even an empty one) is required so `vitest run` resolves
// correctly when invoked with this package as cwd (e.g. via `pnpm --filter
// slidev-muan-companion-server test`, as documented in this package's README).
// Without it, Vitest walks up to the repo-root `vitest.config.ts`, whose
// `test.projects: ['packages/*', 'test']` glob then resolves against this
// package's cwd instead of the repo root, and fails with "Projects
// definition references a non-existing file or a directory:
// .../slidev-muan-companion-server/test" — a pre-existing gap from plan 026, not
// something introduced here. `pnpm test` from the repo root (the aggregate,
// repo-wide command) already works without this file; this only fixes the
// package-local `pnpm --filter ... test` invocation.
export default defineConfig({})
