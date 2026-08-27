import { describe, expect, it } from 'vitest'
import { resolveStepId } from './stepId'

describe('resolveStepId', () => {
  it('uses the frontmatter stepId when present', () => {
    expect(resolveStepId({ stepId: 'install-deps' }, 2)).toBe('install-deps')
  })

  it('falls back to the slide index (as a string) when frontmatter has no stepId', () => {
    expect(resolveStepId({}, 3)).toBe('3')
  })

  it('falls back to the slide index when frontmatter is undefined', () => {
    expect(resolveStepId(undefined, 1)).toBe('1')
  })

  it('falls back to the slide index when stepId is not a non-empty string', () => {
    expect(resolveStepId({ stepId: '' }, 4)).toBe('4')
    expect(resolveStepId({ stepId: 42 }, 5)).toBe('5')
    expect(resolveStepId({ stepId: null }, 6)).toBe('6')
  })
})
