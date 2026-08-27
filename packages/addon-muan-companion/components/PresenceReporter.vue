<!--
Renders nothing. Reports this participant's presence to the sync server
(plan 029 Step 2, PRD §10):

- `participant:visibility { state }` on the Page Visibility API's
  `visibilitychange` — maps directly to `document.visibilityState`
  ('visible' | 'hidden'). `'closed'` is never sent from here; it's inferred
  server-side (a clean `disconnect`, or `presence.ts`'s staleness sweep for
  a hung connection) — a closing tab can't reliably emit one more event, so
  there's no client-side path that could send it anyway.
- `participant:heartbeat { stepId }` every `HEARTBEAT_INTERVAL_MS`
  (mirrored as a plain constant here rather than importing the server
  package — this is a browser bundle, not a Node one; `presence.ts`'s
  `HEARTBEAT_INTERVAL_MS` is the source of truth this must stay in sync
  with. See this addon's README if the two ever drift.).

Gated on `!isPresenter`, matching `JoinScreen.vue` — the instructor's own
window doesn't hold a `Participant` record, so it has nothing to report
presence *as*. Not additionally gated on "has this browser actually joined
yet" (`JoinScreen`'s own local `joined` state isn't shared out to sibling
components, and introducing a shared store just for that gate isn't worth
it): the server-side handlers for both events already no-op safely when
`socket.data.participantId` is unset, the same pattern `participant:copy`/
`participant:done` already rely on (see `server.ts`) — so reporting
presence "for nobody yet" before the name form is submitted is simply
inert, not incorrect.

Mounted via `../global-top.vue` (Global Layers) alongside `<JoinScreen>` and
`<StepReporter>`, for the same "always-mounted, real injection context"
reason those two are.
-->
<script setup lang="ts">
import { useNav } from '@slidev/client'
import { onBeforeUnmount, onMounted } from 'vue'
import { getWorkshopSocket } from '../src/client'
import { resolveStepId } from '../src/stepId'

// Kept in sync with `packages/slidev-muan-companion-server/src/presence.ts`'s
// `HEARTBEAT_INTERVAL_MS` (5s) — see this file's own header comment on why
// it can't just import that server-side module directly.
const HEARTBEAT_INTERVAL_MS = 5_000

const { currentFrontmatter, currentSlideNo, isPresenter } = useNav()

function reportVisibility() {
  getWorkshopSocket().emit('participant:visibility', { state: document.visibilityState })
}

function reportHeartbeat() {
  const stepId = resolveStepId(currentFrontmatter.value, currentSlideNo.value)
  getWorkshopSocket().emit('participant:heartbeat', { stepId })
}

let heartbeatIntervalId: ReturnType<typeof setInterval> | undefined

onMounted(() => {
  if (isPresenter.value)
    return
  document.addEventListener('visibilitychange', reportVisibility)
  // Report once immediately (mirrors the `immediate: true` pattern
  // `StepReporter.vue` uses) rather than waiting the first full interval,
  // so a participant who joins and never backgrounds the tab still has a
  // `lastSeen` on record right away.
  reportHeartbeat()
  heartbeatIntervalId = setInterval(reportHeartbeat, HEARTBEAT_INTERVAL_MS)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', reportVisibility)
  if (heartbeatIntervalId !== undefined)
    clearInterval(heartbeatIntervalId)
})
</script>

<template>
  <!-- Renders nothing (see file-level comment) — a hidden element rather
       than an empty template, since Vue SFCs require a template root. -->
  <span hidden />
</template>
