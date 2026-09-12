/**
 * `<ErrorReportWidget>`'s screen-capture feature detection (plan 028 Step 2,
 * PRD §10/§12). Kept as a pure function taking plain values rather than
 * reading `navigator`/`location` directly, so it's unit-testable without a
 * real browser environment — the component (`ErrorReportWidget.vue`) is the
 * only caller that actually reads those globals.
 *
 * Explicit feature-detection, not try/catch-and-hope (per plan 028's own
 * instruction): a participant on a browser/context lacking the API, or on
 * an insecure non-localhost origin where `getDisplayMedia` would reject
 * even if present, must see a widget that never implies screen capture was
 * an option — the text box is always the fallback (PRD §10/§12).
 */
export interface ScreenCaptureEnv {
  hasGetDisplayMedia: boolean
  protocol: string
  hostname: string
}

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export function canCaptureScreen(env: ScreenCaptureEnv): boolean {
  if (!env.hasGetDisplayMedia)
    return false
  if (env.protocol === 'https:')
    return true
  return LOCALHOST_HOSTNAMES.has(env.hostname)
}
