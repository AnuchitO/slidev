import { describe, expect, it } from 'vitest'
import { isSafeUploadFilename, resolveUploadPath } from './uploads'

describe('isSafeUploadFilename', () => {
  it('accepts a server-generated uuid + allowed extension', () => {
    expect(isSafeUploadFilename('4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.png')).toBe(true)
    expect(isSafeUploadFilename('4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.jpg')).toBe(true)
    expect(isSafeUploadFilename('4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.webp')).toBe(true)
  })

  it('rejects a filename containing a path-traversal segment', () => {
    expect(isSafeUploadFilename('../../etc/passwd')).toBe(false)
    expect(isSafeUploadFilename('..%2f..%2fetc%2fpasswd.png')).toBe(false)
    expect(isSafeUploadFilename('4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b/../../secret.png')).toBe(false)
  })

  it('rejects an absolute path', () => {
    expect(isSafeUploadFilename('/etc/passwd')).toBe(false)
  })

  it('rejects an unsupported extension', () => {
    expect(isSafeUploadFilename('4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.svg')).toBe(false)
  })

  it('rejects a non-uuid basename even with an allowed extension', () => {
    expect(isSafeUploadFilename('not-a-uuid.png')).toBe(false)
  })
})

describe('resolveUploadPath', () => {
  const uploadsDir = '/tmp/slidev-muan-companion-uploads-example'

  it('resolves a safe filename to a path inside the uploads dir', () => {
    const resolved = resolveUploadPath(uploadsDir, '4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.png')
    expect(resolved).toBe(`${uploadsDir}/4b2f9c3a-1e6d-4a8b-9f2a-0c1d2e3f4a5b.png`)
  })

  it('rejects a path-traversal attempt targeting a file outside the uploads dir', () => {
    expect(resolveUploadPath(uploadsDir, '../../../../etc/passwd')).toBeUndefined()
  })

  it('rejects an unsafe filename before ever resolving it', () => {
    expect(resolveUploadPath(uploadsDir, 'evil.png')).toBeUndefined()
  })
})
