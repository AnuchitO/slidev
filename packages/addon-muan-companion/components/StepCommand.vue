<!--
Renders a command for participants to run, with Copy/Done buttons wired to
the muan-companion sync server (plan 027, PRD §8).

Usage:

<StepCommand command="cd workshop-repo && npm install" />

`command` is optional — PRD §8: "some slides won't have a command; the Done
button should still be available so participants can acknowledge
'read/understood' steps too." The step's key (`stepId`) is read from the
current slide's frontmatter, falling back to the slide index if omitted (see
`../src/stepId.ts`).

Global component — auto-registered from this addon's `components/`
directory the same way theme components are (see
`packages/slidev/node/vite/components.ts`'s `dirs` including
`roots.map(i => join(i, 'components'))`, and `roots` includes addon roots).
No explicit import needed in slide markdown.
-->
<script setup lang="ts">
import type { StepCommandStatus } from '../src/stepCommandStatus'
import { useNav } from '@slidev/client'
import { computed, ref } from 'vue'
import { getWorkshopSocket } from '../src/client'
import { nextStepCommandStatus } from '../src/stepCommandStatus'
import { resolveStepId } from '../src/stepId'

const props = defineProps<{
  command?: string
}>()

const { currentFrontmatter, currentSlideNo } = useNav()

const stepId = computed(() => resolveStepId(currentFrontmatter.value, currentSlideNo.value))

const status = ref<StepCommandStatus>('idle')

function apply(action: Parameters<typeof nextStepCommandStatus>[1]) {
  status.value = nextStepCommandStatus(status.value, action)
}

async function onCopy() {
  if (props.command) {
    try {
      await navigator.clipboard.writeText(props.command)
    }
    catch (error) {
      // Clipboard access can fail (non-HTTPS/non-localhost origin, denied
      // permission, unsupported browser) — the participant can still select
      // and copy the text manually from the <code> block below, and
      // acknowledging the step via the server round-trip below doesn't
      // depend on the clipboard write having succeeded.
      console.error('[muan-companion] clipboard write failed', error)
    }
  }
  apply('click-copy')
  getWorkshopSocket().emit('participant:copy', { stepId: stepId.value }, () => {
    apply('ack-copy')
  })
}

function onDone() {
  apply('click-done')
  getWorkshopSocket().emit('participant:done', { stepId: stepId.value }, () => {
    apply('ack-done')
  })
}
</script>

<template>
  <div class="muan-companion-step-command">
    <code v-if="command" class="muan-companion-step-command-code">{{ command }}</code>
    <div class="muan-companion-step-command-actions">
      <button
        v-if="command"
        type="button"
        class="muan-companion-step-command-button"
        :disabled="status === 'pending-copy'"
        @click="onCopy"
      >
        {{ status === 'pending-copy' ? 'Copying…' : status === 'copied' || status === 'pending-done' || status === 'done' ? 'Copied' : 'Copy' }}
      </button>
      <button
        type="button"
        class="muan-companion-step-command-button muan-companion-step-command-button-done"
        :disabled="status === 'pending-done' || status === 'done'"
        @click="onDone"
      >
        {{ status === 'pending-done' ? 'Marking done…' : status === 'done' ? 'Done ✓' : 'Done' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.muan-companion-step-command {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.75em;
  margin: 0.75em 0;
  padding: 0.5em 0.75em;
  border: 1px solid rgba(128, 128, 128, 0.3);
  border-radius: 8px;
}
.muan-companion-step-command-code {
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  white-space: pre;
}
.muan-companion-step-command-actions {
  display: flex;
  gap: 0.5em;
  flex: 0 0 auto;
}
.muan-companion-step-command-button {
  padding: 0.25em 0.75em;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.85em;
}
.muan-companion-step-command-button:disabled {
  cursor: default;
  opacity: 0.7;
}
.muan-companion-step-command-button-done {
  border-color: rgba(47, 168, 107, 0.6);
}
</style>
