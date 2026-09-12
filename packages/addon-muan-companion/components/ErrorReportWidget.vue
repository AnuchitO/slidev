<!--
Persistent, low-chrome "Ask for Help" widget (plan 028 Step 2, PRD §7 addon
deliverable list item 3, redesigned into a two-flow umbrella per the "Ask
for Help" UX pass): a small floating button, bottom-right of the viewport,
that expands into a panel offering two distinct participant actions —
"Report a problem" (the original flow) and "Ask a question" (new,
text-only). Available on every slide regardless of `stepId`/`<StepCommand>`
presence — the current step is still attached to whichever kind of report
is filed via `resolveStepId` (`../src/stepId.ts`), same fallback rule
`<StepCommand>` uses.

Why one widget for two flows rather than two buttons: both are the same
underlying `ErrorReport` shape server-side now (`muan-companion-server/src/
session.ts`'s `HelpRequestKind`) — same thread/resolve/confirm state
machine, same dashboard feed, same "attach the current step" behavior —
they only differ in whether a screenshot is offered and in the `kind` tag
sent to the server. A single entry point with an internal tab/segmented
choice keeps the FAB count at one (this is already competing for
bottom-right screen space with nothing else, but a second persistent FAB
would be visual clutter for what's fundamentally "I need the instructor's
attention" in both cases) and mirrors how the dashboard now presents both
kinds in one unified feed rather than two.

Default tab on open is "Report a problem" (`activeTab` below), not "Ask a
question": it's the pre-existing flow participants already have muscle
memory for, it's the one carrying time-sensitive urgency (something is
visibly broken *right now*, mid-exercise) where an extra click to find the
right tab is more costly than for a question that can wait a beat, and it's
the flow the screenshot-capture affordance belongs to — surfacing it by
default means `canCaptureScreen` participants see the capture button
without an extra click. "Ask a question" is one segmented-control tap away.

Text box is always available on the "Report a problem" tab (the required
PRD §10/§12 fallback). The "Capture screen" button only renders when
`canCaptureScreen` (`../src/errorReportCapability.ts`) is true — explicit
feature detection, not try/catch-and-hope, so a participant on a browser/
context lacking `getDisplayMedia` (or on an insecure non-localhost origin)
never sees a button that would only fail when clicked. The "Ask a
question" tab never offers screenshot capture at all — it's a deliberately
narrower, faster flow for a question that doesn't need a picture, not a
strictly-more-capability superset of the problem tab.

Submission transport (plan 028 Step 2's decision, not duplicated across
more paths than necessary, now covering three submission shapes instead of
one):
- A captured screenshot (problem tab only) → `POST /api/screenshot` (REST,
  multipart — `../src/errorReportSubmission.ts` builds the body) — the
  *only* path that ever carries a screenshot, and it's hardcoded
  `kind: 'problem'` server-side, so nothing to send here.
- Problem tab, no screenshot → the WS `participant:error
  { stepId, text, kind: 'problem' }` event (`../src/client.ts`'s shared
  socket), `kind` now sent explicitly rather than relying on the server's
  default.
- Question tab (always text-only, never a screenshot option) → the same WS
  `participant:error` event with `kind: 'question'`.
Never more than one of these for a single submission.

Mounted as a Global Layer (`../global-top.vue`), same reasoning as
`JoinScreen.vue`: needs `useNav()`/full injection context, which
`setup/main.ts` can't provide (pre-`app.mount()`, no component context).
Hidden on the presenter route (`isPresenter`) — asking for help is a
participant action, per PRD §5's persona split.

Visual design (UX/UI pass, direct participant feedback, extended by the
"Ask for Help" redesign): reads as Material Design — Google-blue primary,
Material's red/amber/green semantic roles, elevation via layered shadows,
inline Material-style SVG icons in place of emoji (including in this
redesign's own new copy — see the resolution card below, which intentionally
render a checkmark icon rather than a literal "✅" character, to keep the
"no emoji" rule consistent even where an emoji reads naturally in prose).
The original single-purpose "report a problem" snackbar is now two
purpose-built follow-up surfaces instead of one, because the server
contract itself now distinguishes two genuinely different situations:
  - `participant:errorResolved` is no longer "done, FYI" — it's an offer
    the participant must accept or decline (`status: 'awaiting_confirmation'`),
    so it's rendered as an *actionable* card that persists until they
    respond (see "resolution card" below) rather than a passive toast that
    can auto-dismiss out from under an unanswered question.
  - `participant:message` (new) is genuinely "just FYI, no decision
    attached" — a presenter reply that isn't a resolution offer — so it
    keeps the *original* snackbar's auto-dismissing, lightweight treatment,
    just with an inline reply affordance added (see "message notice"
    below). Keeping these visually distinct (different shape, different
    persistence behavior) matters precisely because they carry different
    obligations — a participant should never mistake "just FYI" for "you
    need to respond", or vice versa.
Both follow-up surfaces stack in one bottom-left `.slidev-muan-companion-
notice-stack` container (opposite corner from the FAB, so neither ever
collides with the widget itself), newest-relevant on top.
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
import type { ConfirmResolutionPayload, ErrorResolvedPayload, PresenterMessagePayload } from '../src/socketEvents'
import { useDarkMode, useNav } from '@slidev/client'
import { computed, onBeforeUnmount, ref } from 'vue'
import { getMuanCompanionServerUrl, getWorkshopSocket } from '../src/client'
import { canCaptureScreen } from '../src/errorReportCapability'
import { buildScreenshotFormData } from '../src/errorReportSubmission'
import { currentParticipant } from '../src/participantIdentity'
import { resolveStepId } from '../src/stepId'
import { useSocketListeners } from '../src/useSocketListeners'

const { isPresenter, currentFrontmatter, currentSlideNo } = useNav()
const { isDark } = useDarkMode()

const stepId = computed(() => resolveStepId(currentFrontmatter.value, currentSlideNo.value))

const canCapture = computed(() => canCaptureScreen({
  hasGetDisplayMedia: typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia),
  protocol: typeof location !== 'undefined' ? location.protocol : '',
  hostname: typeof location !== 'undefined' ? location.hostname : '',
}))

// --- Panel open/close + tab selection ------------------------------------

const open = ref(false)
type HelpTab = 'problem' | 'question'
// See the top-of-file comment for why 'problem' is the default.
const activeTab = ref<HelpTab>('problem')

// Kept as two separate drafts (rather than one `text` shared across tabs)
// so that switching tabs to peek at the other flow never discards whatever
// a participant already started typing in the first one.
const problemText = ref('')
const questionText = ref('')
const capturedBlob = ref<Blob>()
const capturing = ref(false)
const submitting = ref(false)
const submitted = ref(false)
const errorMessage = ref('')

function resetForm() {
  problemText.value = ''
  questionText.value = ''
  capturedBlob.value = undefined
  submitted.value = false
  errorMessage.value = ''
}

function toggleOpen() {
  open.value = !open.value
  if (!open.value)
    resetForm()
}

function selectTab(tab: HelpTab) {
  if (activeTab.value === tab)
    return
  activeTab.value = tab
  // A stale "sent!" confirmation or error from the *other* tab's last
  // submission shouldn't bleed into the tab someone just switched to — but
  // their in-progress draft text/screenshot should (see the two-draft note
  // above), so only the submission-outcome state resets here.
  submitted.value = false
  errorMessage.value = ''
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

// "Report a problem" tab's submit — unchanged in substance from the
// pre-redesign single form, forked out under its own name now that there's
// a sibling `submitQuestion` below. The only actual behavior change is
// sending `kind: 'problem'` explicitly on the WS path (previously omitted
// and left to the server's default) — see the top-of-file transport note.
async function submitProblem() {
  const trimmedText = problemText.value.trim()
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
      getWorkshopSocket().emit('participant:error', { stepId: stepId.value, text: trimmedText, kind: 'problem' })
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

// "Ask a question" tab's submit — new, and deliberately simpler than
// `submitProblem` above: text-only, WS-only, no screenshot branch at all
// (there's nothing to attach), `kind: 'question'` always explicit.
async function submitQuestion() {
  const trimmedText = questionText.value.trim()
  if (!trimmedText)
    return

  const participant = currentParticipant.value
  if (!participant) {
    errorMessage.value = 'Still joining the workshop — try again in a moment.'
    return
  }

  submitting.value = true
  errorMessage.value = ''
  try {
    getWorkshopSocket().emit('participant:error', { stepId: stepId.value, text: trimmedText, kind: 'question' })
    resetForm()
    submitted.value = true
  }
  catch (error) {
    errorMessage.value = 'Could not send the question — check your connection and try again.'
    console.error('[muan-companion] question submit failed', error)
  }
  finally {
    submitting.value = false
  }
}

// --- Resolution card (participant:errorResolved) --------------------------
//
// Closes the loop the other direction (feature follow-up after initial
// testing): the instructor's "Mark resolved" on the dashboard can carry an
// optional message, and the server sends it — targeted, not broadcast — to
// this specific participant's own socket as `participant:errorResolved`
// (`muan-companion-server/src/server.ts`'s `presenter:resolveError`
// handler). Redesigned from a one-shot dismissible snackbar into an
// *actionable* card: `status` in the payload is now always
// `'awaiting_confirmation'`, never a final "done" — the presenter is only
// *proposing* the report is fixed, and the participant has the final say
// via `participant:confirmResolution` below. Deliberately has **no**
// auto-dismiss timer (contrast the message notice further down): silently
// hiding an unanswered question after 10s would mean the participant never
// got to respond, which defeats the entire point of the confirm/reopen
// redesign. It only ever goes away because the participant took one of the
// two actions, or explicitly dismissed it via the close icon-button (which
// hides it locally only — never emits `confirmed: false`, since a passive
// dismiss silently reopening someone's ticket behind their back would be
// exactly the kind of surprising side effect this redesign is trying to
// avoid elsewhere).
//
// Shown *independent* of whether the report panel above is open — a
// participant who already closed the panel (or is mid-`<StepCommand>` on a
// later slide) should still see that the instructor followed up, not just
// participants who happen to have it open at that moment.
interface ResolutionCard {
  errorId: string
  message?: string
}
// `'prompt'`: the initial "did that fix it?" offer, both actions available.
// `'reopen-compose'`: "Still need help" was clicked — the optional
// follow-up text box is open, nothing sent yet.
// `'confirmed'` / `'reopened'`: a brief acknowledgment shown after the
// participant's choice goes out, before the card fades on its own.
type ResolutionPhase = 'prompt' | 'reopen-compose' | 'confirmed' | 'reopened'

const resolutionCard = ref<ResolutionCard | null>(null)
const resolutionPhase = ref<ResolutionPhase>('prompt')
const reopenMessage = ref('')
let resolutionFadeTimer: ReturnType<typeof setTimeout> | undefined

function onErrorResolved(payload: ErrorResolvedPayload) {
  // Keyed on `errorId`, not appended to any list: this can legitimately
  // fire again for the same report (reopened, then marked resolved a
  // second time) or for a different one while an earlier card is still
  // showing — either way, the new offer simply replaces whichever card is
  // currently up rather than stacking multiple resolution prompts.
  clearTimeout(resolutionFadeTimer)
  resolutionCard.value = { errorId: payload.errorId, message: payload.message }
  resolutionPhase.value = 'prompt'
  reopenMessage.value = ''
}

// "✅ Yes, that fixed it" — confirms via `participant:confirmResolution`
// and moves to a brief thank-you before the card fades on its own. No ack
// is expected or needed (see the server contract note on these new
// events): the only "confirmation" that matters is the presenter seeing
// the status flip on their dashboard, so the local UI just optimistically
// shows the outcome.
function confirmFixed() {
  const card = resolutionCard.value
  if (!card)
    return
  const payload: ConfirmResolutionPayload = { errorId: card.errorId, confirmed: true }
  getWorkshopSocket().emit('participant:confirmResolution', payload)
  resolutionPhase.value = 'confirmed'
  scheduleResolutionFade()
}

// "Still need help" — reveals the small optional follow-up box rather than
// emitting anything immediately; the actual `confirmed: false` doesn't go
// out until `sendReopen` below, so a participant who clicks this by
// accident can still back out via the dismiss button without reopening
// their ticket.
function openReopenCompose() {
  resolutionPhase.value = 'reopen-compose'
}

function cancelReopenCompose() {
  resolutionPhase.value = 'prompt'
  reopenMessage.value = ''
}

function sendReopen() {
  const card = resolutionCard.value
  if (!card)
    return
  const trimmed = reopenMessage.value.trim()
  const payload: ConfirmResolutionPayload = { errorId: card.errorId, confirmed: false }
  if (trimmed)
    payload.message = trimmed
  getWorkshopSocket().emit('participant:confirmResolution', payload)
  resolutionPhase.value = 'reopened'
  reopenMessage.value = ''
  scheduleResolutionFade()
}

function scheduleResolutionFade() {
  clearTimeout(resolutionFadeTimer)
  // Short — long enough to read a one-line acknowledgment, unlike the old
  // 10s snackbar timer which had to stay legible for an entire *unread*
  // message. This one only starts after the participant has already acted,
  // so there's nothing left to wait for them to notice.
  resolutionFadeTimer = setTimeout(() => {
    resolutionCard.value = null
  }, 2_500)
}

function dismissResolutionCard() {
  clearTimeout(resolutionFadeTimer)
  resolutionCard.value = null
}

// --- Message notice (participant:message) ----------------------------------
//
// The "message box" redesign's other new event: a plain presenter reply —
// "still looking into it", answering a question — with no resolution offer
// attached, sent via the dashboard's "reply without resolving" action.
// Unlike the resolution card above, this genuinely is "just FYI": there's
// no confirm/reopen decision riding on it, so it keeps the *original*
// snackbar's lightweight, auto-dismissing treatment rather than persisting
// indefinitely — see the top-of-file comment for why these two follow-up
// shapes are deliberately different.
interface MessageNotice {
  errorId: string
  text: string
}
const messageNotice = ref<MessageNotice | null>(null)
const showReply = ref(false)
const replyText = ref('')
const replyJustSent = ref(false)
let messageDismissTimer: ReturnType<typeof setTimeout> | undefined

function scheduleMessageDismiss() {
  clearTimeout(messageDismissTimer)
  // Same 10s the pre-redesign resolution snackbar used — long enough to
  // actually read a short message, short enough not to become visual
  // clutter across many later slides.
  messageDismissTimer = setTimeout(() => {
    messageNotice.value = null
  }, 10_000)
}

function onPresenterMessage(payload: PresenterMessagePayload) {
  // Same "key on errorId, replace whichever is showing" posture as the
  // resolution card — a second plain reply (on this report or another)
  // while one notice is already up simply replaces it rather than queuing.
  messageNotice.value = { errorId: payload.errorId, text: payload.text }
  showReply.value = false
  replyText.value = ''
  replyJustSent.value = false
  scheduleMessageDismiss()
}

function dismissMessageNotice() {
  clearTimeout(messageDismissTimer)
  messageNotice.value = null
}

function toggleReply() {
  showReply.value = !showReply.value
  if (showReply.value) {
    // Don't let the auto-dismiss timer yank the reply box away while
    // someone is mid-sentence composing a follow-up.
    clearTimeout(messageDismissTimer)
  }
  else {
    // They backed out of replying without sending — resume the normal
    // auto-dismiss clock for the notice itself.
    scheduleMessageDismiss()
  }
}

function sendReply() {
  const notice = messageNotice.value
  const trimmed = replyText.value.trim()
  if (!notice || !trimmed)
    return
  getWorkshopSocket().emit('participant:addMessage', { errorId: notice.errorId, text: trimmed })
  replyText.value = ''
  showReply.value = false
  replyJustSent.value = true
  // Give the notice a fresh 10s window after replying, both because the
  // reply itself is new information worth a moment to notice, and because
  // it just avoided being auto-dismissed mid-compose (see `toggleReply`).
  scheduleMessageDismiss()
}

// `useSocketListeners` (`../src/useSocketListeners`) is the shared
// "register in onMounted, clean up in onBeforeUnmount, skip entirely on the
// presenter's own socket" pattern, factored out once `JoinScreen.vue`'s
// `disconnect` listener needed the identical shape — see that composable's
// own comment for why the `enabled` guard matters even though nothing here
// is a security hole today (the presenter never has an error report to be
// notified about).
useSocketListeners(getWorkshopSocket(), {
  'participant:errorResolved': onErrorResolved,
  'participant:message': onPresenterMessage,
}, { enabled: () => !isPresenter.value })

onBeforeUnmount(() => {
  clearTimeout(resolutionFadeTimer)
  clearTimeout(messageDismissTimer)
})
</script>

<template>
  <div v-if="!isPresenter && (resolutionCard || messageNotice)" class="slidev-muan-companion-notice-stack" :class="{ 'wt-theme-light': !isDark }">
    <!-- Resolution card: actionable, persists until the participant responds
         or manually dismisses it — see the script's top-of-file comment on
         why this one deliberately has no auto-dismiss timer. -->
    <Transition name="wt-snackbar">
      <div v-if="resolutionCard" class="slidev-muan-companion-resolution-card" role="status">
        <div class="slidev-muan-companion-resolution-card-header">
          <svg class="wt-icon wt-icon-help" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" /></svg>
          <span class="slidev-muan-companion-resolution-card-title">Ask for Help</span>
          <button type="button" class="slidev-muan-companion-icon-button" aria-label="Dismiss" @click="dismissResolutionCard">
            <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
          </button>
        </div>

        <template v-if="resolutionPhase === 'prompt'">
          <p class="slidev-muan-companion-resolution-prompt">
            The instructor marked this resolved — did that fix it?
          </p>
          <p v-if="resolutionCard.message" class="slidev-muan-companion-resolution-message">
            “{{ resolutionCard.message }}”
          </p>
          <div class="slidev-muan-companion-resolution-actions">
            <button type="button" class="slidev-muan-companion-error-button slidev-muan-companion-resolution-confirm" @click="confirmFixed">
              <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
              <span>Yes, that fixed it</span>
            </button>
            <button type="button" class="slidev-muan-companion-error-button slidev-muan-companion-error-button-outlined" @click="openReopenCompose">
              <span>Still need help</span>
            </button>
          </div>
        </template>

        <template v-else-if="resolutionPhase === 'reopen-compose'">
          <p class="slidev-muan-companion-resolution-prompt">
            Anything else to add? (optional)
          </p>
          <textarea
            v-model="reopenMessage"
            class="slidev-muan-companion-error-textarea"
            placeholder="Still broken, same error…"
            rows="2"
          />
          <div class="slidev-muan-companion-resolution-actions">
            <button type="button" class="slidev-muan-companion-error-button slidev-muan-companion-error-submit" @click="sendReopen">
              <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
              <span>Send</span>
            </button>
            <button type="button" class="slidev-muan-companion-error-button slidev-muan-companion-error-button-outlined" @click="cancelReopenCompose">
              <span>Back</span>
            </button>
          </div>
        </template>

        <p v-else-if="resolutionPhase === 'confirmed'" class="slidev-muan-companion-error-status">
          <svg class="wt-icon wt-icon-success" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
          <span>Great — glad that worked!</span>
        </p>

        <p v-else class="slidev-muan-companion-resolution-message">
          Got it — we've let the instructor know.
        </p>
      </div>
    </Transition>

    <!-- Message notice: lightweight, auto-dismissing "just FYI" — a plain
         presenter reply with no resolution decision attached. -->
    <Transition name="wt-snackbar">
      <div v-if="messageNotice" class="slidev-muan-companion-message-toast" role="status">
        <svg class="wt-icon wt-icon-help" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z" /></svg>
        <div class="slidev-muan-companion-message-body">
          <p class="slidev-muan-companion-message-title">
            Instructor:
          </p>
          <p class="slidev-muan-companion-message-text">
            {{ messageNotice.text }}
          </p>

          <p v-if="replyJustSent && !showReply" class="slidev-muan-companion-message-sent">
            Reply sent!
          </p>
          <button v-else-if="!showReply" type="button" class="slidev-muan-companion-message-reply-toggle" @click="toggleReply">
            Reply
          </button>

          <div v-if="showReply" class="slidev-muan-companion-message-reply">
            <textarea
              v-model="replyText"
              class="slidev-muan-companion-error-textarea slidev-muan-companion-message-reply-textarea"
              placeholder="Type a reply…"
              rows="2"
            />
            <div class="slidev-muan-companion-resolution-actions">
              <button type="button" class="slidev-muan-companion-error-button slidev-muan-companion-error-submit" :disabled="!replyText.trim()" @click="sendReply">
                <span>Send</span>
              </button>
              <button type="button" class="slidev-muan-companion-error-button slidev-muan-companion-error-button-outlined" @click="toggleReply">
                <span>Cancel</span>
              </button>
            </div>
          </div>
        </div>
        <button type="button" class="slidev-muan-companion-icon-button" aria-label="Dismiss" @click="dismissMessageNotice">
          <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
        </button>
      </div>
    </Transition>
  </div>

  <div v-if="!isPresenter" class="slidev-muan-companion-error-widget" :class="{ 'wt-theme-light': !isDark }">
    <div v-if="open" class="slidev-muan-companion-error-panel">
      <div class="slidev-muan-companion-error-panel-header">
        <svg class="wt-icon wt-icon-help" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" /></svg>
        <span class="slidev-muan-companion-error-panel-title">Ask for Help</span>
        <button type="button" class="slidev-muan-companion-icon-button" aria-label="Close" @click="toggleOpen">
          <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
        </button>
      </div>

      <!-- Segmented control: Material's pattern for choosing between two
           mutually-exclusive, equally-weighted options in a compact space —
           preferred here over e.g. a dropdown because both options should
           be visible/discoverable at a glance, not hidden behind a click. -->
      <div class="slidev-muan-companion-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          class="slidev-muan-companion-tab"
          :class="{ 'slidev-muan-companion-tab-active': activeTab === 'problem' }"
          :aria-selected="activeTab === 'problem'"
          @click="selectTab('problem')"
        >
          <svg class="wt-icon wt-icon-warning" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z" /></svg>
          <span>Report a problem</span>
        </button>
        <button
          type="button"
          role="tab"
          class="slidev-muan-companion-tab"
          :class="{ 'slidev-muan-companion-tab-active': activeTab === 'question' }"
          :aria-selected="activeTab === 'question'"
          @click="selectTab('question')"
        >
          <svg class="wt-icon wt-icon-help" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" /></svg>
          <span>Ask a question</span>
        </button>
      </div>

      <p v-if="submitted" class="slidev-muan-companion-error-status">
        <svg class="wt-icon wt-icon-success" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" /></svg>
        <span>{{ activeTab === 'problem' ? 'Sent — thanks! The instructor can see this now.' : 'Question sent — thanks! The instructor can see this now.' }}</span>
      </p>

      <template v-else-if="activeTab === 'problem'">
        <textarea
          v-model="problemText"
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
          :disabled="submitting || (!problemText.trim() && !capturedBlob)"
          @click="submitProblem"
        >
          <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          <span>{{ submitting ? 'Sending…' : 'Send report' }}</span>
        </button>
      </template>

      <template v-else>
        <textarea
          v-model="questionText"
          class="slidev-muan-companion-error-textarea"
          placeholder="What's your question?"
          rows="3"
        />

        <p v-if="errorMessage" class="slidev-muan-companion-error-message">
          {{ errorMessage }}
        </p>

        <button
          type="button"
          class="slidev-muan-companion-error-button slidev-muan-companion-error-submit"
          :disabled="submitting || !questionText.trim()"
          @click="submitQuestion"
        >
          <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2z" /></svg>
          <span>{{ submitting ? 'Sending…' : 'Send question' }}</span>
        </button>
      </template>
    </div>

    <button
      type="button"
      class="slidev-muan-companion-error-toggle"
      :class="{ 'slidev-muan-companion-error-toggle-open': open }"
      :aria-expanded="open"
      :aria-label="open ? 'Close ask for help' : 'Ask for help'"
      @click="toggleOpen"
    >
      <svg v-if="open" class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" /></svg>
      <template v-else>
        <svg class="wt-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 17h-2v-2h2v2zm2.07-7.75-.9.92C13.45 12.9 13 13.5 13 15h-2v-.5c0-1.1.45-2.1 1.17-2.83l1.24-1.26c.37-.36.59-.86.59-1.41 0-1.1-.9-2-2-2s-2 .9-2 2H8c0-2.21 1.79-4 4-4s4 1.79 4 4c0 .88-.36 1.68-.93 2.25z" /></svg>
        <span>Ask for Help</span>
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
.slidev-muan-companion-notice-stack {
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
.slidev-muan-companion-notice-stack.wt-theme-light {
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
/* Used for the "Ask for Help" umbrella icon itself (panel header, question
   tab, both follow-up cards) — tinted with the primary color rather than a
   semantic warning/success color, since "help" isn't inherently good or
   bad news the way those two are. */
.wt-icon-help {
  color: var(--wt-color-primary);
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
   always-available primary action floating over content. The help icon
   here deliberately has no `.wt-icon-*` color modifier, unlike the panel
   header's copy of the same glyph — it inherits the button's own
   `on-primary` text color instead, matching the close (X) icon it swaps
   with, rather than a separate semantic tint, since here it *is* the
   button's icon rather than a standalone glyph next to a title. */
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

/* The "Report a problem" / "Ask a question" segmented control: a Material
   two-way toggle, active side filled with the surface-container tone and a
   bottom accent bar (borrowed from Material's tab-indicator convention) so
   the current selection reads clearly even before either label is read. */
.slidev-muan-companion-tabs {
  display: flex;
  gap: 0.35em;
  padding: 0.25em;
  border-radius: var(--wt-radius-sm);
  background: var(--wt-color-surface-container);
}
.slidev-muan-companion-tab {
  flex: 1 1 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.4em;
  padding: 0.5em 0.4em;
  border: none;
  border-radius: calc(var(--wt-radius-sm) - 4px);
  background: transparent;
  color: var(--wt-color-on-surface-variant);
  font: inherit;
  font-size: 0.82em;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.slidev-muan-companion-tab .wt-icon {
  width: 15px;
  height: 15px;
}
.slidev-muan-companion-tab:hover {
  color: var(--wt-color-on-surface);
}
.slidev-muan-companion-tab-active,
.slidev-muan-companion-tab-active:hover {
  background: var(--wt-color-surface);
  color: var(--wt-color-on-surface);
  box-shadow: var(--wt-elevation-2);
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

/* Outlined text field, Material's default for a multi-line input. Also
   reused (via a second class, see `.slidev-muan-companion-message-reply-
   textarea` below) inside the message notice's inline reply box and the
   resolution card's reopen-compose box, rather than a near-duplicate
   ruleset, since it's the same visual field in three contexts. */
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
   secondary action (capture, "still need help", "back"/"cancel") is
   outlined, the primary action (send, "yes that fixed it") is filled with
   the primary color — standard Material button hierarchy, reused
   identically across the main form and both follow-up cards. */
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
 * The two follow-up surfaces share one fixed, bottom-left stack (opposite
 * corner from the FAB, so neither collides with the widget) — see the
 * top-of-file comment for why they're two different components rather than
 * one, and `resolutionCard`/`messageNotice`'s own doc comments for each
 * one's specific persistence behavior.
 */
.slidev-muan-companion-notice-stack {
  position: fixed;
  left: 16px;
  bottom: 16px;
  z-index: 950;
  display: flex;
  flex-direction: column-reverse;
  gap: 0.6em;
  font-size: 14px;
}

/* Resolution card: an elevated surface card (not an inverted snackbar like
   the message notice below) — it's deliberately *not* styled as a
   transient toast, since unlike a toast it can carry a multi-step
   interaction (prompt → compose → acknowledgment) and needs to look like
   something the participant is meant to act on, not just glance past. */
.slidev-muan-companion-resolution-card {
  display: flex;
  flex-direction: column;
  gap: 0.6em;
  width: min(340px, 85vw);
  padding: 0.9em 1em;
  border-radius: var(--wt-radius-md);
  background: var(--wt-color-surface);
  color: var(--wt-color-on-surface);
  box-shadow: var(--wt-elevation-3);
}
.slidev-muan-companion-resolution-card-header {
  display: flex;
  align-items: center;
  gap: 0.5em;
}
.slidev-muan-companion-resolution-card-title {
  flex: 1 1 auto;
  font-weight: 500;
}
.slidev-muan-companion-resolution-prompt {
  margin: 0;
  font-weight: 500;
}
.slidev-muan-companion-resolution-message {
  margin: 0;
  opacity: 0.85;
  white-space: pre-wrap;
  word-break: break-word;
}
.slidev-muan-companion-resolution-actions {
  display: flex;
  gap: 0.5em;
}
.slidev-muan-companion-resolution-actions .slidev-muan-companion-error-button {
  flex: 1 1 0;
}
.slidev-muan-companion-resolution-confirm {
  background: var(--wt-color-success);
  color: var(--wt-color-inverse-on-surface);
  box-shadow: var(--wt-elevation-2);
}
.slidev-muan-companion-resolution-confirm:hover {
  box-shadow: var(--wt-elevation-3);
}

/*
 * Message notice: kept as the *original* Material Snackbar treatment this
 * whole file used for the pre-redesign resolution toast — bottom-anchored,
 * compact, auto-dismissing. Deliberately uses the *inverse* surface color
 * even in dark mode — Material's own snackbar spec inverts surface/on-
 * surface so a transient message visually pops against the page instead of
 * blending into it, which a same-color card can't do. This is exactly the
 * treatment the resolution card above intentionally moved *away* from, now
 * that it carries a real decision rather than being purely informational.
 */
.slidev-muan-companion-message-toast {
  display: flex;
  align-items: flex-start;
  gap: 0.6em;
  width: min(340px, 85vw);
  padding: 0.85em 0.9em;
  border-radius: var(--wt-radius-sm);
  background: var(--wt-color-inverse-surface);
  color: var(--wt-color-inverse-on-surface);
  box-shadow: var(--wt-elevation-3);
}
.slidev-muan-companion-message-toast .wt-icon-help {
  /* The inverse surface already provides enough contrast on its own; the
     primary-blue tint used elsewhere for this glyph would clash with the
     snackbar's intentionally neutral inverted palette. */
  color: currentColor;
  opacity: 0.75;
}
.slidev-muan-companion-message-toast .slidev-muan-companion-icon-button {
  color: var(--wt-color-inverse-on-surface);
  opacity: 0.75;
}
.slidev-muan-companion-message-toast .slidev-muan-companion-icon-button:hover {
  opacity: 1;
  background: rgba(128, 128, 128, 0.24);
}
.slidev-muan-companion-message-body {
  flex: 1 1 auto;
  min-width: 0;
  padding-top: 0.1em;
}
.slidev-muan-companion-message-title {
  margin: 0;
  font-weight: 500;
}
.slidev-muan-companion-message-text {
  margin: 0.3em 0 0;
  opacity: 0.9;
  white-space: pre-wrap;
  word-break: break-word;
}
.slidev-muan-companion-message-reply-toggle {
  margin: 0.4em 0 0;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 500;
  font-size: 0.85em;
  text-decoration: underline;
  opacity: 0.85;
  cursor: pointer;
}
.slidev-muan-companion-message-reply-toggle:hover {
  opacity: 1;
}
.slidev-muan-companion-message-sent {
  margin: 0.4em 0 0;
  font-size: 0.85em;
  opacity: 0.75;
}
.slidev-muan-companion-message-reply {
  display: flex;
  flex-direction: column;
  gap: 0.5em;
  margin-top: 0.5em;
}
/* The reply box sits on the snackbar's inverted background, so it needs its
   own (non-inverted-relative) border/text color rather than inheriting the
   shared textarea rule's `color: inherit` + outline-token border, which
   would otherwise render nearly invisible against this specific surface. */
.slidev-muan-companion-message-reply-textarea {
  border-color: currentColor;
  opacity: 0.95;
}
.slidev-muan-companion-message-reply-textarea::placeholder {
  color: currentColor;
  opacity: 0.6;
}
.slidev-muan-companion-message-reply .slidev-muan-companion-error-button-outlined {
  border-color: currentColor;
  color: inherit;
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
