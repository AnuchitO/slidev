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

Visual design (UX/UI pass, direct participant feedback): restyled to read
as Material Design — Google-blue primary, Material's red/amber/green
semantic roles, elevation via layered shadows, inline Material-style SVG
icons in place of emoji, and the resolution notice as a Material
*snackbar* (bottom-anchored, compact, single dismiss action) rather than a
top-right toast card — a snackbar is the idiomatic Material pattern for a
transient, non-blocking follow-up message, and bottom-left keeps it clear
of this widget's own bottom-right footprint instead of stacking on it.
Theme: reacts live to Slidev's own dark/light signal (`useDarkMode()` from
`@slidev/client`, the same composable the deck's own toggle drives) via a
`wt-theme-light` modifier class carrying a light token override — a small
lift since the signal is already exported for exactly this kind of
consumption. The dashboard side of this redesign (`muan-companion-server/
public/dashboard/index.html`) intentionally stays dark-only: it's a
separate standalone page the instructor opens directly, not embedded in
the deck, so there's no equivalent theme signal to react to there.
-->
<script setup lang="ts">
import { useDarkMode, useNav } from '@slidev/client'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getMuanCompanionServerUrl, getWorkshopSocket } from '../src/client'
import { canCaptureScreen } from '../src/errorReportCapability'
import { buildScreenshotFormData } from '../src/errorReportSubmission'
import { currentParticipant } from '../src/participantIdentity'
import { resolveStepId } from '../src/stepId'

const { isPresenter, currentFrontmatter, currentSlideNo } = useNav()
const { isDark } = useDarkMode()

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
    console.error('[muan-companion] screen capture failed', error)
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
      const response = await fetch(`${getMuanCompanionServerUrl()}/api/screenshot`, { method: 'POST', body: form })
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
    console.error('[muan-companion] error report submit failed', error)
  }
  finally {
    submitting.value = false
  }
}

// Closes the loop the other direction (feature follow-up after initial
// testing): the instructor's "Mark resolved" on the dashboard can carry an
// optional message, and the server sends it — targeted, not broadcast — to
// this specific participant's own socket as `participant:errorResolved`
// (`server.ts`'s `presenter:resolveError` handler). Shown as a dismissible
// snackbar *independent* of whether the report panel above is open — a
// participant who already closed the panel (or is mid-`<StepCommand>` on a
// later slide) should still see that the instructor followed up, not just
// participants who happen to have it open at that moment.
interface ResolutionNotice {
  message?: string
}
const resolutionNotice = ref<ResolutionNotice | null>(null)
let dismissTimer: ReturnType<typeof setTimeout> | undefined

function onErrorResolved(payload: { errorId: string, stepId: string, message?: string }) {
  resolutionNotice.value = { message: payload.message }
  clearTimeout(dismissTimer)
  // Auto-dismiss so a banner from an earlier report doesn't linger
  // indefinitely across many later slides — long enough to actually read a
  // short message, short enough not to become visual clutter.
  dismissTimer = setTimeout(() => {
    resolutionNotice.value = null
  }, 10_000)
}

function dismissResolutionNotice() {
  clearTimeout(dismissTimer)
  resolutionNotice.value = null
}

onMounted(() => {
  getWorkshopSocket().on('participant:errorResolved', onErrorResolved)
})
onBeforeUnmount(() => {
  getWorkshopSocket().off('participant:errorResolved', onErrorResolved)
  clearTimeout(dismissTimer)
})
</script>

<template>
  <Transition name="wt-snackbar">
    <div
      v-if="!isPresenter && resolutionNotice"
      class="slidev-muan-companion-resolution-toast"
      :class="{ 'wt-theme-light': !isDark }"
      role="status"
    >
      <svg class="wt-icon wt-icon-success" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
      <div class="slidev-muan-companion-resolution-body">
        <p class="slidev-muan-companion-resolution-title">
          The instructor marked your report resolved
        </p>
        <p v-if="resolutionNotice.message" class="slidev-muan-companion-resolution-message">
          “{{ resolutionNotice.message }}”
        </p>
      </div>
      <button type="button" class="slidev-muan-companion-icon-button" aria-label="Dismiss" @click="dismissResolutionNotice">
        <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
      </button>
    </div>
  </Transition>

  <div v-if="!isPresenter" class="slidev-muan-companion-error-widget" :class="{ 'wt-theme-light': !isDark }">
    <div v-if="open" class="slidev-muan-companion-error-panel">
      <div class="slidev-muan-companion-error-panel-header">
        <svg class="wt-icon wt-icon-warning" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg>
        <span class="slidev-muan-companion-error-panel-title">Report a problem</span>
        <button type="button" class="slidev-muan-companion-icon-button" aria-label="Close" @click="toggleOpen">
          <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
        </button>
      </div>

      <p v-if="submitted" class="slidev-muan-companion-error-status">
        <svg class="wt-icon wt-icon-success" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
        <span>Sent — thanks! The instructor can see this now.</span>
      </p>

      <template v-else>
        <textarea
          v-model="text"
          class="slidev-muan-companion-error-textarea"
          placeholder="What went wrong? (optional if you attach a screenshot)"
          rows="3"
        />

        <div v-if="canCapture" class="slidev-muan-companion-error-capture">
          <button
            type="button"
            class="slidev-muan-companion-error-button slidev-muan-companion-error-button-outlined"
            :disabled="capturing"
            @click="captureScreen"
          >
            <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 2 7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" /></svg>
            <span>{{ capturing ? 'Capturing…' : capturedBlob ? 'Retake screenshot' : 'Capture screen' }}</span>
          </button>
          <span v-if="capturedBlob" class="slidev-muan-companion-error-chip">
            <svg class="wt-icon wt-icon-success" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
            Screenshot attached
            <button type="button" class="slidev-muan-companion-error-chip-remove" aria-label="Remove screenshot" @click="clearCapture">
              <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
            </button>
          </span>
        </div>

        <p v-if="errorMessage" class="slidev-muan-companion-error-message">
          {{ errorMessage }}
        </p>

        <button
          type="button"
          class="slidev-muan-companion-error-button slidev-muan-companion-error-submit"
          :disabled="submitting || (!text.trim() && !capturedBlob)"
          @click="submit"
        >
          <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          <span>{{ submitting ? 'Sending…' : 'Send report' }}</span>
        </button>
      </template>
    </div>

    <button
      type="button"
      class="slidev-muan-companion-error-toggle"
      :class="{ 'slidev-muan-companion-error-toggle-open': open }"
      :aria-expanded="open"
      :aria-label="open ? 'Close report a problem' : 'Report a problem'"
      @click="toggleOpen"
    >
      <svg v-if="open" class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
      <template v-else>
        <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg>
        <span>Report a problem</span>
      </template>
    </button>
  </div>
</template>

<style scoped>
/*
 * Design tokens (Material-inspired, "Google style" per direct participant
 * feedback): a small, deliberately-limited set applied identically here and
 * in the dashboard's error feed (`muan-companion-server/public/dashboard/
 * index.html`) even though the two can't share a stylesheet — same radius
 * scale, same elevation shadows, same semantic color roles, same type
 * stack, kept in sync by eye. Dark values are the defaults (this widget's
 * historical/only look); `.wt-theme-light` overrides them when
 * `useDarkMode()` reports the deck is in light mode.
 */
.slidev-muan-companion-error-widget,
.slidev-muan-companion-resolution-toast {
  --wt-color-primary: #8ab4f8;
  --wt-color-on-primary: #062e6f;
  --wt-color-error: #f28b82;
  --wt-color-warning: #fdd663;
  --wt-color-success: #81c995;
  --wt-color-surface: #2d2e31;
  --wt-color-surface-container: #37393c;
  --wt-color-on-surface: #e8eaed;
  --wt-color-on-surface-variant: #9aa0a6;
  --wt-color-outline: #5f6368;
  --wt-color-inverse-surface: #e8eaed;
  --wt-color-inverse-on-surface: #202124;
  --wt-radius-sm: 8px;
  --wt-radius-md: 16px;
  --wt-radius-full: 999px;
  --wt-elevation-2: 0 1px 2px rgba(0, 0, 0, 0.3), 0 2px 6px 2px rgba(0, 0, 0, 0.15);
  --wt-elevation-3: 0 1px 3px rgba(0, 0, 0, 0.3), 0 4px 8px 3px rgba(0, 0, 0, 0.15);
  --wt-font: 'Google Sans', Roboto, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
  font-family: var(--wt-font);
}
.slidev-muan-companion-error-widget.wt-theme-light,
.slidev-muan-companion-resolution-toast.wt-theme-light {
  --wt-color-primary: #1a73e8;
  --wt-color-on-primary: #ffffff;
  --wt-color-error: #d93025;
  --wt-color-warning: #ea8600;
  --wt-color-success: #188038;
  --wt-color-surface: #ffffff;
  --wt-color-surface-container: #f1f3f4;
  --wt-color-on-surface: #202124;
  --wt-color-on-surface-variant: #5f6368;
  --wt-color-outline: #dadce0;
  --wt-color-inverse-surface: #303134;
  --wt-color-inverse-on-surface: #e8eaed;
}

.wt-icon {
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
  display: block;
}
.wt-icon-warning {
  color: var(--wt-color-warning);
}
.wt-icon-success {
  color: var(--wt-color-success);
}

.slidev-muan-companion-error-widget {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 900;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.6em;
  font-size: 14px;
}

/* Closed state: an extended FAB (icon + label, pill, elevated, filled with
   the primary color) — Material's standard affordance for a persistent,
   always-available primary action floating over content. */
.slidev-muan-companion-error-toggle {
  display: flex;
  align-items: center;
  gap: 0.5em;
  padding: 0.75em 1.1em;
  border-radius: var(--wt-radius-full);
  border: none;
  background: var(--wt-color-primary);
  color: var(--wt-color-on-primary);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--wt-elevation-3);
  transition:
    box-shadow 0.15s ease,
    transform 0.1s ease;
}
.slidev-muan-companion-error-toggle:hover {
  box-shadow:
    var(--wt-elevation-3),
    0 0 0 8px rgba(138, 180, 248, 0.12);
}
.slidev-muan-companion-error-toggle:active {
  transform: scale(0.97);
}
/* Open state: collapses to a small icon-only circular FAB, since the panel
   above already carries the label — avoids two redundant "close" targets
   competing for attention. */
.slidev-muan-companion-error-toggle-open {
  padding: 0.65em;
  border-radius: 50%;
}
.slidev-muan-companion-error-toggle-open .wt-icon {
  color: var(--wt-color-on-primary);
}

.slidev-muan-companion-error-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75em;
  width: min(340px, 85vw);
  padding: 1.1em;
  border-radius: var(--wt-radius-md);
  background: var(--wt-color-surface);
  color: var(--wt-color-on-surface);
  box-shadow: var(--wt-elevation-3);
}
.slidev-muan-companion-error-panel-header {
  display: flex;
  align-items: center;
  gap: 0.5em;
}
.slidev-muan-companion-error-panel-title {
  flex: 1 1 auto;
  font-weight: 500;
  font-size: 1.05em;
}

/* Small circular icon button, used for every "dismiss/close" affordance —
   a Material "icon button": no border, a faint state-layer on hover so it
   doesn't compete with the filled/outlined buttons below it. */
.slidev-muan-companion-icon-button {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--wt-color-on-surface-variant);
  cursor: pointer;
  transition: background 0.15s ease;
}
.slidev-muan-companion-icon-button:hover {
  background: rgba(128, 128, 128, 0.16);
  color: var(--wt-color-on-surface);
}

/* Outlined text field, Material's default for a multi-line input. */
.slidev-muan-companion-error-textarea {
  width: 100%;
  resize: vertical;
  padding: 0.65em 0.75em;
  border-radius: var(--wt-radius-sm);
  border: 1px solid var(--wt-color-outline);
  background: transparent;
  color: inherit;
  font: inherit;
}
.slidev-muan-companion-error-textarea:focus {
  outline: none;
  border: 2px solid var(--wt-color-primary);
  padding: calc(0.65em - 1px) calc(0.75em - 1px);
}
.slidev-muan-companion-error-textarea::placeholder {
  color: var(--wt-color-on-surface-variant);
}

.slidev-muan-companion-error-capture {
  display: flex;
  align-items: center;
  gap: 0.5em;
  flex-wrap: wrap;
}

/* Input-chip pattern for "screenshot attached": a small pill summarizing
   an attachment, with its own trailing remove control. */
.slidev-muan-companion-error-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.3em 0.5em 0.3em 0.6em;
  border-radius: var(--wt-radius-full);
  background: var(--wt-color-surface-container);
  font-size: 0.85em;
  color: var(--wt-color-on-surface-variant);
}
.slidev-muan-companion-error-chip-remove {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  margin-left: 0.15em;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.slidev-muan-companion-error-chip-remove:hover {
  background: rgba(128, 128, 128, 0.24);
}
.slidev-muan-companion-error-chip-remove .wt-icon {
  width: 13px;
  height: 13px;
}

/* Two button treatments give the panel a clear action hierarchy: the
   secondary action (capture) is outlined, the primary action (send) is
   filled with the primary color — standard Material button hierarchy. */
.slidev-muan-companion-error-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.45em;
  padding: 0.55em 0.9em;
  border-radius: var(--wt-radius-full);
  border: none;
  font: inherit;
  font-weight: 500;
  font-size: 0.9em;
  cursor: pointer;
  transition:
    background 0.15s ease,
    box-shadow 0.15s ease;
}
.slidev-muan-companion-error-button-outlined {
  background: transparent;
  color: var(--wt-color-on-surface);
  border: 1px solid var(--wt-color-outline);
}
.slidev-muan-companion-error-button-outlined:hover:not(:disabled) {
  background: rgba(128, 128, 128, 0.12);
}
.slidev-muan-companion-error-button:disabled {
  cursor: default;
  opacity: 0.38;
}
.slidev-muan-companion-error-submit {
  width: 100%;
  background: var(--wt-color-primary);
  color: var(--wt-color-on-primary);
  box-shadow: var(--wt-elevation-2);
}
.slidev-muan-companion-error-submit:hover:not(:disabled) {
  box-shadow: var(--wt-elevation-3);
}

.slidev-muan-companion-error-message {
  display: flex;
  align-items: flex-start;
  gap: 0.4em;
  margin: 0;
  font-size: 0.85em;
  color: var(--wt-color-error);
}
.slidev-muan-companion-error-status {
  display: flex;
  align-items: center;
  gap: 0.5em;
  margin: 0;
  font-size: 0.9em;
  color: var(--wt-color-success);
}

/*
 * Resolution notice, as a Material Snackbar rather than the previous
 * top-right toast card: bottom-anchored (opposite corner from the FAB, so
 * it never collides with the widget), compact, auto-dismissing, single
 * action. Deliberately uses the *inverse* surface color even in dark mode
 * — Material's own snackbar spec inverts surface/on-surface so a
 * transient message visually pops against the page instead of blending
 * into it, which a same-color card can't do.
 */
.slidev-muan-companion-resolution-toast {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 950;
  display: flex;
  align-items: flex-start;
  gap: 0.6em;
  width: min(340px, 85vw);
  padding: 0.85em 0.9em;
  border-radius: var(--wt-radius-sm);
  background: var(--wt-color-inverse-surface);
  color: var(--wt-color-inverse-on-surface);
  box-shadow: var(--wt-elevation-3);
  font-size: 14px;
}
.slidev-muan-companion-resolution-toast .slidev-muan-companion-icon-button {
  color: var(--wt-color-inverse-on-surface);
  opacity: 0.75;
}
.slidev-muan-companion-resolution-toast .slidev-muan-companion-icon-button:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.24);
}
.slidev-muan-companion-resolution-body {
  flex: 1 1 auto;
  min-width: 0;
  padding-top: 0.1em;
}
.slidev-muan-companion-resolution-title {
  margin: 0;
  font-weight: 500;
}
.slidev-muan-companion-resolution-message {
  margin: 0.3em 0 0;
  opacity: 0.8;
  white-space: pre-wrap;
  word-break: break-word;
}

.wt-snackbar-enter-active,
.wt-snackbar-leave-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}
.wt-snackbar-enter-from,
.wt-snackbar-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

@media (prefers-reduced-motion: reduce) {
  .slidev-muan-companion-error-toggle,
  .wt-snackbar-enter-active,
  .wt-snackbar-leave-active {
    transition: none;
  }
}
</style>
