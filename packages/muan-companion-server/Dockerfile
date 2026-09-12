# syntax=docker/dockerfile:1
#
# muan-companion-server — the persistent Node/Socket.io sync process for
# slidev-addon-muan-companion. See ../../muan-companion.md ("Docker") for
# build/run instructions.
#
# ASSUMPTION / WHY THIS ISN'T A ONE-DIRECTORY BUILD:
# `package.json` in this package resolves most of its dependency versions
# via `catalog:` refs (see repo-root `pnpm-workspace.yaml`), which only
# mean anything inside the pnpm workspace they're declared in. There is no
# `workspace:*` dependency on another package in this repo (this package's
# own deps are all plain npm packages), but pnpm still needs the *whole*
# workspace's metadata — root `package.json`, `pnpm-workspace.yaml`,
# `pnpm-lock.yaml`, and every workspace member's `package.json` (to
# validate the lockfile) — to do a `--frozen-lockfile` install correctly.
# pnpm has no "fetch just the manifests" mode, so this Dockerfile is meant
# to be built with the **repo root as build context**, not this directory:
#
#   docker build -f packages/muan-companion-server/Dockerfile -t muan-companion-server .
#
# (run from the repo root). The `.dockerignore` next to this file keeps
# that root-context copy from dragging in node_modules/.git/build output —
# see its own comment for the BuildKit lookup nuance that makes this file
# apply at all when the context isn't this directory.

# ---------------------------------------------------------------------------
# Builder: install the full workspace (frozen lockfile) and build just this
# package with tsdown (same as `pnpm --filter muan-companion-server build`).
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder
WORKDIR /repo

# Matches "packageManager": "pnpm@11.22.0" in the repo root package.json.
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter muan-companion-server run build

# ---------------------------------------------------------------------------
# Runtime: a slim image with only what's needed to run `node dist/index.mjs`.
#
# tsdown (repo-root tsdown.config.ts) only externalizes `@slidev/*` — every
# other dependency (socket.io, connect, sirv, pathe, busboy) is left as a
# real `node_modules` import in dist/index.mjs, not bundled in. So this
# stage still needs node_modules, not just dist/. The workspace has
# `shamefullyHoist: true` (pnpm-workspace.yaml), so the builder's flat
# /repo/node_modules already contains everything this package needs at
# runtime — copying it wholesale is simplest and correct, at the cost of
# also carrying devDependencies (tsdown, vitest, etc. for the *whole*
# workspace) into the runtime image. If image size becomes a real concern,
# replace this with `pnpm --filter muan-companion-server deploy --prod
# /out` in the builder stage (produces a pruned, prod-only node_modules)
# and copy /out instead — not done here to keep this Dockerfile simple and
# because it hasn't been validated against this repo's package.json
# layout (no `files` field is set, so `pnpm deploy`'s default file
# selection wasn't checked against what dist/+public/ actually need).
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/muan-companion-server/package.json ./package.json
COPY --from=builder /repo/packages/muan-companion-server/dist ./dist
# server.ts resolves the dashboard's static files relative to its own
# compiled location on disk (`dist/../public/dashboard` — see
# DASHBOARD_PUBLIC_DIR in src/server.ts), so public/ must ship next to
# dist/ or GET /dashboard 404s.
COPY --from=builder /repo/packages/muan-companion-server/public ./public

# Not baked in as ENV defaults on purpose: SLIDEV_MUAN_COMPANION_ROOM_CODE
# and SLIDEV_MUAN_COMPANION_PRESENTER_CODE are secrets the operator must
# choose per workshop (see muan-companion.md "Security notes") — pass them
# with `docker run -e`, not by editing this file.
EXPOSE 3710

CMD ["node", "dist/index.mjs"]
