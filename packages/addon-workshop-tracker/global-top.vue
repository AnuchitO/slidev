<!--
Slidev "Global Layer" (https://sli.dev/features/global-layers) — a
single-instance component that persists across every slide. Picked up
automatically because it's named `global-top.vue` at this addon's root (see
`packages/slidev/node/virtual/global-layers.ts`'s `getComponent('GlobalTop',
['global', 'global-top', 'GlobalTop'])`).

Renders <JoinScreen /> (the name-entry overlay) and <StepReporter /> (no
UI — reports the presenter's current step to the server, see its own
comment for why it has to be a real mounted component). Both stay their own
files rather than inlined here, so they're normal, independently
auto-registered components (`components/*.vue`) that could also be dropped
onto a specific slide directly if a deck ever wants that.
-->
<template>
  <JoinScreen />
  <StepReporter />
</template>
