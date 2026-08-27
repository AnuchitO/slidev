import { describe, expect, it } from 'vitest'
import { canCaptureScreen } from './errorReportCapability'

describe('canCaptureScreen', () => {
  it('is false when getDisplayMedia does not exist, regardless of origin', () => {
    expect(canCaptureScreen({ hasGetDisplayMedia: false, protocol: 'https:', hostname: 'example.com' })).toBe(false)
    expect(canCaptureScreen({ hasGetDisplayMedia: false, protocol: 'http:', hostname: 'localhost' })).toBe(false)
  })

  it('is true on https, when getDisplayMedia exists', () => {
    expect(canCaptureScreen({ hasGetDisplayMedia: true, protocol: 'https:', hostname: 'workshop.example.com' })).toBe(true)
  })

  it('is true on localhost over plain http, when getDisplayMedia exists', () => {
    expect(canCaptureScreen({ hasGetDisplayMedia: true, protocol: 'http:', hostname: 'localhost' })).toBe(true)
    expect(canCaptureScreen({ hasGetDisplayMedia: true, protocol: 'http:', hostname: '127.0.0.1' })).toBe(true)
    expect(canCaptureScreen({ hasGetDisplayMedia: true, protocol: 'http:', hostname: '[::1]' })).toBe(true)
  })

  it('is false on a plain http origin that is not localhost, even when getDisplayMedia exists', () => {
    // Some browsers still expose the API object on an insecure origin, but
    // calling it there rejects — PRD §10/§12's "requires HTTPS or
    // localhost" is a hard requirement, not just a capability check, so the
    // widget must not offer the button in this case either.
    expect(canCaptureScreen({ hasGetDisplayMedia: true, protocol: 'http:', hostname: 'workshop-room.local' })).toBe(false)
  })
})
