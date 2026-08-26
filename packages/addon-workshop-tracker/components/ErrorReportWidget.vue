<!--
Persistent, low-chrome error-report widget (plan 028 Step 2, PRD §7 addon
deliverable list item 3): a small floating button, bottom-right of the
viewport, that expands into a form. Available on every slide regardless of
`stepId`/`<StepCommand>` presence — the current step is still attached to
the report via `resolveStepId` (`../src/stepId.ts`), same fallback rule
`<StepCommand>` uses.

Text box is always available (the required PRD §10/§12 fallback). The
"Capture screen" button only renders when `canCaptureScreen`
(`../src/errorReportCapability.ts`) is true — explicit feature detection,
not try/catch-and-hope, so a participant on a browser/context lacking
`getDisplayMedia` (or on an insecure non-localhost origin) never sees a
button that would only fail when clicked.

Submission transport (plan 028 Step 2's decision, not duplicated across two
paths):
- A captured screenshot → `POST /api/screenshot` (REST, multipart —
  `../src/errorReportSubmission.ts` builds the body) — the *only* path that
  ever carries a screenshot.
- No screenshot (text-only) → the WS `participant:error { stepId, text }`
  event (`../src/client.ts`'s shared socket) — the *only* path for a
  text-only report. Never both for the same submission.

Mounted as a Global Layer (`../global-top.vue`), same reasoning as
`JoinScreen.vue`: needs `useNav()`/full injection context, which
`setup/main.ts` can't provide (pre-`app.mount()`, no component context).
Hidden on the presenter route (`isPresenter`) — error reporting is a
participant action, per PRD §5's persona split.
-->
<script setup lang="ts">
import { useNav } from '@slidev/client'
import { computed, ref } from 'vue'
import { getWorkshopSocket, getWorkshopTrackerServerUrl } from '../src/client'
import { canCaptureScreen } from '../src/errorReportCapability'
import { buildScreenshotFormData } from '../src/errorReportSubmission'
import { currentParticipant } from '../src/participantIdentity'
import { resolveStepId } from '../src/stepId'

const { isPresenter, currentFrontmatter, currentSlideNo } = useNav()

const stepId = computed(() => resolveStepId(currentFrontmatter.value, currentSlideNo.value))

const canCapture = computed(() => canCaptureScreen({
  hasGetDisplayMedia: typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia),
  protocol: typeof location !== 'undefined' ? location.protocol : '',
  hostname: typeof location !== 'undefined' ? location.hostname : '',
}))

const open = ref(false)
const text = ref('')
const capturedBlob = ref<Blob>()
const capturing = ref(false)
const submitting = ref(false)
const submitted = ref(false)
const errorMessage = ref('')

function resetForm() {
  text.value = ''
  capturedBlob.value = undefined
  submitted.value = false
  errorMessage.value = ''
}

function toggleOpen() {
  open.value = !open.value
  if (!open.value)
    resetForm()
}

async function captureScreen() {
  if (!canCapture.value || capturing.value)
    return
  capturing.value = true
  errorMessage.value = ''
  let stream: MediaStream | undefined
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true })
    const video = document.createElement('video')
    video.muted = true
    video.srcObject = stream
    await video.play()
    // `videoWidth`/`videoHeight` can still read 0 immediately after
    // `play()` resolves in some browsers — wait one animation frame so the
    // first captured frame has real dimensions rather than an empty canvas.
    await new Promise(resolve => requestAnimationFrame(resolve))

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth || 1280
    canvas.height = video.videoHeight || 720
    const ctx = canvas.getContext('2d')
    ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)

    capturedBlob.value = (await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))) ?? undefined
    if (!capturedBlob.value)
      errorMessage.value = 'Could not capture the screen — try again, or just describe the problem below.'
  }
  catch (error) {
    // The participant declined the share prompt, or the browser rejected
    // the call outright — the text box still works regardless, so this is
    // reported inline rather than treated as fatal.
    errorMessage.value = 'Screen capture was cancelled or unavailable — you can still describe the problem below.'
    console.error('[workshop-tracker] screen capture failed', error)
  }
  finally {
    stream?.getTracks().forEach(track => track.stop())
    capturing.value = false
  }
}

function clearCapture() {
  capturedBlob.value = undefined
}

async function submit() {
  const trimmedText = text.value.trim()
  if (!trimmedText && !capturedBlob.value)
    return

  const participant = currentParticipant.value
  if (!participant) {
    errorMessage.value = 'Still joining the workshop — try again in a moment.'
    return
  }

  submitting.value = true
  errorMessage.value = ''
  try {
    if (capturedBlob.value) {
      const form = buildScreenshotFormData({
        participantId: participant.participantId,
        stepId: stepId.value,
        text: trimmedText,
        blob: capturedBlob.value,
      })
      const response = await fetch(`${getWorkshopTrackerServerUrl()}/api/screenshot`, { method: 'POST', body: form })
      if (!response.ok)
        throw new Error(`upload failed with status ${response.status}`)
    }
    else {
      getWorkshopSocket().emit('participant:error', { stepId: stepId.value, text: trimmedText })
    }
    resetForm()
    submitted.value = true
  }
  catch (error) {
    errorMessage.value = 'Could not send the report — check your connection and try again.'
    console.error('[workshop-tracker] error report submit failed', error)
  }
  finally {
    submitting.value = false
  }
}
</script>

<template>
  <div v-if="!isPresenter" class="workshop-tracker-error-widget">
    <div v-if="open" class="workshop-tracker-error-panel">
      <div class="workshop-tracker-error-panel-header">
        <span>Report a problem</span>
        <button type="button" class="workshop-tracker-error-close" aria-label="Close" @click="toggleOpen">
          ✕
        </button>
      </div>

      <p v-if="submitted" class="workshop-tracker-error-status">
        Sent — thanks! The instructor can see this now.
      </p>

      <template v-else>
        <textarea
          v-model="text"
          class="workshop-tracker-error-textarea"
          placeholder="What went wrong? (optional if you attach a screenshot)"
          rows="3"
        />

        <div v-if="canCapture" class="workshop-tracker-error-capture">
          <button
            type="button"
            class="workshop-tracker-error-button"
            :disabled="capturing"
            @click="captureScreen"
          >
            {{ capturing ? 'Capturing…' : capturedBlob ? 'Retake screenshot' : 'Capture screen' }}
          </button>
          <span v-if="capturedBlob" class="workshop-tracker-error-captured">
            Screenshot attached
            <button type="button" class="workshop-tracker-error-remove" @click="clearCapture">
              remove
            </button>
          </span>
        </div>

        <p v-if="errorMessage" class="workshop-tracker-error-message">
          {{ errorMessage }}
        </p>

        <button
          type="button"
          class="workshop-tracker-error-button workshop-tracker-error-submit"
          :disabled="submitting || (!text.trim() && !capturedBlob)"
          @click="submit"
        >
          {{ submitting ? 'Sending…' : 'Send report' }}
        </button>
      </template>
    </div>

    <button
      type="button"
      class="workshop-tracker-error-toggle"
      :aria-expanded="open"
      @click="toggleOpen"
    >
      {{ open ? '✕' : '⚠️ Report a problem' }}
    </button>
  </div>
</template>

<style scoped>
.workshop-tracker-error-widget {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.5em;
  font-size: 14px;
}
.workshop-tracker-error-toggle {
  padding: 0.6em 1em;
  border-radius: 999px;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: #17181d;
  color: #f0f0f2;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
}
.workshop-tracker-error-panel {
  display: flex;
  flex-direction: column;
  gap: 0.6em;
  width: min(320px, 80vw);
  padding: 1em;
  border-radius: 12px;
  background: #17181d;
  color: #f0f0f2;
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
}
.workshop-tracker-error-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
}
.workshop-tracker-error-close {
  background: none;
  border: none;
  color: inherit;
  cursor: pointer;
  font-size: 1em;
  opacity: 0.7;
}
.workshop-tracker-error-textarea {
  width: 100%;
  resize: vertical;
  padding: 0.5em;
  border-radius: 6px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  background: rgba(255, 255, 255, 0.05);
  color: inherit;
  font: inherit;
}
.workshop-tracker-error-capture {
  display: flex;
  align-items: center;
  gap: 0.5em;
  flex-wrap: wrap;
}
.workshop-tracker-error-captured {
  font-size: 0.85em;
  opacity: 0.85;
}
.workshop-tracker-error-remove {
  background: none;
  border: none;
  color: #c9930f;
  cursor: pointer;
  text-decoration: underline;
  font: inherit;
  padding: 0;
  margin-left: 0.3em;
}
.workshop-tracker-error-button {
  padding: 0.5em 0.75em;
  border-radius: 6px;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 0.9em;
}
.workshop-tracker-error-button:disabled {
  cursor: default;
  opacity: 0.6;
}
.workshop-tracker-error-submit {
  border-color: rgba(47, 168, 107, 0.6);
}
.workshop-tracker-error-message {
  margin: 0;
  font-size: 0.85em;
  color: #e08a8a;
}
.workshop-tracker-error-status {
  margin: 0;
  font-size: 0.9em;
  color: #2fa86b;
}
</style>
