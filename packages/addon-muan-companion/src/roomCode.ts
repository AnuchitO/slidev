/**
 * Reads the participant room code (PRD §12) out of the current page's own
 * URL — `?roomCode=<code>` — the counterpart to `getPresenterCodeFromUrl`
 * (see that module's own doc comment for the full reasoning this mirrors).
 * Unlike the presenter code, the room code was never a *build-time* secret
 * problem to begin with — it's low-privilege and handed out to the whole
 * room on purpose (see `muan-companion-server`'s README's "Auth" section) —
 * so reading it from the URL isn't about avoiding a shipped-bundle leak the
 * way the presenter code is. It exists for a different, purely
 * user-experience reason: the "shareable join link + QR code" feature
 * (`muan-companion-server`'s `buildJoinUrl`) hands participants a URL with
 * the room code already embedded, and this is the client-side half that
 * reads it back out — see `JoinScreen.vue`'s call site for why that's a
 * prefill*, not a bypass of the join step itself.
 *
 * Called fresh (not cached at module scope) everywhere it's used — cheap,
 * and it means a participant who edits the URL (e.g. a typo'd code handed
 * out verbally, corrected by hand) doesn't need any extra invalidation
 * logic.
 */
export function getRoomCodeFromUrl(): string | undefined {
  if (typeof window === 'undefined')
    return undefined
  return new URLSearchParams(window.location.search).get('roomCode') ?? undefined
}
