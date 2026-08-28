import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ErrorReport } from './session'
import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import Busboy from 'busboy'
import { join } from 'pathe'
import { addErrorReport, participants } from './session'
import { ALLOWED_SCREENSHOT_MIME_TYPES, UPLOAD_MAX_BYTES } from './uploads'

const UPLOAD_ROUTE = '/api/screenshot'

interface SavedFile {
  filename: string
  filePath: string
}

function respond(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { 'content-type': 'text/plain' }).end(body)
}

async function deleteQuietly(filePath: string) {
  try {
    await unlink(filePath)
  }
  catch {
    // Nothing to clean up (already gone), or a transient FS error — this is
    // a best-effort delete of a rejected upload, not load-bearing for
    // correctness (no retention/cleanup policy is in scope, plan 028's
    // explicit out-of-scope call).
  }
}

/**
 * Builds the `POST /api/screenshot` connect middleware (plan 028 Step 1,
 * PRD §10's REST upload path). Parses the multipart body with `busboy`
 * (the only new runtime dependency this plan adds — nothing in the
 * existing `socket.io`/`connect`/`sirv` footprint covers file uploads).
 *
 * The written filename is **always** `${randomUUID()}.${ext}` — the
 * multipart `filename` field busboy reports from the client is never used
 * to construct a path, so a crafted `../`-laden client filename has nothing
 * to traverse with on the write side (the read side's defense is
 * `uploads.ts`'s `resolveUploadPath`, exercised by the `GET /uploads/:file`
 * route in `server.ts`).
 *
 * Any request that isn't `POST /api/screenshot` falls through to `next()`
 * so this can sit in the same `connect()` chain as the `/dashboard` and
 * `/uploads` static mounts.
 */
export function createScreenshotUploadHandler(uploadsDir: string, onUploaded: (report: ErrorReport) => void) {
  return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
    if (req.method !== 'POST' || req.url !== UPLOAD_ROUTE) {
      next()
      return
    }

    let bb: ReturnType<typeof Busboy>
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: UPLOAD_MAX_BYTES, files: 1 } })
    }
    catch {
      // Missing/invalid Content-Type (not multipart at all) — Busboy throws
      // synchronously from its constructor for this rather than emitting an
      // error event.
      respond(res, 400, 'expected multipart/form-data')
      return
    }

    const fields: Record<string, string> = {}
    let savedFile: SavedFile | undefined
    let tooLarge = false
    let unsupportedType: string | undefined
    const filePromises: Promise<void>[] = []

    bb.on('field', (name, value) => {
      fields[name] = value
    })

    bb.on('file', (_name, stream, info) => {
      const ext = ALLOWED_SCREENSHOT_MIME_TYPES[info.mimeType]
      if (!ext) {
        unsupportedType = info.mimeType
        stream.resume() // drain and discard — an unsupported type is rejected outright, not sniffed/coerced.
        return
      }

      const filename = `${randomUUID()}.${ext}`
      const filePath = join(uploadsDir, filename)
      savedFile = { filename, filePath }

      stream.on('limit', () => {
        tooLarge = true
      })

      filePromises.push(
        new Promise<void>((resolveFile) => {
          const writeStream = createWriteStream(filePath)
          stream.pipe(writeStream)
          writeStream.on('finish', resolveFile)
          writeStream.on('error', resolveFile)
          stream.on('error', resolveFile)
        }),
      )
    })

    bb.on('close', () => {
      void (async () => {
        await Promise.all(filePromises)

        if (tooLarge) {
          if (savedFile)
            await deleteQuietly(savedFile.filePath)
          respond(res, 413, 'screenshot exceeds the upload size limit')
          return
        }

        if (unsupportedType) {
          respond(res, 400, `unsupported screenshot content type: ${unsupportedType}`)
          return
        }

        if (!savedFile) {
          // No file field at all — per plan 028 Step 2's decision, text-only
          // reports go over the WS `participant:error` event; this REST
          // endpoint is exclusively for uploads that carry a screenshot, so
          // the two paths never duplicate the same responsibility.
          respond(res, 400, 'screenshot file is required (use the participant:error WS event for text-only reports)')
          return
        }

        const { participantId, stepId, text } = fields
        const participant = participantId ? participants.get(participantId) : undefined
        if (!participant) {
          await deleteQuietly(savedFile.filePath)
          respond(res, 400, 'unknown participantId')
          return
        }
        if (!stepId) {
          await deleteQuietly(savedFile.filePath)
          respond(res, 400, 'stepId is required')
          return
        }

        // Screenshot capture is only ever offered on the "Report a problem"
        // tab (`ErrorReportWidget.vue` — the "Ask a question" tab is
        // text-only), so this upload path always tags the report `'problem'`
        // — there's no form field for `kind` to read here.
        const report = addErrorReport({
          id: randomUUID(),
          participantId: participant.id,
          participantName: participant.name,
          stepId,
          kind: 'problem',
          text: text || undefined,
          screenshotUrl: `/uploads/${savedFile.filename}`,
          ts: Date.now(),
        })

        onUploaded(report)
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ id: report.id, screenshotUrl: report.screenshotUrl }))
      })().catch(() => {
        // Belt-and-suspenders, same reasoning as `getJoinQrDataUrl`'s own
        // `.catch` in `server.ts`: this `connect` middleware runs outside
        // any framework that would catch a listener's own async rejection
        // for you, so an uncaught one here would surface as a process-level
        // `unhandledRejection` instead of a contained HTTP failure. Nothing
        // inside the IIFE above is expected to actually reject (every
        // awaited call already resolves-not-rejects on its own error path —
        // see `deleteQuietly` and the `writeStream`/`stream` `'error'`
        // listeners upstream), so this is a backstop against an unforeseen
        // failure, not a path this suite's tests are expected to exercise.
        if (!res.headersSent)
          respond(res, 500, 'internal error handling screenshot upload')
      })
    })

    req.pipe(bb)
  }
}
