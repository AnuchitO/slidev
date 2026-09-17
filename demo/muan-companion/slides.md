---
theme: default
# NOTE: not `../../packages/addon-muan-companion` (a relative path) — see
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
  - slidev-addon-muan-companion
title: Muan Companion — M1 slide-sync demo
---

# Muan Companion — M1/M2 demo

Manual multi-device verification deck for
[plan 026](../../plans/026-workshop-tracker-m1-slide-sync.md) (slide sync)
and [plan 027](../../plans/027-workshop-tracker-m2-step-tracking.md)
(participant identity + step tracking).

Open `/presenter/1` in one window and `/1` in another (or on a second
device), then navigate here to confirm the participant window follows. On
the participant window, join with a name when prompted, then open a third
window at `/dashboard` on the sync server (e.g. `http://localhost:3710/dashboard`).

---

# Slide 2

If you're on the participant window (`/1`), this should appear automatically
within ~1s of the presenter advancing — no manual refresh.

---
stepId: install-deps
---

# Step — Install dependencies

Run the command below, click **Copy**, then **Done** once it finishes. Watch
the dashboard window update within ~1s.

<StepCommand command="cd workshop-repo && npm install" />

---
stepId: read-the-docs
---

# Step — Read the docs (no command)

Some steps don't have a command to run — the Done button is still available
so participants can acknowledge them (PRD §8).

<StepCommand />

---

# Slide 5

Reload the participant window now. It should land back on slide 5 (or
wherever the presenter currently is), not slide 1 — and it should rejoin the
dashboard as the *same* participant rather than a new one (same-tab
`sessionStorage`, per plan 027 Step 2).
