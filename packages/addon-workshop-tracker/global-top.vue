<!--
Slidev "Global Layer" (https://sli.dev/features/global-layers) — a
single-instance component that persists across every slide. Picked up
automatically because it's named `global-top.vue` at this addon's root (see
`packages/slidev/node/virtual/global-layers.ts`'s `getComponent('GlobalTop',
['global', 'global-top', 'GlobalTop'])`).

Renders <JoinScreen /> (the name-entry overlay), <StepReporter /> (no
UI — reports the presenter's current step to the server), and
<PresenceReporter /> (no UI — reports this participant's visibility/
heartbeat to the server, plan 029 Step 2). All three stay their own files
rather than inlined here, so they're normal, independently auto-registered
components (`components/*.vue`) that could also be dropped onto a specific
slide directly if a deck ever wants that.
-->
<template>
  <JoinScreen />
  <StepReporter />
  <PresenceReporter />
</template>
