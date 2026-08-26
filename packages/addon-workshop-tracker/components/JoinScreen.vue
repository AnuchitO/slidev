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
      // rather than assuming success.
      if (resolveJoinAckOutcome(participantId, ack) === 'resume-failed') {
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
  join(trimmedName, trimmedRoomCode)
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
</style>
