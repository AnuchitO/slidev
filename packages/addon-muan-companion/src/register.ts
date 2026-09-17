import { getMuanCompanionServerUrl } from './client'

/**
 * The result `muan-companion-server`'s `POST /api/register` returns on success
 * (plan 032d). Mirrors that endpoint's response body exactly — see
 * `registrationRoutes.ts`'s `handleRegister`.
 */
interface RegisterResponse {
  roomCode: string
  presenterCode: string
  presenterUrl: string
  participantUrl?: string
}

/**
 * Guard against this deck registering itself more than once.
 *
 * Module-scoped rather than a parameter, for the same reason `client.ts`
 * memoizes its socket at module scope: an ES module is a singleton per bundle,
 * so every importer shares this. It matters because a connect key is
 * **single-use** on the server — a second registration attempt with the same
 * key is guaranteed to fail, and would only serve to burn one of the
 * registering source's rate-limit attempts (see `connectKey.ts`'s
 * `MAX_FAILED_ATTEMPTS`) and print a confusing failure to a console where the
 * first attempt had already succeeded. Slidev's app setup runs once per page
 * load, but a hot-reload during `slidev dev` can re-run module init, which is
 * exactly the case this catches.
 */
let registrationStarted = false

/**
 * Build-time env var carrying a one-time connect key minted by
 * `POST /api/connect-key` (plan 032 Flow B step 2).
 *
 * `VITE_`-prefixed and read through `import.meta.env`, the same mechanism
 * `getMuanCompanionServerUrl` already uses — Vite resolves `VITE_*` from
 * `process.env` at dev-server/build start, so an operator sets it inline when
 * starting their own `slidev dev` and nothing else in the toolchain needs to
 * know about it.
 *
 * **This value is baked into the built bundle**, exactly like the server URL
 * next to it. For the server URL that's harmless (it's a public address). For
 * a connect key it is only acceptable because of what a connect key *is*: a
 * credential that expires in five minutes and dies on first use. By the time
 * any built artifact could be shared, the key in it is long dead. That is the
 * whole reason Flow B uses a one-time key rather than, say, the admin code —
 * see `adminAuth.ts`. A deck built with this set should still not be published
 * as-is; the key is spent, but publishing spent credentials is a bad habit to
 * build, and `muan-companion.md` §2 says so.
 */
function getConnectKey(): string | undefined {
  return import.meta.env.VITE_SLIDEV_MUAN_COMPANION_CONNECT_KEY || undefined
}

/**
 * Registers this already-running deck with the companion server, if — and only
 * if — an operator opted in by setting `VITE_SLIDEV_MUAN_COMPANION_CONNECT_KEY`
 * (plan 032d, Flow B).
 *
 * **With the env var unset this is a complete no-op**: no fetch, no log, no
 * behavior change of any kind. That is load-bearing, not incidental — every
 * existing deployment of this addon runs without the var, and Flow B must be
 * strictly additive for them. The early return is the first statement in the
 * function for exactly that reason.
 *
 * ## Why the result goes to the console
 *
 * The deck itself has no UI for this and deliberately gets none. The operator
 * needs to *see* the room code and presenter URL to actually use them, and the
 * only surfaces this addon owns are participant-facing: `JoinScreen.vue` (the
 * name-entry overlay every participant sees) and `ErrorReportWidget.vue` (the
 * ask-for-help button). Rendering an operator's presenter URL — which carries
 * the presenter credential in its query string — into either of them would
 * project a high-privilege secret onto a screen a whole room is looking at.
 * There is no existing operator-only toast/banner primitive in this package to
 * reuse, and inventing one is out of 032d's scope and would be the wrong call
 * anyway for a value that must not be displayed.
 *
 * The browser console is the correct surface: it's on the operator's own
 * machine, it's already where this addon reports every other failure
 * (`[muan-companion]`-prefixed, see `StepCommand.vue`/`ErrorReportWidget.vue`),
 * and it is not visible to a projected audience. `console.info` for success
 * and `console.error` for failure, so a failed registration surfaces at the
 * severity that gets an operator's attention rather than scrolling past.
 *
 * Never throws and never rejects: it is called from app setup, where an
 * unhandled rejection would be a page-level error for what is, at worst, an
 * optional convenience that didn't happen. A failure means the deck simply
 * runs unregistered — exactly the pre-032d behavior.
 */
export async function registerDeckIfConfigured(): Promise<void> {
  const connectKey = getConnectKey()
  if (!connectKey)
    return

  if (registrationStarted)
    return
  registrationStarted = true

  // The deck's *own* origin, read at runtime, rather than anything
  // configurable. This is the one value the operator can't get wrong, and it's
  // the value that's actually true: whatever address this page was loaded
  // from is, by definition, an address a participant's browser can reach. An
  // env var here would just be a second thing to typo. `origin` specifically
  // (not `href`) — the server builds `${deckUrl}?roomCode=…` and
  // `${deckUrl}/presenter/1?code=…` on top of it, so a path or hash from the
  // presenter's current slide has no business being in it.
  const deckUrl = window.location.origin
  const serverUrl = getMuanCompanionServerUrl()

  try {
    const response = await fetch(`${serverUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connectKey, deckUrl }),
    })

    if (!response.ok) {
      // The server returns one deliberately uninformative body for every
      // registration failure — it must not be a key oracle (see
      // `registrationRoutes.ts`'s `REGISTRATION_FAILED_BODY`). So the useful
      // diagnosis has to come from *this* side, where the operator can see
      // both values they supplied: the status plus the deck URL that was
      // actually sent is enough to tell "my key expired" from "my deck URL
      // isn't what I thought it was". The key itself is never logged.
      console.error(`[muan-companion] deck registration failed (HTTP ${response.status}) for deckUrl ${deckUrl} — the connect key may be expired, already used, or mistyped. Mint a fresh one and restart the deck.`)
      return
    }

    const result = await response.json() as RegisterResponse
    // eslint-disable-next-line no-console -- operator-facing result; the deck has no UI for this, see this function's doc comment.
    console.info(
      `[muan-companion] deck registered. Room code (give to participants): ${result.roomCode}\n`
      + `[muan-companion] Presenter URL (yours only — do not project this): ${result.presenterUrl}\n`
      + `[muan-companion] Participant join link: ${result.participantUrl ?? deckUrl}`,
    )
  }
  catch (error) {
    // Network-level failure — server not running, wrong
    // `VITE_SLIDEV_MUAN_COMPANION_SERVER_URL`, CORS refusal. Distinct from the
    // `!response.ok` branch above and worth its own message, since the fix is
    // a completely different one (check the server URL, not the key).
    console.error(`[muan-companion] deck registration could not reach ${serverUrl}`, error)
  }
}

/**
 * Test-only reset for the once-per-page guard above. Exported rather than
 * reached via module re-import so a test can exercise the "called twice"
 * behavior and the "fresh page load" behavior in the same file.
 */
export function resetRegistrationStateForTests(): void {
  registrationStarted = false
}
