---
theme: default
# NOTE: not `../../packages/addon-workshop-tracker` (a relative path) — see
# plan 026's STOP condition #2 and this deck's package.json: Slidev's
# `resolveAddons()` (packages/slidev/node/integrations/addons.ts) passes a
# *directory* (`userRoot`) as the resolver's `importer`, but
# `createResolver`'s relative-path branch (resolver.ts) does
# `resolve(dirname(importer), name)`, assuming `importer` is a *file* (as
# `resolveTheme` correctly passes `entry`). That off-by-one-directory bug is
# pre-existing in Slidev core, not introduced by this plan, and out of scope
# to fix here — so this addon is resolved by workspace package name instead
# (a `workspace:*` devDependency + plain name goes through the working
# non-relative `findPkgRoot` resolution branch).
addons:
  - slidev-addon-workshop-tracker
title: Workshop Tracker — M1 slide-sync demo
---

# Workshop Tracker — M1 slide-sync demo

Manual multi-device verification deck for
[plan 026](../../plans/026-workshop-tracker-m1-slide-sync.md).

Open `/presenter/1` in one window and `/1` in another (or on a second
device), then navigate here to confirm the participant window follows.

---

# Slide 2

If you're on the participant window (`/1`), this should appear automatically
within ~1s of the presenter advancing — no manual refresh.

---

# Slide 3

Reload the participant window now. It should land back on slide 3 (or
wherever the presenter currently is), not slide 1.
