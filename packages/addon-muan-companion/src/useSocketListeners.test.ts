import type { Socket } from 'socket.io-client'
import { describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { useSocketListeners } from './useSocketListeners'

// `onMounted`/`onBeforeUnmount` only do anything with a real active
// component instance backing them — calling `useSocketListeners` directly
// from a test body (no `setup()` in progress) would silently no-op both
// hooks and prove nothing. Mounting (and unmounting) a throwaway component
// via plain `vue` — no `@vue/test-utils` dependency needed for this single
// composable — gives the hooks a real instance to attach to.
function mountWith(setup: () => void) {
  const app = createApp(defineComponent({
    setup() {
      setup()
      return () => h('div')
    },
  }))
  app.mount(document.createElement('div'))
  return () => app.unmount()
}

function fakeSocket() {
  return { on: vi.fn(), off: vi.fn() } as unknown as Socket
}

describe('useSocketListeners', () => {
  it('registers every listener on mount', () => {
    const socket = fakeSocket()
    const onFoo = vi.fn()
    const onBar = vi.fn()
    mountWith(() => useSocketListeners(socket, { foo: onFoo, bar: onBar }))
    expect(socket.on).toHaveBeenCalledWith('foo', onFoo)
    expect(socket.on).toHaveBeenCalledWith('bar', onBar)
  })

  it('removes every listener on unmount', () => {
    const socket = fakeSocket()
    const onFoo = vi.fn()
    const unmount = mountWith(() => useSocketListeners(socket, { foo: onFoo }))
    unmount()
    expect(socket.off).toHaveBeenCalledWith('foo', onFoo)
  })

  it('defaults to enabled when no `enabled` option is given', () => {
    const socket = fakeSocket()
    mountWith(() => useSocketListeners(socket, { foo: vi.fn() }))
    expect(socket.on).toHaveBeenCalled()
  })

  it('skips registration entirely when `enabled()` is false at mount time', () => {
    const socket = fakeSocket()
    const unmount = mountWith(() => useSocketListeners(socket, { foo: vi.fn() }, { enabled: () => false }))
    expect(socket.on).not.toHaveBeenCalled()
    unmount()
    // Cleanup mirrors whatever actually got registered — nothing to remove
    // since nothing was ever added.
    expect(socket.off).not.toHaveBeenCalled()
  })

  it('does not call off() for a listener that was never registered, even if `enabled()` later flips true', () => {
    const socket = fakeSocket()
    let enabled = false
    const unmount = mountWith(() => useSocketListeners(socket, { foo: vi.fn() }, { enabled: () => enabled }))
    enabled = true
    unmount()
    expect(socket.off).not.toHaveBeenCalled()
  })
})
