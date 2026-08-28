/**
 * Wire payload shapes for every sync-server socket event this addon
 * consumes or emits with a non-trivial payload — the single source of truth
 * so the same shape can't drift between e.g. two independent readers of
 * `participant:errorResolved`, or between the type used here and the one
 * `muan-companion-server/src/server.ts` actually sends. Mirrors that
 * package's own `DashboardJoinAck` being the one server-side source of
 * truth for its ack shape.
 *
 * (Previously split two ways — `JoinAck`/`JoinErrorAck` here,
 * `ErrorResolvedPayload`/etc. in a second module — on the theory that
 * identity-resume shapes and "Ask for Help" shapes were different enough
 * concerns to deserve separate homes. Second review pass: that split wasn't
 * actually buying anything a single module doesn't — both halves are the
 * same kind of thing, "a payload shape this addon's client code and the
 * server have to agree on," and a reader looking for "what does the server
 * send me" had to already know which of two files to check. Consolidated
 * here; `participantIdentity.ts` now imports `JoinAck`/`JoinErrorAck` from
 * this module instead of declaring them, keeping its own file scoped to the
 * identity-*resolution logic* — `resolveJoinAckOutcome`,
 * `shouldOfferJoinAsSomeoneElse` — that actually belongs there.)
 */

/**
 * `participant:join`'s success ack — a fresh join or a successful resume
 * alike. See `JoinScreen.vue`'s `join()` call site and
 * `participantIdentity.ts`'s `resolveJoinAckOutcome`/
 * `shouldOfferJoinAsSomeoneElse`, which both take this shape as input.
 */
export interface JoinAck {
  participantId: string
  currentSlideIndex: number
  /** See `muan-companion-server`'s `participant:join` handler / README. */
  resumed: boolean
}

/**
 * The other shape a `participant:join` ack can take (plan 029: the server
 * rejects a wrong/missing room code this way rather than a forced
 * disconnect — see `JoinScreen.vue`'s call site). Exported alongside
 * `JoinAck` above so `JoinScreen.vue`'s ack callback can type its
 * `JoinAck | JoinErrorAck` parameter against this single source of truth
 * instead of redeclaring the same two object shapes inline.
 */
export interface JoinErrorAck {
  error: string
}

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
