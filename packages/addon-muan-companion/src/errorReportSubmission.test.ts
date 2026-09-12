import { describe, expect, it } from 'vitest'
import { buildScreenshotFormData } from './errorReportSubmission'

describe('buildScreenshotFormData', () => {
  it('sets participantId, stepId, and the screenshot blob', () => {
    const blob = new Blob(['fake-png-bytes'], { type: 'image/png' })

    const form = buildScreenshotFormData({ participantId: 'p1', stepId: 's1', blob })

    expect(form.get('participantId')).toBe('p1')
    expect(form.get('stepId')).toBe('s1')
    expect(form.get('text')).toBeNull()
    const file = form.get('screenshot') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe('image/png')
  })

  it('includes text only when provided', () => {
    const blob = new Blob(['fake-png-bytes'], { type: 'image/png' })

    const form = buildScreenshotFormData({ participantId: 'p1', stepId: 's1', text: 'it exploded', blob })

    expect(form.get('text')).toBe('it exploded')
  })

  it('omits an empty/whitespace-only text field rather than sending a blank string', () => {
    const blob = new Blob(['fake-png-bytes'], { type: 'image/png' })

    const form = buildScreenshotFormData({ participantId: 'p1', stepId: 's1', text: '   ', blob })

    expect(form.get('text')).toBeNull()
  })
})
