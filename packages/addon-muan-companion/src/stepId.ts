/**
 * Resolves a slide's stable step key (PRD §8): the `stepId` frontmatter key
 * when the deck author set one, falling back to the slide index (as a
 * string) so `<StepCommand>` and the presenter's `setup/main.ts` still work
 * on slides that never declared a `stepId`. Used in two places (kept as one
 * function so the fallback rule can't drift between them):
 * `StepCommand.vue` (reads the *viewer's own* current slide frontmatter) and
 * `setup/main.ts` (reads the *presenter's* current route's frontmatter to
 * report `stepId` alongside `presenter:setSlide`, for the dashboard's
 * "current step" column).
 */
export function resolveStepId(frontmatter: Record<string, unknown> | undefined, slideIndex: number): string {
  const stepId = frontmatter?.stepId
  if (typeof stepId === 'string' && stepId.length > 0)
    return stepId
  return String(slideIndex)
}
