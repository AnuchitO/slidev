/**
 * `<StepCommand>`'s local visual state (plan 027 Step 2: "driven by the
 * socket's own ack/echo, not by a naive 'clicked = done'"). A click moves to
 * a `pending-*` state immediately (so the button doesn't feel unresponsive);
 * only the matching server ack moves it to the confirmed state. An ack that
 * arrives while the button isn't in the matching pending state (e.g. a
 * stray/late ack after a rapid re-click) is ignored rather than silently
 * overwriting whatever the user did in the meantime.
 */
export type StepCommandStatus = 'idle' | 'pending-copy' | 'copied' | 'pending-done' | 'done'
export type StepCommandAction = 'click-copy' | 'ack-copy' | 'click-done' | 'ack-done'

export function nextStepCommandStatus(current: StepCommandStatus, action: StepCommandAction): StepCommandStatus {
  switch (action) {
    case 'click-copy':
      return 'pending-copy'
    case 'click-done':
      return 'pending-done'
    case 'ack-copy':
      return current === 'pending-copy' ? 'copied' : current
    case 'ack-done':
      return current === 'pending-done' ? 'done' : current
  }
}
