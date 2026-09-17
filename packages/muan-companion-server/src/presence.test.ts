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
    socketIds: ['socket-1'],
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
    const stale = makeParticipant({ id: 'p1', socketIds: ['gone'], lastSeen: 0 })
    const fresh = makeParticipant({ id: 'p2', socketIds: ['alive'], lastSeen: STALE_AFTER_MS })
    const participants = new Map([['p1', stale], ['p2', fresh]])
    vi.setSystemTime(STALE_AFTER_MS + 1)

    const changed = sweepStaleParticipants(participants, p => p.socketIds.includes('alive'))

    expect(changed).toBe(true)
    expect(participants.get('p1')!.connected).toBe(false)
    expect(participants.get('p2')!.connected).toBe(true)
  })

  // Follow-up fix: a participant with more than one live socket (a second
  // browser tab, via localStorage resume) must not be swept closed just
  // because one of its sockets is dead — only when *none* of them are alive.
  it('does not close a participant that is stale but still has one live socket among several', () => {
    const participant = makeParticipant({ socketIds: ['dead-tab', 'live-tab'], lastSeen: 0 })
    const participants = new Map([['p1', participant]])
    vi.setSystemTime(STALE_AFTER_MS + 1)

    const changed = sweepStaleParticipants(participants, p => p.socketIds.includes('live-tab'))

    expect(changed).toBe(false)
    expect(participants.get('p1')!.connected).toBe(true)
  })

  it('clears socketIds when it does close a participant', () => {
    const participant = makeParticipant({ socketIds: ['dead-1', 'dead-2'], lastSeen: 0 })
    const participants = new Map([['p1', participant]])
    vi.setSystemTime(STALE_AFTER_MS + 1)

    sweepStaleParticipants(participants, () => false)

    expect(participants.get('p1')!.socketIds).toEqual([])
  })
})
