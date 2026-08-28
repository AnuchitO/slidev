/**
 * Wire payload shapes for the sync-server socket events `<ErrorReportWidget>`
 * listens for/emits, pulled out of that component's `<script setup>` block
 * (where they used to be redeclared inline at each listener/emit call site)
 * so the same shape can't drift between e.g. `onErrorResolved`'s handler and
 * a future second reader of `participant:errorResolved`. Mirrors
 * `participantIdentity.ts`'s existing `JoinAck`/`JoinErrorAck` — that file
 * stays the source of truth for `participant:join`'s ack shapes since it
 * already owns the identity-resume logic those types feed into; this module
 * is the equivalent home for the newer "Ask for Help" event shapes, which
 * don't belong in an identity-focused file.
 */

/**
 * `participant:errorResolved` — sent to one participant's own socket
 * (never broadcast) when the presenter proposes a report is fixed. See
 * `ErrorReportWidget.vue`'s `onErrorResolved` for the resulting UI.
 */
export interface ErrorResolvedPayload {
  errorId: string
  stepId: string
  status: string
  message?: string
}

/**
 * `participant:message` — a plain presenter reply with no resolution
 * decision attached. See `ErrorReportWidget.vue`'s `onPresenterMessage`.
 */
export interface PresenterMessagePayload {
  errorId: string
  stepId: string
  text: string
}

/**
 * `participant:confirmResolution` — the participant's answer to a
 * `participant:errorResolved` offer. Shared by `confirmFixed` (always
 * `confirmed: true`, no message) and `sendReopen` (`confirmed: false`, an
 * optional follow-up note) in `ErrorReportWidget.vue`, which previously
 * typed this shape inline in only one of those two call sites.
 */
export interface ConfirmResolutionPayload {
  errorId: string
  confirmed: boolean
  message?: string
}
