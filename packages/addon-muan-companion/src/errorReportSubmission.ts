/**
 * Builds the multipart body for `POST /api/screenshot` (`slidev-muan-companion-server`'s
 * upload endpoint, plan 028 Step 1). Kept as a pure function — separate from
 * `ErrorReportWidget.vue`'s `fetch` call — so the request shape is
 * unit-testable without a running server, and so it's the single place that
 * decides the field names, matching the server's contract.
 */
export interface ScreenshotSubmission {
  participantId: string
  stepId: string
  text?: string
  blob: Blob
  filename?: string
}

export function buildScreenshotFormData(input: ScreenshotSubmission): FormData {
  const form = new FormData()
  form.set('participantId', input.participantId)
  form.set('stepId', input.stepId)
  const trimmedText = input.text?.trim()
  if (trimmedText)
    form.set('text', trimmedText)
  form.set('screenshot', input.blob, input.filename ?? 'screenshot.png')
  return form
}
