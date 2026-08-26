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
import { onMounted, ref } from 'vue'
import { getWorkshopSocket } from '../src/client'
import {
  clearStoredParticipant,
  currentParticipant,
  readStoredParticipant,
  resolveJoinAckOutcome,
  shouldOfferJoinAsSomeoneElse,
  writeStoredParticipant,
} from '../src/participantIdentity'

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

function join(joinName: string, joinRoomCode: string, participantId?: string) {
  submitting.value = true
  joinError.value = ''
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
      // it instead of minting yet another one.
      if (resolveJoinAckOutcome(participantId, ack) === 'resume-failed') {
        pendingParticipantId.value = ack.participantId
        clearStoredParticipant()
        resuming.value = false
        name.value = joinName
        roomCode.value = joinRoomCode
        return
      }
      const participant = { participantId: ack.participantId, name: joinName, roomCode: joinRoomCode }
      writeStoredParticipant(participant)
      currentParticipant.value = participant
      joined.value = true
      resuming.value = false
      resumedKnownIdentity.value = shouldOfferJoinAsSomeoneElse(participantId, ack)
    },
  )
}

onMounted(() => {
  const stored = readStoredParticipant()
  if (stored) {
    resuming.value = true
    join(stored.name, stored.roomCode, stored.participantId)
  }
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
function joinAsSomeoneElse() {
  clearStoredParticipant()
  currentParticipant.value = undefined
  pendingParticipantId.value = undefined
  resumedKnownIdentity.value = false
  name.value = ''
  roomCode.value = ''
  joinError.value = ''
  joined.value = false
  resuming.value = false
}
</script>

<template>
  <div v-if="!isPresenter && !joined" class="workshop-tracker-join-screen">
    <div v-if="resuming" class="workshop-tracker-join-card workshop-tracker-resuming">
      <p class="workshop-tracker-join-hint">
        Resuming your session…
      </p>
    </div>
    <form v-else class="workshop-tracker-join-card" @submit.prevent="onSubmit">
      <h1 class="workshop-tracker-join-title">
        Join the workshop
      </h1>
      <p class="workshop-tracker-join-hint">
        Enter your name so the instructor can see your progress.
      </p>
      <input
        v-model="name"
        type="text"
        placeholder="Your name"
        autofocus
        autocomplete="off"
        :disabled="submitting"
        class="workshop-tracker-join-input"
      >
      <input
        v-model="roomCode"
        type="text"
        placeholder="Room code"
        autocomplete="off"
        :disabled="submitting"
        class="workshop-tracker-join-input"
      >
      <p v-if="joinError" class="workshop-tracker-join-error">
        {{ joinError }}
      </p>
      <button type="submit" class="workshop-tracker-join-button" :disabled="submitting || !name.trim() || !roomCode.trim()">
        {{ submitting ? 'Joining…' : 'Join' }}
      </button>
    </form>
  </div>
  <button
    v-if="!isPresenter && joined && resumedKnownIdentity"
    type="button"
    class="workshop-tracker-not-you"
    @click="joinAsSomeoneElse"
  >
    Not you? Join as someone else
  </button>
</template>

<style scoped>
.workshop-tracker-join-screen {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(10, 10, 14, 0.75);
  backdrop-filter: blur(3px);
}
.workshop-tracker-join-card {
  display: flex;
  flex-direction: column;
  gap: 0.75em;
  min-width: 280px;
  padding: 2em;
  border-radius: 12px;
  background: #17181d;
  color: #f0f0f2;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
.workshop-tracker-join-title {
  margin: 0;
  font-size: 1.15em;
}
.workshop-tracker-join-hint {
  margin: 0;
  font-size: 0.85em;
  opacity: 0.75;
}
.workshop-tracker-join-error {
  margin: 0;
  font-size: 0.85em;
  color: #e35d5d;
}
.workshop-tracker-join-input {
  padding: 0.5em 0.75em;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font-size: 1em;
}
.workshop-tracker-join-button {
  padding: 0.5em 0.75em;
  border-radius: 6px;
  border: none;
  background: #2fa86b;
  color: #0b0d12;
  font-weight: 600;
  cursor: pointer;
}
.workshop-tracker-join-button:disabled {
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
.workshop-tracker-not-you {
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
.workshop-tracker-not-you:hover {
  opacity: 1;
}
</style>
