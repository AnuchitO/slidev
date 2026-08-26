import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addErrorReport,
  errorReports,
  joinParticipant,
  listErrorReports,
  participants,
  resetSessionStateForTests,
  resolveErrorReport,
  setStepStatus,
  stepStatus,
} from './session'

// Plan 030 (M5): server-side participant revival by id — a client-supplied
// `participantId` (from the addon's `sessionStorage`, see `JoinScreen.vue`)
// either resumes a known participant or falls back to minting a fresh one.
// Fake timers throughout (no real sleeps) so `joinedAt`-vs-`lastSeen`
// assertions are exact and instant.
describe('joinParticipant (resume/reconnect, plan 030)', () => {
  beforeEach(() => {
    resetSessionStateForTests()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('with no existingId, creates a fresh participant and reports outcome "fresh"', () => {
    const result = joinParticipant('Ada', undefined, () => 'p1', 'socket-1')

    expect(result.outcome).toBe('fresh')
    expect(result.participant).toEqual({
      id: 'p1',
      name: 'Ada',
      joinedAt: 0,
      lastSeen: 0,
      connected: true,
      visibility: 'visible',
      socketId: 'socket-1',
    })
    expect(participants.size).toBe(1)
  })

  it('with a matching existingId, revives the same participant record and reports outcome "resumed"', () => {
    const { participant: original } = joinParticipant('Ada', undefined, () => 'p1', 'socket-1')
    setStepStatus(original.id, 'install-deps', 'done')

    // Simulate a refresh some time later, on a new socket.
    vi.setSystemTime(5_000)
    const result = joinParticipant('Ada', 'p1', () => 'should-not-be-used', 'socket-2')

    expect(result.outcome).toBe('resumed')
    expect(result.participant).toBe(original) // same object identity, not a copy
    expect(result.participant.id).toBe('p1')
    expect(participants.size).toBe(1) // no duplicate row
    // Step status keyed by the (stable) participant id survives the resume.
    expect(stepStatus.get('p1:install-deps')).toEqual({ state: 'done', updatedAt: 0 })
  })

  it('preserves joinedAt but refreshes lastSeen/socketId on resume', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'socket-1')

    vi.setSystemTime(5_000)
    const { participant } = joinParticipant('Ada', 'p1', () => 'unused', 'socket-2')

    expect(participant.joinedAt).toBe(0)
    expect(participant.lastSeen).toBe(5_000)
    expect(participant.socketId).toBe('socket-2')
  })

  it('a resumed identity keeps its original name even if a different name is supplied', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'socket-1')

    const { participant } = joinParticipant('Definitely Not Ada', 'p1', () => 'unused', 'socket-2')

    // Documented in `session.ts`: the resumed identity wins — a rejoin can't
    // rename a participant out from under their own history.
    expect(participant.name).toBe('Ada')
  })

  it('with an unknown existingId (e.g. server restarted), falls back to a fresh join and reports outcome "resume-fallback"', () => {
    const result = joinParticipant('Ada', 'stale-id-from-before-a-restart', () => 'p2', 'socket-1')

    expect(result.outcome).toBe('resume-fallback')
    expect(result.participant.id).toBe('p2')
    expect(result.participant.id).not.toBe('stale-id-from-before-a-restart')
    expect(participants.size).toBe(1)
    expect(participants.has('stale-id-from-before-a-restart')).toBe(false)
  })
})

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

  it('resolveErrorReport marks a matching report resolved and returns it', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    const result = resolveErrorReport('err-1')

    expect(result?.resolved).toBe(true)
    expect(result?.id).toBe('err-1')
    expect(listErrorReports()[0].resolved).toBe(true)
  })

  it('resolveErrorReport returns undefined for an unknown id and mutates nothing', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    const result = resolveErrorReport('does-not-exist')

    expect(result).toBeUndefined()
    expect(listErrorReports()[0].resolved).toBe(false)
  })

  it('resolveErrorReport with a message trims it and stores it as resolutionMessage', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    const result = resolveErrorReport('err-1', '  keep going, you\'ve got this  ')

    expect(result?.resolutionMessage).toBe('keep going, you\'ve got this')
    expect(listErrorReports()[0].resolutionMessage).toBe('keep going, you\'ve got this')
  })

  it('resolveErrorReport with no message (or a blank one) leaves resolutionMessage unset', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    resolveErrorReport('err-1', '   ')

    expect(listErrorReports()[0].resolutionMessage).toBeUndefined()
  })

  it('resetSessionStateForTests clears accumulated error reports', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', ts: 1 })

    resetSessionStateForTests()

    expect(listErrorReports()).toEqual([])
  })
})
