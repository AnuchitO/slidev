import { defineAppSetup } from '@slidev/types'
import { getWorkshopSocket } from '../src/client'
import { resolveStepId } from '../src/stepId'

// Matches the route path format `slidePath.ts` produces:
// `presenter ? `/presenter/${no}` : `/${no}``. No other formats exist for
// normal navigation (see plan 026's "Current state").
const SLIDE_PATH_RE = /^\/(?:presenter\/)?(\d+)/

function slideNoFromPath(path: string): number | undefined {
  const m = SLIDE_PATH_RE.exec(path)
  return m ? Number(m[1]) : undefined
}

function isPresenterPath(path: string): boolean {
  return path.startsWith('/presenter/')
}

// This runs inside `defineAppSetup(({ app, router }) => ...)`, which fires
// **before** `app.mount()`, outside any component's setup context — Vue
// Router injection-based composables (`useNav()`, `useSlideContext()`) are
// not guaranteed to resolve correctly here since `useSlideContext` uses
// `inject()`. Only the `router` object passed as an argument is safe to use;
// parse the route path directly instead.
export default defineAppSetup(({ router }) => {
  const socket = getWorkshopSocket()

  // Guards against a participant's remote-driven navigation re-triggering
  // `presenter:setSlide` — only matters if that participant is ever on the
  // presenter route, but keep the guard regardless: cheap, and it removes a
  // whole class of feedback-loop bugs before 027+ adds more traffic on the
  // same socket.
  let applyingRemoteChange = false

  function navigateTo(index: number) {
    applyingRemoteChange = true
    router.push(`/${index}`).finally(() => {
      applyingRemoteChange = false
    })
  }

  // `slide:sync` / `slide:changed` read `router.currentRoute.value.path` to
  // decide "is this window the presenter", but that value isn't trustworthy
  // until the router's *own* initial navigation (to whatever URL the browser
  // actually loaded, e.g. `/presenter/1`) has resolved. A socket connecting
  // quickly (near-instant on localhost) can otherwise deliver `slide:sync`
  // before that resolves, see the router's default/un-resolved path, decide
  // "not the presenter", and force-navigate the presenter's own window away
  // from `/presenter/:no`. `router.isReady()` is awaited *inside* each
  // handler (not before registering them — see the `router.afterEach` note
  // below for why that distinction matters) — confirmed via manual
  // two-window verification (plan 026 Step 3) before adding this guard.
  async function onRemoteSlideChange({ index }: { index: number }) {
    await router.isReady()
    if (!isPresenterPath(router.currentRoute.value.path))
      navigateTo(index)
  }

  socket.on('slide:sync', onRemoteSlideChange)
  socket.on('slide:changed', onRemoteSlideChange)

  // Registered synchronously (not gated behind `router.isReady()`, unlike
  // the socket handlers above) — `afterEach` fires with the *actual*
  // navigation's own `to`, not a possibly-stale `router.currentRoute` read,
  // so it doesn't have the same race. It also fires for the router's very
  // first (initial) navigation once that resolves, which a presenter loading
  // straight into `/presenter/N` (N != 1) depends on to report N to the
  // server — registering this any later would miss that first navigation's
  // `afterEach` cycle entirely, since Vue Router doesn't replay past
  // navigations to listeners added after the fact.
  router.afterEach((to) => {
    if (applyingRemoteChange || !isPresenterPath(to.path))
      return
    const index = slideNoFromPath(to.path)
    if (index != null) {
      // `to.meta.slide.frontmatter` is a plain property on the *resolved*
      // route object, not an `inject()`-based composable — safe to read
      // here even though this handler runs from `setup/main.ts` (see the
      // file-level comment above on why `useNav()`/`useSlideContext()`
      // aren't used in this file). Reported alongside `presenter:setSlide`
      // so the dashboard's "current step" column (plan 027 Step 3) doesn't
      // require the server to parse deck markdown itself; see
      // `workshop-tracker-server`'s README for the server-side half of this.
      const stepId = resolveStepId(to.meta?.slide?.frontmatter, index)
      socket.emit('presenter:setSlide', { index, stepId })
    }
  })
})
