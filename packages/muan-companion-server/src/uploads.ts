import { resolve } from 'pathe'

/**
 * Screenshot upload size cap for `POST /api/screenshot` (plan 028 Step 1).
 * 5MB comfortably covers a single full-screen PNG/JPEG capture from
 * `getDisplayMedia` at the target 50-100 participant workshop scale without
 * risking meaningful memory/disk pressure — see this package's README for
 * the disk-vs-memory storage trade-off this cap is paired with.
 */
export const UPLOAD_MAX_BYTES = 5 * 1024 * 1024

/**
 * Content types accepted for a screenshot upload, mapped to the extension
 * used for the file written to disk. Anything else is rejected outright
 * (no sniffing/coercion) — `getDisplayMedia` captures are always one of
 * these in the target browsers (PRD §12).
 */
export const ALLOWED_SCREENSHOT_MIME_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/**
 * Every file this server ever writes to (or serves from) the uploads
 * directory is named `${randomUUID()}.${ext}` by the server itself — never
 * by a client-supplied filename (see `server.ts`'s upload handler, which
 * ignores the multipart `filename` field entirely for path construction).
 * This regex is the single source of truth for "safe upload filename" on
 * both the write side (defense-in-depth, since the name is already
 * server-generated) and the read side (`GET /uploads/:filename`, where the
 * filename genuinely comes from an untrusted URL segment) — mirroring
 * plans 014-016's discipline of constraining path-derived input to an
 * explicit safe shape rather than blocklisting `../`.
 */
const SAFE_UPLOAD_FILENAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:png|jpg|webp)$/

export function isSafeUploadFilename(filename: string): boolean {
  return SAFE_UPLOAD_FILENAME_RE.test(filename)
}

/**
 * Resolves a requested upload filename against the confined uploads
 * directory, returning `undefined` for anything that isn't a
 * `isSafeUploadFilename` match *or* that would (somehow) still resolve
 * outside the directory once joined — the same "constrain the shape, then
 * confirm containment" pattern as plan 016's `sanitizeExportBasename`,
 * applied to a directory-scoped read instead of a write. A caller (the
 * `GET /uploads/:filename` handler) has one place to reject unsafe
 * requests rather than trusting string concatenation or a third-party
 * static-file server alone.
 */
export function resolveUploadPath(uploadsDir: string, filename: string): string | undefined {
  if (!isSafeUploadFilename(filename))
    return undefined

  const base = resolve(uploadsDir)
  const resolved = resolve(base, filename)
  if (resolved !== base && !resolved.startsWith(`${base}/`))
    return undefined

  return resolved
}
