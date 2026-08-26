import type { Participant } from './session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS, sweepStaleParticipants } from './presence'

function makeParticipant(overrides: Partial<Participant> = {}): Participant {
  return {
    id: 'p1',
    name: 'Ada',
    joinedAt: Date.now(),
    lastSeen: Date.now(),
    connected: true,
    visibility: 'visible',
    socketId: 'socket-1',
    ...overrides,
  }
}

describe('sweepStaleParticipants', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('documents the staleness multiple as 3x the heartbeat interval', () => {
    expect(STALE_AFTER_MS).toBe(HEARTBEAT_INTERVAL_MS * 3)
  })

  it('leaves a recently-heard-from connected participant alone', () => {
    const participants = new Map([['p1', makeParticipant({ lastSeen: 0 })]])
    vi.setSystemTime(HEARTBEAT_INTERVAL_MS) // well under the stale threshold

    const changed = sweepStaleParticipants(participants, () => true)

    expect(changed).toBe(false)
    expect(participants.get('p1')!.connected).toBe(true)
    expect(participants.get('p1')!.visibility).toBe('visible')
  })

  it('does NOT mark a participant closed on staleness alone if its socket is still connected', () => {
    const participants = new Map([['p1', makeParticipant({ lastSeen: 0 })]])
    vi.setSystemTime(STALE_AFTER_MS + 1)

    const changed = sweepStaleParticipants(participants, () => true)

    expect(changed).toBe(false)
    expect(participants.get('p1')!.connected).toBe(true)
  })

  it('marks a participant closed once stale AND its socket is no longer connected (hung connection)', () => {
    const participants = new Map([['p1', makeParticipant({ lastSeen: 0 })]])
    vi.setSystemTime(STALE_AFTER_MS + 1)

    const changed = sweepStaleParticipants(participants, () => false)

    expect(changed).toBe(true)
    expect(participants.get('p1')!.connected).toBe(false)
    expect(participants.get('p1')!.visibility).toBe('closed')
  })

  it('does not touch a participant already marked disconnected', () => {
    const participants = new Map([['p1', makeParticipant({ lastSeen: 0, connected: false, visibility: 'closed' })]])
    vi.setSystemTime(STALE_AFTER_MS + 1)

    const changed = sweepStaleParticipants(participants, () => false)

    expect(changed).toBe(false)
  })

  it('sweeps multiple participants independently, only flipping the stale+disconnected one', () => {
    const stale = makeParticipant({ id: 'p1', socketId: 'gone', lastSeen: 0 })
    const fresh = makeParticipant({ id: 'p2', socketId: 'alive', lastSeen: STALE_AFTER_MS })
    const participants = new Map([['p1', stale], ['p2', fresh]])
    vi.setSystemTime(STALE_AFTER_MS + 1)

    const changed = sweepStaleParticipants(participants, p => p.socketId === 'alive')

    expect(changed).toBe(true)
    expect(participants.get('p1')!.connected).toBe(false)
    expect(participants.get('p2')!.connected).toBe(true)
  })
})
