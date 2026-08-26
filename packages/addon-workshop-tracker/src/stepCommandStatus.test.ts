import { describe, expect, it } from 'vitest'
import { nextStepCommandStatus } from './stepCommandStatus'

describe('nextStepCommandStatus', () => {
  it('clicking Copy moves to pending-copy immediately (not an optimistic "copied")', () => {
    expect(nextStepCommandStatus('idle', 'click-copy')).toBe('pending-copy')
  })

  it('the copy ack confirms pending-copy as copied', () => {
    expect(nextStepCommandStatus('pending-copy', 'ack-copy')).toBe('copied')
  })

  it('a stray/late copy ack is ignored when not currently pending-copy', () => {
    expect(nextStepCommandStatus('idle', 'ack-copy')).toBe('idle')
    expect(nextStepCommandStatus('done', 'ack-copy')).toBe('done')
  })

  it('clicking Done moves to pending-done immediately, even from idle (no command needed)', () => {
    expect(nextStepCommandStatus('idle', 'click-done')).toBe('pending-done')
  })

  it('the done ack confirms pending-done as done', () => {
    expect(nextStepCommandStatus('pending-done', 'ack-done')).toBe('done')
  })

  it('a stray/late done ack is ignored when not currently pending-done', () => {
    expect(nextStepCommandStatus('idle', 'ack-done')).toBe('idle')
    expect(nextStepCommandStatus('copied', 'ack-done')).toBe('copied')
  })

  it('clicking Done after Copy still works (Done is always available per PRD §8)', () => {
    expect(nextStepCommandStatus('copied', 'click-done')).toBe('pending-done')
  })
})
