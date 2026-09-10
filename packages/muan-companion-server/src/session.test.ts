import type { RoomState } from './session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addErrorReport, addParticipantMessage, addPendingConnection, addPresenterMessage, confirmResolution, createSession, destroySession, findRoomByParticipantId, getRoom, joinParticipant, listErrorReports, listPendingConnections, listRooms, MAX_TEXT_LENGTH, PRESENTER_CODE_LENGTH, removeParticipant, removeParticipantSocket, removePendingConnection, resetSessionStateForTests, resolveErrorReport, ROOM_CODE_LENGTH, rooms, setStepStatus } from './session'

// Plan 032a: every mutator in `session.ts` used to operate on module-level
// singletons (`participants`, `stepStatus`, `errorReports`,
// `pendingConnections`) and therefore needed no addressing at all; they now
// take the `RoomState` they act on as their first argument. Each test below
// works against one freshly-created room, so what every existing assertion
// pins down is unchanged — the state just has an owner now. The dedicated
// "multi-room isolation" block at the bottom of this file is what actually
// exercises there being more than one.
let room: RoomState

/**
 * Drops every session from the previous test and stands up one fresh room to
 * work against. `resetSessionStateForTests()` alone is no longer enough for a
 * `beforeEach`: with state keyed by room there's nothing left to act on
 * afterwards until a room exists.
 */
function freshRoom(): RoomState {
  resetSessionStateForTests()
  return createSession({ roomCode: 'ROOM-A', presenterCode: 'PRESENTER-A', deckUrl: 'http://localhost:3030' }).room
}

// Plan 030 (M5): server-side participant revival by id — a client-supplied
// `participantId` (from the addon's `localStorage`, see `JoinScreen.vue`)
// either resumes a known participant or falls back to minting a fresh one.
// Fake timers throughout (no real sleeps) so `joinedAt`-vs-`lastSeen`
// assertions are exact and instant.
describe('joinParticipant (resume/reconnect, plan 030)', () => {
  beforeEach(() => {
    room = freshRoom()
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('with no existingId, creates a fresh participant and reports outcome "fresh"', () => {
    const result = joinParticipant(room, 'Ada', undefined, () => 'p1', 'socket-1')

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
    expect(room.participants.size).toBe(1)
  })

  it('with a matching existingId, revives the same participant record and reports outcome "resumed"', () => {
    const { participant: original } = joinParticipant(room, 'Ada', undefined, () => 'p1', 'socket-1')
    setStepStatus(room, original.id, 'install-deps', 'done')

    // Simulate a refresh some time later, on a new socket.
    vi.setSystemTime(5_000)
    const result = joinParticipant(room, 'Ada', 'p1', () => 'should-not-be-used', 'socket-2')

    expect(result.outcome).toBe('resumed')
    expect(result.participant).toBe(original) // same object identity, not a copy
    expect(result.participant.id).toBe('p1')
    expect(room.participants.size).toBe(1) // no duplicate row
    // Step status keyed by the (stable) participant id survives the resume.
    expect(room.stepStatus.get('p1:install-deps')).toEqual({ state: 'done', updatedAt: 0 })
  })

  it('preserves joinedAt but refreshes lastSeen on resume, adding (not replacing) the new socketId', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'socket-1')

    vi.setSystemTime(5_000)
    const { participant } = joinParticipant(room, 'Ada', 'p1', () => 'unused', 'socket-2')

    expect(participant.joinedAt).toBe(0)
    expect(participant.lastSeen).toBe(5_000)
    // Both sockets are live at this point (a real disconnect of socket-1
    // would remove it via `removeParticipantSocket` — see below — this
    // pure-function call alone has no way to know socket-1 is gone unless
    // told so).
    expect(participant.socketIds).toEqual(['socket-1', 'socket-2'])
  })

  it('resuming on the same socketId twice does not duplicate it in socketIds', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'socket-1')

    const { participant } = joinParticipant(room, 'Ada', 'p1', () => 'unused', 'socket-1')

    expect(participant.socketIds).toEqual(['socket-1'])
  })

  it('a resumed identity keeps its original name even if a different name is supplied', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'socket-1')

    const { participant } = joinParticipant(room, 'Definitely Not Ada', 'p1', () => 'unused', 'socket-2')

    // Documented in `session.ts`: the resumed identity wins — a rejoin can't
    // rename a participant out from under their own history.
    expect(participant.name).toBe('Ada')
  })

  it('with an unknown existingId (e.g. server restarted), falls back to a fresh join and reports outcome "resume-fallback"', () => {
    const result = joinParticipant(room, 'Ada', 'stale-id-from-before-a-restart', () => 'p2', 'socket-1')

    expect(result.outcome).toBe('resume-fallback')
    expect(result.participant.id).toBe('p2')
    expect(result.participant.id).not.toBe('stale-id-from-before-a-restart')
    expect(room.participants.size).toBe(1)
    expect(room.participants.has('stale-id-from-before-a-restart')).toBe(false)
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
    room = freshRoom()
  })

  it('removing one of two live sockets leaves the participant connected and returns false (nothing to broadcast)', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'tab-1')
    joinParticipant(room, 'Ada', 'p1', () => 'unused', 'tab-2')

    const closed = removeParticipantSocket(room, 'p1', 'tab-2')

    expect(closed).toBe(false)
    const participant = room.participants.get('p1')!
    expect(participant.connected).toBe(true)
    expect(participant.visibility).not.toBe('closed')
    expect(participant.socketIds).toEqual(['tab-1'])
  })

  it('removing the last live socket marks the participant closed and returns true', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'tab-1')
    joinParticipant(room, 'Ada', 'p1', () => 'unused', 'tab-2')

    removeParticipantSocket(room, 'p1', 'tab-1')
    const closed = removeParticipantSocket(room, 'p1', 'tab-2')

    expect(closed).toBe(true)
    const participant = room.participants.get('p1')!
    expect(participant.connected).toBe(false)
    expect(participant.visibility).toBe('closed')
    expect(participant.socketIds).toEqual([])
  })

  it('a single-tab participant closing its only socket is marked closed (the ordinary case still works)', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'tab-1')

    const closed = removeParticipantSocket(room, 'p1', 'tab-1')

    expect(closed).toBe(true)
    expect(room.participants.get('p1')!.connected).toBe(false)
  })

  it('removing an unknown socketId from a known participant is a no-op', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'tab-1')

    const closed = removeParticipantSocket(room, 'p1', 'never-joined')

    expect(closed).toBe(false)
    expect(room.participants.get('p1')!.socketIds).toEqual(['tab-1'])
    expect(room.participants.get('p1')!.connected).toBe(true)
  })

  it('removing a socket from an unknown participantId is a no-op, not a throw', () => {
    expect(() => removeParticipantSocket(room, 'does-not-exist', 'tab-1')).not.toThrow()
    expect(removeParticipantSocket(room, 'does-not-exist', 'tab-1')).toBe(false)
  })

  it('removing the same already-gone socket twice does not re-report "closed" the second time', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'tab-1')

    expect(removeParticipantSocket(room, 'p1', 'tab-1')).toBe(true)
    // The participant is already closed — a duplicate/late disconnect event
    // for the same socket must not report `true` again (no second broadcast
    // for something that already happened).
    expect(removeParticipantSocket(room, 'p1', 'tab-1')).toBe(false)
  })
})

describe('pending connections (pre-join dashboard visibility)', () => {
  beforeEach(() => {
    room = freshRoom()
  })

  it('addPendingConnection registers a connection, listed by listPendingConnections', () => {
    addPendingConnection(room, 'socket-1', 1000)

    expect(listPendingConnections(room)).toEqual([{ socketId: 'socket-1', connectedAt: 1000 }])
  })

  it('addPendingConnection defaults connectedAt to now when omitted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(5000)
    addPendingConnection(room, 'socket-1')
    vi.useRealTimers()

    expect(listPendingConnections(room)).toEqual([{ socketId: 'socket-1', connectedAt: 5000 }])
  })

  it('removePendingConnection removes it and returns true', () => {
    addPendingConnection(room, 'socket-1', 1000)

    expect(removePendingConnection(room, 'socket-1')).toBe(true)
    expect(listPendingConnections(room)).toEqual([])
  })

  it('removePendingConnection on an unknown socketId is a no-op returning false', () => {
    expect(removePendingConnection(room, 'never-connected')).toBe(false)
  })

  it('tracks multiple pending connections independently', () => {
    addPendingConnection(room, 'socket-1', 1000)
    addPendingConnection(room, 'socket-2', 2000)

    expect(listPendingConnections(room)).toEqual([
      { socketId: 'socket-1', connectedAt: 1000 },
      { socketId: 'socket-2', connectedAt: 2000 },
    ])

    removePendingConnection(room, 'socket-1')

    expect(listPendingConnections(room)).toEqual([{ socketId: 'socket-2', connectedAt: 2000 }])
  })
})

describe('removeParticipant (the presenter "kick" action)', () => {
  beforeEach(() => {
    room = freshRoom()
  })

  it('deletes the participant record and returns it', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'tab-1')

    const removed = removeParticipant(room, 'p1')

    expect(removed?.id).toBe('p1')
    expect(removed?.name).toBe('Ada')
    expect(room.participants.has('p1')).toBe(false)
  })

  it('a subsequent join with the removed id cannot resume — it is treated as an unknown id', () => {
    joinParticipant(room, 'Ada', undefined, () => 'p1', 'tab-1')
    removeParticipant(room, 'p1')

    // Mirrors `server.ts`'s `isKnownResume` check: once the record is gone,
    // `joinParticipant` has nothing to resume, so this is a fresh join
    // (a new id is minted) rather than reviving the kicked participant.
    const { outcome, participant } = joinParticipant(room, 'Ada', 'p1', () => 'p2', 'tab-2')

    expect(outcome).toBe('resume-fallback')
    expect(participant.id).toBe('p2')
  })

  it('returns undefined for an unknown id and mutates nothing', () => {
    expect(removeParticipant(room, 'does-not-exist')).toBeUndefined()
  })
})

describe('error report store (M3)', () => {
  beforeEach(() => {
    room = freshRoom()
  })

  it('addErrorReport pushes a new report, defaulting status to open and thread to empty', () => {
    const report = addErrorReport(room, {
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
    expect(room.errorReports).toContainEqual(report)
    expect(listErrorReports(room)).toEqual([report])
  })

  it('resolveErrorReport moves a matching report to awaiting_confirmation and returns it', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = resolveErrorReport(room, 'err-1')

    expect(result?.status).toBe('awaiting_confirmation')
    expect(result?.id).toBe('err-1')
    expect(listErrorReports(room)[0].status).toBe('awaiting_confirmation')
  })

  it('resolveErrorReport returns undefined for an unknown id and mutates nothing', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = resolveErrorReport(room, 'does-not-exist')

    expect(result).toBeUndefined()
    expect(listErrorReports(room)[0].status).toBe('open')
  })

  it('resolveErrorReport with a message trims it and appends it as a presenter thread message', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = resolveErrorReport(room, 'err-1', '  keep going, you\'ve got this  ')

    expect(result?.thread).toEqual([{ from: 'presenter', text: 'keep going, you\'ve got this', ts: expect.any(Number) }])
    expect(listErrorReports(room)[0].thread).toEqual(result?.thread)
  })

  it('resolveErrorReport with no message (or a blank one) leaves the thread empty', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    resolveErrorReport(room, 'err-1', '   ')

    expect(listErrorReports(room)[0].thread).toEqual([])
  })

  it('addPresenterMessage appends a thread message without changing status', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = addPresenterMessage(room, 'err-1', 'still looking into it')

    expect(result?.status).toBe('open')
    expect(result?.thread).toEqual([{ from: 'presenter', text: 'still looking into it', ts: expect.any(Number) }])
  })

  it('addPresenterMessage with a blank message is a no-op', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = addPresenterMessage(room, 'err-1', '   ')

    expect(result).toBeUndefined()
    expect(listErrorReports(room)[0].thread).toEqual([])
  })

  it('addParticipantMessage appends a thread message without changing status', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'question', ts: 1 })

    const result = addParticipantMessage(room, 'err-1', 'any update?')

    expect(result?.status).toBe('open')
    expect(result?.thread).toEqual([{ from: 'participant', text: 'any update?', ts: expect.any(Number) }])
  })

  it('addParticipantMessage with a blank message is a no-op', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'question', ts: 1 })

    const result = addParticipantMessage(room, 'err-1', '   ')

    expect(result).toBeUndefined()
    expect(listErrorReports(room)[0].thread).toEqual([])
  })

  it('confirmResolution(room, true) moves a report to resolved and can append a participant message', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    resolveErrorReport(room, 'err-1', 'try this fix')

    const result = confirmResolution(room, 'err-1', true, 'yep, that did it!')

    expect(result?.status).toBe('resolved')
    expect(result?.thread).toEqual([
      { from: 'presenter', text: 'try this fix', ts: expect.any(Number) },
      { from: 'participant', text: 'yep, that did it!', ts: expect.any(Number) },
    ])
  })

  it('confirmResolution(room, false) moves a report to reopened and can append a participant message', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    resolveErrorReport(room, 'err-1', 'try this fix')

    const result = confirmResolution(room, 'err-1', false, 'still broken, same error')

    expect(result?.status).toBe('reopened')
    expect(result?.thread.at(-1)).toEqual({ from: 'participant', text: 'still broken, same error', ts: expect.any(Number) })
  })

  it('confirmResolution with no message still transitions status, appending nothing', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    const result = confirmResolution(room, 'err-1', true)

    expect(result?.status).toBe('resolved')
    expect(result?.thread).toEqual([])
  })

  it('confirmResolution returns undefined for an unknown id', () => {
    expect(confirmResolution(room, 'does-not-exist', true)).toBeUndefined()
  })

  // Plan 032a: `resetSessionStateForTests` used to blank the *fields* of the
  // one singleton session; with state keyed by room there is no singleton to
  // blank, so it drops every live session instead. That's what this now
  // asserts — and it's a stricter guarantee than the old one, since a test
  // can't inherit a room a previous test created under a different code
  // either.
  it('resetSessionStateForTests drops every live session, taking their accumulated error reports with them', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    createSession({ roomCode: 'ROOM-B' })
    expect(listRooms()).toHaveLength(2)

    resetSessionStateForTests()

    expect(listRooms()).toEqual([])
    expect(getRoom('ROOM-A')).toBeUndefined()
    expect(getRoom('ROOM-B')).toBeUndefined()

    // Restore an empty room so this describe block's remaining shared state
    // is in the same shape every other test here expects.
    room = freshRoom()
    expect(listErrorReports(room)).toEqual([])
  })
})

// Second-pass security fix: none of these mutators capped free-text input,
// so a socket that already holds a valid room/presenter code (nothing here
// is a *content* check, only an identity one) could otherwise push an
// arbitrarily large string, indefinitely, into this process's unbounded,
// in-memory `errorReports` array. `MAX_TEXT_LENGTH` bounds every free-text
// field this store accepts; these tests pin down the exact boundary
// (exactly at the limit is untouched, one over is truncated) rather than
// just "very long input doesn't crash".
describe('free-text length cap (MAX_TEXT_LENGTH)', () => {
  beforeEach(() => {
    room = freshRoom()
  })

  it('addErrorReport leaves text at exactly MAX_TEXT_LENGTH untouched', () => {
    const text = 'a'.repeat(MAX_TEXT_LENGTH)

    const report = addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', text, ts: 1 })

    expect(report.text).toHaveLength(MAX_TEXT_LENGTH)
    expect(report.text).toBe(text)
  })

  it('addErrorReport truncates text longer than MAX_TEXT_LENGTH to the cap', () => {
    const text = 'a'.repeat(MAX_TEXT_LENGTH + 500)

    const report = addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', text, ts: 1 })

    expect(report.text).toHaveLength(MAX_TEXT_LENGTH)
    expect(report.text).toBe('a'.repeat(MAX_TEXT_LENGTH))
  })

  it('addErrorReport with no text at all is unaffected by the cap', () => {
    const report = addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })

    expect(report.text).toBeUndefined()
  })

  it('addPresenterMessage truncates an oversized message before appending it to the thread', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    const overlong = `x${'y'.repeat(MAX_TEXT_LENGTH + 10)}`

    const result = addPresenterMessage(room, 'err-1', overlong)

    expect(result?.thread[0].text).toHaveLength(MAX_TEXT_LENGTH)
    expect(result?.thread[0].text).toBe(overlong.slice(0, MAX_TEXT_LENGTH))
  })

  it('addParticipantMessage truncates an oversized message before appending it to the thread', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'question', ts: 1 })
    const overlong = 'z'.repeat(MAX_TEXT_LENGTH + 10)

    const result = addParticipantMessage(room, 'err-1', overlong)

    expect(result?.thread[0].text).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('resolveErrorReport truncates an oversized message before appending it to the thread', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    const overlong = 'm'.repeat(MAX_TEXT_LENGTH + 10)

    const result = resolveErrorReport(room, 'err-1', overlong)

    expect(result?.thread[0].text).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('confirmResolution truncates an oversized message before appending it to the thread', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    const overlong = 'w'.repeat(MAX_TEXT_LENGTH + 10)

    const result = confirmResolution(room, 'err-1', true, overlong)

    expect(result?.thread[0].text).toHaveLength(MAX_TEXT_LENGTH)
  })

  it('a message that is only oversized after trimming is still capped, and trimming happens first', () => {
    addErrorReport(room, { id: 'err-1', participantId: 'p1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    // Leading whitespace shouldn't count toward the cap — trim, then cap.
    const padded = `   ${'q'.repeat(MAX_TEXT_LENGTH)}   `

    const result = addPresenterMessage(room, 'err-1', padded)

    expect(result?.thread[0].text).toBe('q'.repeat(MAX_TEXT_LENGTH))
  })
})

// Plan 032a: `createSession` is the single door every workshop session comes
// in through — `createMuanCompanionServer`'s own boot-time session included
// (see `server.ts`), and 032b/032d's runtime "start a new presentation"
// actions in future. These lock down the contract those callers depend on.
describe('createSession (plan 032a)', () => {
  beforeEach(() => {
    resetSessionStateForTests()
  })

  it('registers the room under its own room code, with empty per-room state', () => {
    const { roomCode, room: created } = createSession({ roomCode: 'ROOM-A', presenterCode: 'PRESENTER-A', deckUrl: 'http://deck.test' })

    expect(roomCode).toBe('ROOM-A')
    expect(getRoom('ROOM-A')).toBe(created)
    expect(created.presenterCode).toBe('PRESENTER-A')
    expect(created.deckUrl).toBe('http://deck.test')
    expect(created.participants.size).toBe(0)
    expect(created.stepStatus.size).toBe(0)
    expect(created.pendingConnections.size).toBe(0)
    expect(created.errorReports).toEqual([])
    // The room code is the map key *and* the session id — 031 Q2's explicit
    // recommendation against a second, parallel internal identifier.
    expect(created.session.id).toBe('ROOM-A')
    expect(created.session.currentSlideIndex).toBe(1)
    expect(created.session.currentStepId).toBe('1')
  })

  it('generates both codes when the caller supplies neither (031a, now for every session)', () => {
    const { roomCode, presenterCode } = createSession({ generate: length => 'X'.repeat(length) })

    expect(roomCode).toBe('X'.repeat(ROOM_CODE_LENGTH))
    expect(presenterCode).toBe('X'.repeat(PRESENTER_CODE_LENGTH))
    // The presenter code is deliberately the longer of the two — it's the
    // higher-privilege secret (see the constants' own doc comment).
    expect(PRESENTER_CODE_LENGTH).toBeGreaterThan(ROOM_CODE_LENGTH)
  })

  it('generates codes that are actually random by default, not a fixed string', () => {
    const first = createSession()
    const second = createSession()

    expect(first.roomCode).not.toBe(second.roomCode)
    expect(first.presenterCode).not.toBe(second.presenterCode)
    expect(first.roomCode).toHaveLength(ROOM_CODE_LENGTH)
    expect(first.presenterCode).toHaveLength(PRESENTER_CODE_LENGTH)
  })

  it('re-rolls a generated room code that collides with a live session', () => {
    createSession({ roomCode: 'TAKEN' })
    let call = 0
    // The first roll collides with the room above; the second must be used
    // instead of silently merging two workshops into one session.
    const generate = (length: number) => (call++ === 0 ? 'TAKEN' : `FREE${length}`)

    const { roomCode } = createSession({ generate })

    expect(roomCode).toBe(`FREE${ROOM_CODE_LENGTH}`)
    expect(listRooms()).toHaveLength(2)
  })

  it('gives up loudly rather than returning a colliding code when generation never finds a free one', () => {
    // Only reachable with a degenerate generator like this one — real
    // generation would have to lose a ~40-bit lottery ten times running —
    // but the outcome has to be a thrown error, never a code that silently
    // merges the new session into the existing room.
    createSession({ roomCode: 'ALWAYS' })

    expect(() => createSession({ generate: () => 'ALWAYS' })).toThrow(/could not generate an unused room code/)
    expect(listRooms()).toHaveLength(1)
  })

  it('throws rather than replacing or reusing a session when an explicit room code is already taken', () => {
    const { room: original } = createSession({ roomCode: 'ROOM-A' })
    joinParticipant(original, 'Ada', undefined, () => 'p1', 'sock-1')

    expect(() => createSession({ roomCode: 'ROOM-A' })).toThrow(/already exists/)
    // Crucially the *existing* session is untouched — the failure mode this
    // guards against is a second create silently wiping a live workshop's
    // roster, or quietly merging two workshops into one.
    expect(getRoom('ROOM-A')).toBe(original)
    expect(original.participants.get('p1')?.name).toBe('Ada')
  })

  it('gives every session its own uploads directory, never a shared one', () => {
    const a = createSession({ roomCode: 'ROOM-A' }).room
    const b = createSession({ roomCode: 'ROOM-B' }).room

    expect(a.uploadsDir).not.toBe(b.uploadsDir)
    expect(a.uploadsDirName).not.toBe(b.uploadsDirName)
    // The served path segment is the server-chosen `mkdtemp` suffix, never
    // the (operator-supplied, therefore untrusted) room code — see
    // `RoomState.uploadsDirName`.
    expect(a.uploadsDirName).not.toContain('ROOM-A')
    expect(a.uploadsDir.endsWith(`/${a.uploadsDirName}`)).toBe(true)
  })

  it('allows an explicit empty room code, which stays permanently unreachable (fail closed)', () => {
    // How `createMuanCompanionServer` used to represent "no room code was
    // configured", and still does for a caller that passes `''` explicitly.
    // `auth.ts` refuses every credential against an empty configured code,
    // so the room exists but nobody can enter it — the same fail-closed
    // state this package has always had, expressed as a room rather than as
    // an unusable singleton.
    const { room: unreachable } = createSession({ roomCode: '', presenterCode: '' })

    expect(getRoom('')).toBe(unreachable)
    expect(unreachable.roomCode).toBe('')
    // `getRoom(undefined)` must NOT resolve that room — "this socket named
    // no room" and "this socket named the empty-code room" are different
    // questions, and conflating them would hand an unhinted socket a room
    // it never asked for.
    expect(getRoom(undefined)).toBeUndefined()
  })

  it('destroySession removes the room and reports whether one existed', () => {
    createSession({ roomCode: 'ROOM-A' })

    expect(destroySession('ROOM-A')).toBe(true)
    expect(getRoom('ROOM-A')).toBeUndefined()
    expect(destroySession('ROOM-A')).toBe(false)
    expect(destroySession('never-existed')).toBe(false)
  })

  it('a destroyed room code can be reused by a later createSession', () => {
    createSession({ roomCode: 'ROOM-A' })
    destroySession('ROOM-A')

    expect(() => createSession({ roomCode: 'ROOM-A' })).not.toThrow()
    expect(rooms.size).toBe(1)
  })
})

// Plan 032a's core acceptance bar: two concurrent sessions must not be able
// to see or affect each other's state through *any* of `session.ts`'s
// mutators. `server.test.ts` covers the same isolation end-to-end over real
// sockets; this covers it at the state layer, where a leak would originate.
describe('multi-room isolation (plan 032a)', () => {
  let roomA: RoomState
  let roomB: RoomState

  beforeEach(() => {
    resetSessionStateForTests()
    roomA = createSession({ roomCode: 'ROOM-A', presenterCode: 'PRESENTER-A' }).room
    roomB = createSession({ roomCode: 'ROOM-B', presenterCode: 'PRESENTER-B' }).room
  })

  it('participants joined in one room never appear in the other', () => {
    joinParticipant(roomA, 'Ada', undefined, () => 'a1', 'sock-a')
    joinParticipant(roomB, 'Bob', undefined, () => 'b1', 'sock-b')

    expect([...roomA.participants.keys()]).toEqual(['a1'])
    expect([...roomB.participants.keys()]).toEqual(['b1'])
    expect(roomA.participants.has('b1')).toBe(false)
    expect(roomB.participants.has('a1')).toBe(false)
  })

  it('a participant id minted in one room cannot resume in the other (resume tokens do not cross rooms)', () => {
    const { participant } = joinParticipant(roomA, 'Ada', undefined, () => 'a1', 'sock-a')

    // Room B has never seen this id, so it can't be resumed there — it falls
    // through to an ordinary fresh join, which is what makes room B's
    // room-code gate (`server.ts`'s `isKnownResume` check) still apply.
    const result = joinParticipant(roomB, 'Ada', participant.id, () => 'b1', 'sock-b')

    expect(result.outcome).toBe('resume-fallback')
    expect(result.participant.id).toBe('b1')
    expect(roomA.participants.get('a1')?.socketIds).toEqual(['sock-a'])
  })

  it('kicking a participant in one room leaves the other room untouched', () => {
    joinParticipant(roomA, 'Ada', undefined, () => 'a1', 'sock-a')
    joinParticipant(roomB, 'Ada', undefined, () => 'a1', 'sock-b')

    // Same participant *id* deliberately, to prove the room — not the id —
    // is what scopes the delete.
    expect(removeParticipant(roomA, 'a1')?.name).toBe('Ada')

    expect(roomA.participants.has('a1')).toBe(false)
    expect(roomB.participants.has('a1')).toBe(true)
  })

  it('removeParticipantSocket in one room does not close the same id in the other', () => {
    joinParticipant(roomA, 'Ada', undefined, () => 'a1', 'sock-a')
    joinParticipant(roomB, 'Ada', undefined, () => 'a1', 'sock-b')

    expect(removeParticipantSocket(roomA, 'a1', 'sock-a')).toBe(true)

    expect(roomA.participants.get('a1')?.connected).toBe(false)
    expect(roomB.participants.get('a1')?.connected).toBe(true)
  })

  it('step status is per room, even for the same participant id and step id', () => {
    setStepStatus(roomA, 'p1', 'install-deps', 'done')
    setStepStatus(roomB, 'p1', 'install-deps', 'copied')

    expect(roomA.stepStatus.get('p1:install-deps')?.state).toBe('done')
    expect(roomB.stepStatus.get('p1:install-deps')?.state).toBe('copied')
  })

  it('error reports are per room, and a report id from one room is unknown in the other', () => {
    addErrorReport(roomA, { id: 'err-a', participantId: 'a1', participantName: 'Ada', stepId: 's1', kind: 'problem', ts: 1 })
    addErrorReport(roomB, { id: 'err-b', participantId: 'b1', participantName: 'Bob', stepId: 's1', kind: 'question', ts: 2 })

    expect(listErrorReports(roomA).map(r => r.id)).toEqual(['err-a'])
    expect(listErrorReports(roomB).map(r => r.id)).toEqual(['err-b'])

    // Every mutator that takes an errorId is likewise room-scoped: acting on
    // the *other* room's report id is the same no-op as an id that never
    // existed at all.
    expect(resolveErrorReport(roomA, 'err-b')).toBeUndefined()
    expect(addPresenterMessage(roomA, 'err-b', 'hello')).toBeUndefined()
    expect(addParticipantMessage(roomA, 'err-b', 'hello')).toBeUndefined()
    expect(confirmResolution(roomA, 'err-b', true)).toBeUndefined()
    expect(listErrorReports(roomB)[0].status).toBe('open')
    expect(listErrorReports(roomB)[0].thread).toEqual([])
  })

  it('pending connections are per room, even for the same socket id', () => {
    addPendingConnection(roomA, 'sock-1', 1000)

    expect(listPendingConnections(roomA)).toEqual([{ socketId: 'sock-1', connectedAt: 1000 }])
    expect(listPendingConnections(roomB)).toEqual([])
    // Clearing it in the room that doesn't have it is a no-op, so one room's
    // presenter can't evict another room's pending socket.
    expect(removePendingConnection(roomB, 'sock-1')).toBe(false)
    expect(listPendingConnections(roomA)).toHaveLength(1)
  })

  it('slide/step position is per room', () => {
    roomA.session.currentSlideIndex = 7
    roomA.session.currentStepId = 'install-deps'

    expect(roomB.session.currentSlideIndex).toBe(1)
    expect(roomB.session.currentStepId).toBe('1')
  })

  it('findRoomByParticipantId resolves the room that minted the id, and nothing for a stranger', () => {
    joinParticipant(roomA, 'Ada', undefined, () => 'a1', 'sock-a')
    joinParticipant(roomB, 'Bob', undefined, () => 'b1', 'sock-b')

    expect(findRoomByParticipantId('a1')).toBe(roomA)
    expect(findRoomByParticipantId('b1')).toBe(roomB)
    expect(findRoomByParticipantId('never-joined-anywhere')).toBeUndefined()
  })

  it('destroying one session leaves the other fully intact', () => {
    joinParticipant(roomB, 'Bob', undefined, () => 'b1', 'sock-b')

    destroySession('ROOM-A')

    expect(getRoom('ROOM-A')).toBeUndefined()
    expect(getRoom('ROOM-B')).toBe(roomB)
    expect(roomB.participants.get('b1')?.name).toBe('Bob')
  })
})
