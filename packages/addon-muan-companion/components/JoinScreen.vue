<!--
Full-screen name-entry overlay shown to participants before they can act on
`<StepCommand>` (plan 027, PRD §7's addon deliverable list item 2).

Gates on "have we received a `participant:join` ack yet", not on slide
rendering — the deck underneath keeps following the presenter (per 026)
whether or not this overlay is showing. Never shown on the presenter route
(`isPresenter`), since the instructor doesn't need a participant identity.

Mounted as a Global Layer (`../global-top.vue` — see
https://sli.dev/features/global-layers), Slidev's own extension point for a
persistent, always-mounted component with full injection context
(`useNav()` works here). This is a deliberate choice over the plan's
originally-sketched "app.component() + a small root-level teleport/overlay
pattern" in `setup/main.ts`: `setup/main.ts` runs pre-`app.mount()` outside
any component's setup context (see that file's own comment), so it can't use
`useNav()`/injection at all — Global Layers is the documented, correct
extension point for exactly this "persistent component across all slides"
use case, and avoids re-solving the injection-context problem 026 already
hit once.

Storage read/write and the shared `currentParticipant` ref live in
`../src/participantIdentity.ts` (plan 028) rather than inline here — once
`<ErrorReportWidget>` also needed to know "who joined", duplicating this
logic in two components would risk the two drifting.

Persists to `localStorage`, not `sessionStorage` — a follow-on fix to plan
030's resume story (see `participantIdentity.ts`'s doc comment) so a
closed-and-reopened tab, not just a same-tab refresh, still resumes the
same participant. The one consequence that introduces — a shared/kiosk
browser silently resuming the *previous* person's identity, with no way to
say "that's not me" — is handled by the small "Not you? Join as someone
else" button rendered after a successful resume, calling
`clearStoredParticipant()` and re-showing this join form blank.
-->
<script setup lang="ts">
import { useNav } from '@slidev/client'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getWorkshopSocket } from '../src/client'
import {
  clearStoredParticipant,
  currentParticipant,
  readStoredParticipant,
  resolveJoinAckOutcome,
  shouldOfferJoinAsSomeoneElse,
  writeStoredParticipant,
} from '../src/participantIdentity'
import { getRoomCodeFromUrl } from '../src/roomCode'

const { isPresenter } = useNav()

const joined = ref(false)
const submitting = ref(false)
// True while a *stored* participant is being auto-resumed on mount (plan 030
// Step 1) — while true, the overlay shows a lightweight "resuming" message
// instead of the name/room-code form, so a refreshing participant never sees
// the join prompt flash even for a frame; PRD §12 calls for resume to happen
// "without re-joining as a 'new' participant", which this reads as "skip the
// prompt entirely," not just "quietly reuse the same id behind an unchanged
// form".
const resuming = ref(false)
const name = ref('')
const roomCode = ref('')
const joinError = ref('')
// Set when a resume attempt fails (see below) — the server, per its own
// documented fallback behavior, already minted a *usable* fresh participant
// for that failed attempt (session.ts's 'resume-fallback' outcome always
// creates a real row, it just isn't the one the client asked to resume).
// The next submit resumes *that* id instead of asking for yet another one:
// without this, a second plain fresh join on the same socket would orphan
// the fallback's participant forever (its `socket.data.participantId` gets
// overwritten by the second join, so neither a clean disconnect nor the
// staleness sweep — whose "socket still connected" check would still see
// this same socket alive — would ever mark it closed, leaving a permanent
// duplicate/"ghost" row on the dashboard; found via plan 030's own manual
// server-restart verification, not a hypothetical).
const pendingParticipantId = ref<string | undefined>()
// True once this tab has joined by resuming an *already-known* identity —
// either the common case (a stored participantId from a previous visit,
// consumed automatically on mount) or the resume-fallback retry above —
// rather than a name/room-code the participant just typed for the first
// time. Drives the low-key "Not you?" link below: the localStorage switch
// (see participantIdentity.ts's doc comment) means this browser will keep
// silently resuming that identity indefinitely, which is exactly right for
// the same person coming back, but wrong for a shared/kiosk browser that a
// *different* person picks up next — this is their way out.
const resumedKnownIdentity = ref(false)

function join(joinName: string, joinRoomCode: string | undefined, participantId?: string) {
  submitting.value = true
  joinError.value = ''
  // Captured before the ack arrives — the branches below set `resuming` to
  // `false` themselves, so reading it *after* the callback fires would
  // always see the post-update value.
  const wasAutoResuming = resuming.value
  getWorkshopSocket().emit(
    'participant:join',
    { name: joinName, participantId, roomCode: joinRoomCode },
    (ack: { participantId: string, currentSlideIndex: number, resumed: boolean } | { error: string }) => {
      submitting.value = false
      // Plan 029: the server rejects a wrong/missing room code via this ack
      // rather than a forced disconnect — surface it so the participant can
      // correct the code and retry without reloading the page.
      if ('error' in ack) {
        resuming.value = false
        // Follow-up fix: the auto-resume call from `onMounted` below never
        // sends a room code at all (see `participantIdentity.ts` on why it's
        // no longer persisted) — a server that doesn't currently recognize
        // this `participantId` (e.g. it restarted) rejects that attempt with
        // this same `error` ack, but the participant never typed a wrong
        // code; they typed nothing. Showing "that code was not accepted"
        // here would blame them for something that isn't their fault. Clear
        // the now-confirmed-dead id and fall through to the ordinary join
        // form (pre-filled with their name) instead — the same shape as any
        // other fresh join, just one keystroke shorter.
        if (wasAutoResuming) {
          clearStoredParticipant()
          name.value = joinName
          return
        }
        joinError.value = 'That room code was not accepted — check it and try again.'
        return
      }
      // Plan 030 Step 1: a *requested* resume (participantId was supplied)
      // that the server couldn't honor — e.g. it restarted mid-workshop and
      // no longer knows this id (PRD §4/§14's accepted in-memory-reset case)
      // — must not silently rejoin as a "new" participant behind an
      // unchanged UI. Drop the stale id and show the join prompt again
      // (pre-filled, so the participant doesn't have to retype anything)
      // rather than assuming success — but remember the fallback's own new
      // id (see `pendingParticipantId` above) so the *next* submit resumes
      // it instead of minting yet another one. (In practice this specific
      // branch is now rare: a resume request without a room code that the
      // server can't honor is rejected by the `error` branch above before
      // ever reaching `joinParticipant` server-side, so there's no fallback
      // id to remember. It stays here as the correct handling for a resume
      // request that *does* carry a room code — e.g. a manual retry after
      // the branch above — and the outcome still comes back unresumed for
      // some other reason.)
      if (resolveJoinAckOutcome(participantId, ack) === 'resume-failed') {
        pendingParticipantId.value = ack.participantId
        clearStoredParticipant()
        resuming.value = false
        name.value = joinName
        roomCode.value = joinRoomCode ?? ''
        return
      }
      const participant = { participantId: ack.participantId, name: joinName }
      writeStoredParticipant(participant)
      currentParticipant.value = participant
      joined.value = true
      resuming.value = false
      resumedKnownIdentity.value = shouldOfferJoinAsSomeoneElse(participantId, ack)
    },
  )
}

onMounted(() => {
  // Pre-join dashboard visibility (`server.ts`'s `participant:connecting`
  // handler): lets the presenter see "someone's here" the moment a
  // participant browser loads, before they've typed a name or clicked
  // Join. Guarded on `!isPresenter` — this component mounts on *every*
  // route (its template's own `v-if="!isPresenter"` only hides the overlay,
  // it doesn't stop `onMounted` from running) — without this guard the
  // presenter's own tab would show up as an anonymous "pending" row on
  // their own dashboard, which would be actively confusing. Fired
  // unconditionally otherwise (whether about to auto-resume below or show
  // the fresh-join form) — either way this socket is "here but not joined
  // yet" until the `participant:join` call further down actually succeeds.
  if (!isPresenter.value)
    getWorkshopSocket().emit('participant:connecting')

  const stored = readStoredParticipant()
  if (stored) {
    resuming.value = true
    // No room code sent here, deliberately — see `participantIdentity.ts`'s
    // doc comment. A resume of an already-known identity doesn't need it
    // (server-side gate, `server.ts`'s `participant:join` handler); if the
    // server doesn't recognize this id, the `error` branch above handles it.
    join(stored.name, undefined, stored.participantId)
    return
  }
  // The ordinary fresh-join form is about to show (no stored identity to
  // resume) — prefill `roomCode` from the shareable join link's `?roomCode=`
  // query param (`muan-companion-server`'s `buildJoinUrl` / the dashboard's
  // "Share this workshop" panel) when the participant arrived via that link
  // or its QR code, rather than typing the code from a shout-out across the
  // room. This is a *convenience prefill*, not a bypass of the join step
  // itself: `roomCode` here only ever seeds the input's initial value — the
  // participant still has to type their own name and click "Join" (`onSubmit`
  // above) for a real `participant:join` to fire. Nothing in this branch
  // submits on their behalf.
  const roomCodeFromUrl = getRoomCodeFromUrl()
  if (roomCodeFromUrl)
    roomCode.value = roomCodeFromUrl
})

function onSubmit() {
  const trimmedName = name.value.trim()
  const trimmedRoomCode = roomCode.value.trim()
  if (!trimmedName || !trimmedRoomCode || submitting.value)
    return
  join(trimmedName, trimmedRoomCode, pendingParticipantId.value)
}

// The way out of a silent resume (see `resumedKnownIdentity` above): drops
// the stored identity and re-shows the join form, blank, for a fresh
// name/room-code entry — the same shape as a first-ever join on this
// browser. Deliberately *not* wired into the failed-resume path above
// (that already clears storage and re-prompts on its own); this is only for
// a *successful* resume the current person doesn't recognize as themselves.
//
// Bug fix (reported from live use): clearing local storage/state alone left
// the *server* still thinking the old identity is connected — this tab's
// socket is shared across the whole addon (`client.ts`'s memoized
// `getWorkshopSocket()`), so it never actually disconnects just because this
// component resets its own refs, and nothing else ever removes it from the
// old participant's `socketIds` (`session.ts`). The old row sat on the
// dashboard as "viewing now" forever — a permanent ghost — because
// `removeParticipantSocket` (the *only* thing that ever clears a socket out
// of that array) only runs from the server's `disconnect` handler.
//
// Forcing an actual disconnect + reconnect here, before resetting anything
// else, makes the server run that same handler for real: it releases this
// socket from the old identity (marking it `closed` unless another tab of
// theirs is still open — same multi-tab-safe behavior a real tab close
// gets), and the reconnect hands back a fresh socket id for the *new*
// identity's upcoming `participant:join` to attach to instead of reusing the
// old one. Manual `.disconnect()` intentionally does not auto-reconnect on
// its own even with `reconnection: true` (that option only covers
// *unexpected* drops) — `.connect()` right after is required, not optional.
function joinAsSomeoneElse() {
  const socket = getWorkshopSocket()
  socket.disconnect()
  socket.connect()

  resetToFreshJoin()
  joinError.value = ''
}

// Shared by `joinAsSomeoneElse` above and `onForciblyDisconnected` below —
// both mean "forget whoever this browser was and show the blank join form
// again", they just differ in *why* (the participant asked to switch
// identities vs. the presenter removed them) and in what, if anything, gets
// shown about it — left to each caller rather than folded in here.
function resetToFreshJoin() {
  clearStoredParticipant()
  currentParticipant.value = undefined
  pendingParticipantId.value = undefined
  resumedKnownIdentity.value = false
  name.value = ''
  roomCode.value = ''
  joined.value = false
  resuming.value = false
}

// The presenter's "Remove" button (dashboard, `presenter:kickParticipant`/
// `presenter:kickPendingConnection` — `muan-companion-server`'s README) ends
// with the server calling `socket.disconnect()` on this participant's own
// socket. Feature request from live use: being kicked should land the
// participant back on this join screen, ready to rejoin, not leave them
// staring at a frozen deck with no explanation.
//
// `reason === 'io server disconnect'` is Socket.io's own signal for exactly
// this case — a disconnect the *server* initiated, as opposed to a network
// drop, a backgrounded tab, or the page unloading (all of which the client
// reconnects from automatically via `reconnection: true` and must NOT reset
// an otherwise-fine session over). This server only ever calls
// `socket.disconnect()` on a participant's socket from the two kick
// handlers above — if that ever changes, this coupling needs re-checking,
// since this handler would then fire for whatever new reason too.
function onForciblyDisconnected(reason: string) {
  if (reason !== 'io server disconnect')
    return
  resetToFreshJoin()
  // The join form itself (rendered right below this message once `joined`
  // flips back to false) already shows the name/room-code fields — telling
  // them to "enter your name and room code" on top of that was redundant,
  // reported from live use.
  joinError.value = 'You were removed from this workshop by the instructor.'
  // Same "manual disconnect never auto-reconnects" reasoning as
  // `joinAsSomeoneElse` above — except here the server already did the
  // disconnecting; this side just needs to bring the socket back so a
  // resubmitted join form has something to emit on.
  getWorkshopSocket().connect()
}

onMounted(() => {
  getWorkshopSocket().on('disconnect', onForciblyDisconnected)
})
onBeforeUnmount(() => {
  getWorkshopSocket().off('disconnect', onForciblyDisconnected)
})
</script>

<template>
  <div v-if="!isPresenter && !joined" class="slidev-muan-companion-join-screen">
    <div v-if="resuming" class="slidev-muan-companion-join-card slidev-muan-companion-resuming">
      <p class="slidev-muan-companion-join-hint">
        Resuming your session…
      </p>
    </div>
    <form v-else class="slidev-muan-companion-join-card" @submit.prevent="onSubmit">
      <h1 class="slidev-muan-companion-join-title">
        Join the workshop
      </h1>
      <p class="slidev-muan-companion-join-hint">
        Enter your name so the instructor can see your progress.
      </p>
      <input
        v-model="name"
        type="text"
        placeholder="Your name"
        autofocus
        autocomplete="off"
        :disabled="submitting"
        class="slidev-muan-companion-join-input"
      >
      <input
        v-model="roomCode"
        type="text"
        placeholder="Room code"
        autocomplete="off"
        :disabled="submitting"
        class="slidev-muan-companion-join-input"
      >
      <p v-if="joinError" class="slidev-muan-companion-join-error">
        {{ joinError }}
      </p>
      <button type="submit" class="slidev-muan-companion-join-button" :disabled="submitting || !name.trim() || !roomCode.trim()">
        {{ submitting ? 'Joining…' : 'Join' }}
      </button>
    </form>
  </div>
  <button
    v-if="!isPresenter && joined && resumedKnownIdentity"
    type="button"
    class="slidev-muan-companion-not-you"
    @click="joinAsSomeoneElse"
  >
    Not you? Join as someone else
  </button>
</template>

<style scoped>
.slidev-muan-companion-join-screen {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 10, 14, 0.75);
  backdrop-filter: blur(3px);
}
.slidev-muan-companion-join-card {
  display: flex;
  flex-direction: column;
  gap: 0.75em;
  min-width: 280px;
  /* Without this, a long message in `.join-error` below had nothing
     stopping it from stretching the whole card wider to fit on one line —
     reported from live use (the "you were removed" message). `min()` caps
     it at a sane width on desktop while still shrinking on a narrow
     viewport, same pattern `ErrorReportWidget.vue`'s panels use. */
  max-width: min(360px, 90vw);
  padding: 2em;
  border-radius: 12px;
  background: #17181d;
  color: #f0f0f2;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
.slidev-muan-companion-join-title {
  margin: 0;
  font-size: 1.15em;
}
.slidev-muan-companion-join-hint {
  margin: 0;
  font-size: 0.85em;
  opacity: 0.75;
}
.slidev-muan-companion-join-error {
  margin: 0;
  font-size: 0.85em;
  color: #e35d5d;
  /* Wraps onto multiple lines within the now-capped card width instead of
     forcing it wider — belt-and-suspenders alongside `.join-card`'s own
     `max-width` above (this still matters for a single unbroken long
     word/token that `max-width` alone wouldn't wrap). */
  overflow-wrap: break-word;
}
.slidev-muan-companion-join-input {
  padding: 0.5em 0.75em;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font-size: 1em;
}
.slidev-muan-companion-join-button {
  padding: 0.5em 0.75em;
  border-radius: 6px;
  border: none;
  background: #2fa86b;
  color: #0b0d12;
  font-weight: 600;
  cursor: pointer;
}
.slidev-muan-companion-join-button:disabled {
  opacity: 0.6;
  cursor: default;
}
/*
 * Deliberately understated (small, low-opacity, bottom-left) — this is the
 * rare "wrong person on a shared/kiosk browser" case, not the common path,
 * and must not compete with <ErrorReportWidget>'s bottom-right button or
 * draw attention away from the deck for the (much more common) same-person
 * resume it's an escape hatch from.
 */
.slidev-muan-companion-not-you {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 900;
  padding: 0.3em 0.6em;
  border: none;
  border-radius: 6px;
  background: rgba(10, 10, 14, 0.55);
  color: #f0f0f2;
  opacity: 0.55;
  font-size: 0.7em;
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.slidev-muan-companion-not-you:hover {
  opacity: 1;
}
</style>
