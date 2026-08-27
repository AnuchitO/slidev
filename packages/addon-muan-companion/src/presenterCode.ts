/**
 * Reads the presenter credential (plan 029 / PRD §12) out of the current
 * page's own URL — `?presenterCode=<code>` — rather than from any build-time
 * env var or config baked into the addon's JS bundle. That distinction is
 * load-bearing, not a style choice: `setup/main.ts` and `StepReporter.vue`
 * ship the *same* JS bundle to every participant's browser as the
 * presenter's own (Slidev doesn't build a separate bundle per route), so
 * anything embedded via `import.meta.env` at build time would ship to every
 * participant too — exactly the "naively embedded in a public bundle"
 * failure mode plan 029's STOP condition calls out. A URL query param is
 * instead per-browser, operator-supplied ("handed out alongside the URL",
 * matching how the plan frames the participant room code) — only the
 * specific browser the instructor navigates to `/presenter/N?presenterCode=...`
 * with ever has it, and it's never present in the shipped bundle itself.
 *
 * Called fresh (not cached at module scope) everywhere it's used — cheap,
 * and it means a presenter who edits the URL (e.g. correcting a typo'd code
 * and reloading) doesn't need any extra invalidation logic.
 */
export function getPresenterCodeFromUrl(): string | undefined {
  if (typeof window === 'undefined')
    return undefined
  return new URLSearchParams(window.location.search).get('presenterCode') ?? undefined
}
