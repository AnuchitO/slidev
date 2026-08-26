import { beforeEach, describe, expect, it } from 'vitest'
import {
  addErrorReport,
  errorReports,
  listErrorReports,
  resetSessionStateForTests,
  resolveErrorReport,
} from './session'

describe('error report store (M3)', () => {
  beforeEach(() => {
    resetSessionStateForTests()
  })

  it('addErrorReport pushes a new report, defaulting resolved to false', () => {
    const report = addErrorReport({
      id: 'err-1',
      participantId: 'p1',
      participantName: 'Ada',
      stepId: 'install-deps',
      text: 'npm install blew up',
      ts: 123,
    })

    expect(report.resolved).toBe(false)
    expect(errorReports).toContainEqual(report)
    expect(listErrorReports()).toEqual([report])
  })

  it('resolveErrorReport marks a matching report resolved and returns true', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    const result = resolveErrorReport('err-1')

    expect(result).toBe(true)
    expect(listErrorReports()[0].resolved).toBe(true)
  })

  it('resolveErrorReport returns false for an unknown id and mutates nothing', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    const result = resolveErrorReport('does-not-exist')

    expect(result).toBe(false)
    expect(listErrorReports()[0].resolved).toBe(false)
  })

  it('resetSessionStateForTests clears accumulated error reports', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    resetSessionStateForTests()

    expect(listErrorReports()).toEqual([])
  })
})
