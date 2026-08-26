<!--
Slidev "Global Layer" (https://sli.dev/features/global-layers) — a
single-instance component that persists across every slide. Picked up
automatically because it's named `global-top.vue` at this addon's root (see
`packages/slidev/node/virtual/global-layers.ts`'s `getComponent('GlobalTop',
['global', 'global-top', 'GlobalTop'])`).

Just renders <JoinScreen /> — kept as its own file (rather than putting
JoinScreen's template directly here) so JoinScreen stays a normal,
independently auto-registered component (`components/JoinScreen.vue`) that
could also be dropped onto a specific slide directly if a deck ever wants
that, without having to touch this file.
-->
<template>
  <JoinScreen />
</template>
