import type { Socket } from 'socket.io-client'
import { onBeforeUnmount, onMounted } from 'vue'

/**
 * Registers a batch of socket event listeners in `onMounted` and removes
 * those exact same listeners in `onBeforeUnmount` — the shape every
 * global-layer component in this addon needs whenever it *listens* for a
 * server-pushed event (as opposed to only ever emitting, which
 * `StepReporter.vue`/`presenter:setStep` and `PresenceReporter.vue`'s
 * heartbeat/visibility reports do, and which this composable has nothing to
 * offer). Pulled out once a second component (`ErrorReportWidget.vue`, two
 * listeners) needed the identical register/cleanup pair `JoinScreen.vue`
 * already had (one listener, `disconnect`) — before this, the two had
 * quietly drifted: `JoinScreen.vue`'s registered unconditionally regardless
 * of route, `ErrorReportWidget.vue`'s did too. Neither was a real bug (the
 * server never force-disconnects the presenter's own socket, and the
 * presenter never owns an error report to be notified about), but a
 * presenter's own socket has no business carrying participant-facing
 * listeners at all — every *other* piece of participant-facing state in
 * this addon already skips itself entirely on that route. This gives every
 * future listener that same guard for free instead of relying on each new
 * call site to remember it.
 *
 * `enabled` is a function, not a plain boolean, so a caller can pass
 * `() => isPresenter.value` and have it evaluated at the moment `onMounted`
 * actually fires rather than a value captured (and potentially stale) at
 * the call site. The decision is evaluated once, at mount, and reused as-is
 * for cleanup — so a listener that was skipped at mount time is never
 * (redundantly, but confusingly) `.off()`'d later just because `enabled()`
 * would now return something different.
 */
export function useSocketListeners(
  socket: Socket,
  listeners: Record<string, (...args: any[]) => void>,
  options?: { enabled?: () => boolean },
): void {
  const isEnabled = options?.enabled ?? (() => true)
  let registered = false

  onMounted(() => {
    registered = isEnabled()
    if (!registered)
      return
    for (const [event, handler] of Object.entries(listeners))
      socket.on(event, handler)
  })

  onBeforeUnmount(() => {
    if (!registered)
      return
    for (const [event, handler] of Object.entries(listeners))
      socket.off(event, handler)
  })
}
