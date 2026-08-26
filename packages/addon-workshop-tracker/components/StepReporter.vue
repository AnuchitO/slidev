<!--
Renders nothing. Reports the presenter's current `stepId` to the sync
server (`presenter:setStep { stepId }`) whenever it changes, so the
dashboard's "current step" status column (plan 027 Step 3) doesn't require
the server to parse deck markdown itself.

Deliberately *separate* from `presenter:setSlide` (`../setup/main.ts`),
which reports the slide *index*: the two need different mechanisms.
`setup/main.ts` runs pre-`app.mount()` and derives the index from the route
*path* directly (reliable — see that file's own comment on why it can't use
`useNav()`). Plan 027 Step 1 asked to empirically confirm frontmatter
passthrough "inside an actual component's setup()" before relying on it —
doing exactly that surfaced a real gap in the plan's original sketch: naively
reading `to.meta.slide.frontmatter` inside `setup/main.ts`'s
`router.afterEach` (as originally implemented here) returned `undefined` at
navigation time. `useNav().currentFrontmatter` is backed by the *reactive
`slides` array* (`currentSlideRoute = computed(() => slides.value[currentSlideNo.value
- 1])` in `packages/client/composables/useNav.ts`), not by the router's raw
resolved route object that `afterEach`'s `to` argument exposes — so only a
real mounted component using `useNav()` reads it reliably. This component is
that fix: mounted via `../global-top.vue` (Global Layers, see
`JoinScreen.vue`'s own comment) purely for its always-present injection
context, not for any UI.
-->
<script setup lang="ts">
import { useNav } from '@slidev/client'
import { watch } from 'vue'
import { getWorkshopSocket } from '../src/client'
import { resolveStepId } from '../src/stepId'

const { currentFrontmatter, currentSlideNo, isPresenter } = useNav()

watch(
  [isPresenter, currentSlideNo, currentFrontmatter],
  ([presenting, slideNo, frontmatter]) => {
    // NOTE(security): same gap as `presenter:setSlide` (026) — no auth yet,
    // so any client can claim `isPresenter` and report a step. Plan 029
    // closes this for both.
    if (!presenting)
      return
    const stepId = resolveStepId(frontmatter, slideNo)
    getWorkshopSocket().emit('presenter:setStep', { stepId })
  },
  { immediate: true },
)
</script>

<template>
  <!-- Renders nothing (see file-level comment) — a hidden element rather
       than an empty template, since Vue SFCs require a template root. -->
  <span hidden />
</template>
