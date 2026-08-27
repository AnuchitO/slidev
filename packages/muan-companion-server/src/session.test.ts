import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addErrorReport,
  addParticipantMessage,
  addPendingConnection,
  addPresenterMessage,
  confirmResolution,
  errorReports,
  joinParticipant,
  listErrorReports,
  listPendingConnections,
  participants,
  removeParticipant,
  removeParticipantSocket,
  removePendingConnection,
  resetSessionStateForTests,
  resolveErrorReport,
  setStepStatus,
  stepStatus,
} from './session'

// Plan 030 (M5): server-side participant revival by id — a client-supplied
// `participantId` (from the addon's `localStorage`, see `JoinScreen.vue`)
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
      socketIds: ['socket-1'],
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

  it('preserves joinedAt but refreshes lastSeen on resume, adding (not replacing) the new socketId', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'socket-1')

    vi.setSystemTime(5_000)
    const { participant } = joinParticipant('Ada', 'p1', () => 'unused', 'socket-2')

    expect(participant.joinedAt).toBe(0)
    expect(participant.lastSeen).toBe(5_000)
    // Both sockets are live at this point (a real disconnect of socket-1
    // would remove it via `removeParticipantSocket` — see below — this
    // pure-function call alone has no way to know socket-1 is gone unless
    // told so).
    expect(participant.socketIds).toEqual(['socket-1', 'socket-2'])
  })

  it('resuming on the same socketId twice does not duplicate it in socketIds', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'socket-1')

    const { participant } = joinParticipant('Ada', 'p1', () => 'unused', 'socket-1')

    expect(participant.socketIds).toEqual(['socket-1'])
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

// Follow-up bug found in live use: opening a second tab for the same
// participant (via localStorage resume), then closing that second tab, used
// to mark the *whole participant* closed even though the first tab was
// still open and connected — because a single `socketId` field got
// overwritten by the second tab's join, and closing it looked
// indistinguishable from "the only socket disconnected". These tests cover
// `removeParticipantSocket`, the fix.
describe('removeParticipantSocket (multi-tab presence, follow-up fix)', () => {
  beforeEach(() => {
    resetSessionStateForTests()
  })

  it('removing one of two live sockets leaves the participant connected and returns false (nothing to broadcast)', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'tab-1')
    joinParticipant('Ada', 'p1', () => 'unused', 'tab-2')

    const closed = removeParticipantSocket('p1', 'tab-2')

    expect(closed).toBe(false)
    const participant = participants.get('p1')!
    expect(participant.connected).toBe(true)
    expect(participant.visibility).not.toBe('closed')
    expect(participant.socketIds).toEqual(['tab-1'])
  })

  it('removing the last live socket marks the participant closed and returns true', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'tab-1')
    joinParticipant('Ada', 'p1', () => 'unused', 'tab-2')

    removeParticipantSocket('p1', 'tab-1')
    const closed = removeParticipantSocket('p1', 'tab-2')

    expect(closed).toBe(true)
    const participant = participants.get('p1')!
    expect(participant.connected).toBe(false)
    expect(participant.visibility).toBe('closed')
    expect(participant.socketIds).toEqual([])
  })

  it('a single-tab participant closing its only socket is marked closed (the ordinary case still works)', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'tab-1')

    const closed = removeParticipantSocket('p1', 'tab-1')

    expect(closed).toBe(true)
    expect(participants.get('p1')!.connected).toBe(false)
  })

  it('removing an unknown socketId from a known participant is a no-op', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'tab-1')

    const closed = removeParticipantSocket('p1', 'never-joined')

    expect(closed).toBe(false)
    expect(participants.get('p1')!.socketIds).toEqual(['tab-1'])
    expect(participants.get('p1')!.connected).toBe(true)
  })

  it('removing a socket from an unknown participantId is a no-op, not a throw', () => {
    expect(() => removeParticipantSocket('does-not-exist', 'tab-1')).not.toThrow()
    expect(removeParticipantSocket('does-not-exist', 'tab-1')).toBe(false)
  })

  it('removing the same already-gone socket twice does not re-report "closed" the second time', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'tab-1')

    expect(removeParticipantSocket('p1', 'tab-1')).toBe(true)
    // The participant is already closed — a duplicate/late disconnect event
    // for the same socket must not report `true` again (no second broadcast
    // for something that already happened).
    expect(removeParticipantSocket('p1', 'tab-1')).toBe(false)
  })
})

describe('pending connections (pre-join dashboard visibility)', () => {
  beforeEach(() => {
    resetSessionStateForTests()
  })

  it('addPendingConnection registers a connection, listed by listPendingConnections', () => {
    addPendingConnection('socket-1', 1000)

    expect(listPendingConnections()).toEqual([{ socketId: 'socket-1', connectedAt: 1000 }])
  })

  it('addPendingConnection defaults connectedAt to now when omitted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    addPendingConnection('socket-1')
    vi.useRealTimers()

    expect(listPendingConnections()).toEqual([{ socketId: 'socket-1', connectedAt: 5000 }])
  })

  it('removePendingConnection removes it and returns true', () => {
    addPendingConnection('socket-1', 1000)

    expect(removePendingConnection('socket-1')).toBe(true)
    expect(listPendingConnections()).toEqual([])
  })

  it('removePendingConnection on an unknown socketId is a no-op returning false', () => {
    expect(removePendingConnection('never-connected')).toBe(false)
  })

  it('tracks multiple pending connections independently', () => {
    addPendingConnection('socket-1', 1000)
    addPendingConnection('socket-2', 2000)

    expect(listPendingConnections()).toEqual([
      { socketId: 'socket-1', connectedAt: 1000 },
      { socketId: 'socket-2', connectedAt: 2000 },
    ])

    removePendingConnection('socket-1')

    expect(listPendingConnections()).toEqual([{ socketId: 'socket-2', connectedAt: 2000 }])
  })
})

describe('removeParticipant (the presenter "kick" action)', () => {
  beforeEach(() => {
    resetSessionStateForTests()
  })

  it('deletes the participant record and returns it', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'tab-1')

    const removed = removeParticipant('p1')

    expect(removed?.id).toBe('p1')
    expect(removed?.name).toBe('Ada')
    expect(participants.has('p1')).toBe(false)
  })

  it('a subsequent join with the removed id cannot resume — it is treated as an unknown id', () => {
    joinParticipant('Ada', undefined, () => 'p1', 'tab-1')
    removeParticipant('p1')

    // Mirrors `server.ts`'s `isKnownResume` check: once the record is gone,
    // `joinParticipant` has nothing to resume, so this is a fresh join
    // (a new id is minted) rather than reviving the kicked participant.
    const { outcome, participant } = joinParticipant('Ada', 'p1', () => 'p2', 'tab-2')

    expect(outcome).toBe('resume-fallback')
    expect(participant.id).toBe('p2')
  })

  it('returns undefined for an unknown id and mutates nothing', () => {
    expect(removeParticipant('does-not-exist')).toBeUndefined()
  })
})

describe('error report store (M3)', () => {
  beforeEach(() => {
    resetSessionStateForTests()
  })

  it('addErrorReport pushes a new report, defaulting status to open and thread to empty', () => {
    const report = addErrorReport({
      id: 'err-1',
      participantId: 'p1',
      participantName: 'Ada',
      stepId: 'install-deps',
      kind: 'problem',
      text: 'npm install blew up',
      ts: 123,
    })

    expect(report.status).toBe('open')
    expect(report.thread).toEqual([])
    expect(errorReports).toContainEqual(report)
    expect(listErrorReports()).toEqual([report])
  })

  it('resolveErrorReport moves a matching report to awaiting_confirmation and returns it', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = resolveErrorReport('err-1')

    expect(result?.status).toBe('awaiting_confirmation')
    expect(result?.id).toBe('err-1')
    expect(listErrorReports()[0].status).toBe('awaiting_confirmation')
  })

  it('resolveErrorReport returns undefined for an unknown id and mutates nothing', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = resolveErrorReport('does-not-exist')

    expect(result).toBeUndefined()
    expect(listErrorReports()[0].status).toBe('open')
  })

  it('resolveErrorReport with a message trims it and appends it as a presenter thread message', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = resolveErrorReport('err-1', '  keep going, you\'ve got this  ')

    expect(result?.thread).toEqual([{ from: 'presenter', text: 'keep going, you\'ve got this', ts: expect.any(Number) }])
    expect(listErrorReports()[0].thread).toEqual(result?.thread)
  })

  it('resolveErrorReport with no message (or a blank one) leaves the thread empty', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    resolveErrorReport('err-1', '   ')

    expect(listErrorReports()[0].thread).toEqual([])
  })

  it('addPresenterMessage appends a thread message without changing status', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = addPresenterMessage('err-1', 'still looking into it')

    expect(result?.status).toBe('open')
    expect(result?.thread).toEqual([{ from: 'presenter', text: 'still looking into it', ts: expect.any(Number) }])
  })

  it('addPresenterMessage with a blank message is a no-op', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = addPresenterMessage('err-1', '   ')

    expect(result).toBeUndefined()
    expect(listErrorReports()[0].thread).toEqual([])
  })

  it('addParticipantMessage appends a thread message without changing status', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'question', ts: 1 })

    const result = addParticipantMessage('err-1', 'any update?')

    expect(result?.status).toBe('open')
    expect(result?.thread).toEqual([{ from: 'participant', text: 'any update?', ts: expect.any(Number) }])
  })

  it('confirmResolution(true) moves a report to resolved and can append a participant message', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    resolveErrorReport('err-1', 'try this fix')

    const result = confirmResolution('err-1', true, 'yep, that did it!')

    expect(result?.status).toBe('resolved')
    expect(result?.thread).toEqual([
      { from: 'presenter', text: 'try this fix', ts: expect.any(Number) },
      { from: 'participant', text: 'yep, that did it!', ts: expect.any(Number) },
    ])
  })

  it('confirmResolution(false) moves a report to reopened and can append a participant message', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    resolveErrorReport('err-1', 'try this fix')

    const result = confirmResolution('err-1', false, 'still broken, same error')

    expect(result?.status).toBe('reopened')
    expect(result?.thread.at(-1)).toEqual({ from: 'participant', text: 'still broken, same error', ts: expect.any(Number) })
  })

  it('confirmResolution with no message still transitions status, appending nothing', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = confirmResolution('err-1', true)

    expect(result?.status).toBe('resolved')
    expect(result?.thread).toEqual([])
  })

  it('confirmResolution returns undefined for an unknown id', () => {
    expect(confirmResolution('does-not-exist', true)).toBeUndefined()
  })

  it('resetSessionStateForTests clears accumulated error reports', () => {
    addErrorReport({ id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    resetSessionStateForTests()

    expect(listErrorReports()).toEqual([])
  })
})
