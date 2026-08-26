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
-->
<script setup lang="ts">
import { useNav } from '@slidev/client'
import { onMounted, ref } from 'vue'
import { getWorkshopSocket } from '../src/client'

const STORAGE_KEY = 'workshop-tracker:participant'

interface StoredParticipant {
  participantId: string
  name: string
  /**
   * Persisted alongside identity (plan 029) so a same-tab reload can
   * auto-rejoin without re-prompting for the code — this is the low(er)-
   * privilege participant room code (PRD §12), not the presenter
   * credential, so sessionStorage is an acceptable place for it (unlike the
   * presenter code — see `../src/presenterCode.ts`'s comment on why *that*
   * one is never persisted/embedded anywhere).
   */
  roomCode: string
}

const { isPresenter } = useNav()

const joined = ref(false)
const submitting = ref(false)
const name = ref('')
const roomCode = ref('')
const joinError = ref('')

function readStoredParticipant(): StoredParticipant | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw)
      return undefined
    const parsed = JSON.parse(raw)
    if (typeof parsed?.participantId === 'string' && typeof parsed?.name === 'string' && typeof parsed?.roomCode === 'string')
      return parsed
    return undefined
  }
  catch {
    // sessionStorage can throw (private browsing, disabled storage) — treat
    // the same as "nothing stored", falling back to asking for a name.
    return undefined
  }
}

function writeStoredParticipant(participant: StoredParticipant) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(participant))
  }
  catch {
    // Best-effort only — 030's fuller reconnect/resume story can revisit if
    // this ever needs to be reliable rather than a nice-to-have.
  }
}

function join(joinName: string, joinRoomCode: string, participantId?: string) {
  submitting.value = true
  joinError.value = ''
  getWorkshopSocket().emit(
    'participant:join',
    { name: joinName, participantId, roomCode: joinRoomCode },
    (ack: { participantId: string, currentSlideIndex: number } | { error: string }) => {
      submitting.value = false
      // Plan 029: the server rejects a wrong/missing room code via this ack
      // rather than a forced disconnect — surface it so the participant can
      // correct the code and retry without reloading the page.
      if ('error' in ack) {
        joinError.value = 'That room code was not accepted — check it and try again.'
        return
      }
      writeStoredParticipant({ participantId: ack.participantId, name: joinName, roomCode: joinRoomCode })
      joined.value = true
    },
  )
}

onMounted(() => {
  const stored = readStoredParticipant()
  if (stored)
    join(stored.name, stored.roomCode, stored.participantId)
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
    <form class="workshop-tracker-join-card" @submit.prevent="onSubmit">
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
