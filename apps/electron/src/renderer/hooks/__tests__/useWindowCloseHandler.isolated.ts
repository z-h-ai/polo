import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// Shared-process pattern (see TopBar.app-menu.isolated.ts): register happy-dom
// only when no window exists and pin a macOS userAgent so platform reads stay
// stable across files in the shared bun process.
if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}

// --- Controllable layer/modal/panel/tab state (read by the hook) ------------

const closeTop = mock(() => {})
const closeTopModal = mock(() => {})
const closedPanels: string[] = []

let hasOpenLayers = false
let hasOpenModals = false
let panelStack: Array<{ id: string }> = []
let focusedPanelId: string | null = null
let activeTabId = 'home'

mock.module('@/context/DismissibleLayerContext', () => ({
  useDismissibleLayerRegistry: () => ({
    hasOpenLayers: () => hasOpenLayers,
    closeTop,
  }),
}))
mock.module('@/context/ModalContext', () => ({
  useModalRegistry: () => ({
    hasOpenModals: () => hasOpenModals,
    closeTopModal,
  }),
}))

// Distinct fake atom references so the jotai mock can route reads.
const panelStackAtomRef = Symbol('panelStackAtom')
const focusedPanelIdAtomRef = Symbol('focusedPanelIdAtom')
const closePanelAtomRef = Symbol('closePanelAtom')
const activeTabIdAtomRef = Symbol('activeTabIdAtom')

mock.module('@/atoms/panel-stack', () => ({
  panelStackAtom: panelStackAtomRef,
  focusedPanelIdAtom: focusedPanelIdAtomRef,
  closePanelAtom: closePanelAtomRef,
}))
mock.module('@/atoms/tab-browser', () => ({
  activeTabIdAtom: activeTabIdAtomRef,
}))
mock.module('jotai', () => ({
  useAtomValue: (atom: unknown) => {
    if (atom === panelStackAtomRef) return panelStack
    if (atom === focusedPanelIdAtomRef) return focusedPanelId
    if (atom === activeTabIdAtomRef) return activeTabId
    return null
  },
  useSetAtom: (atom: unknown) => {
    if (atom === closePanelAtomRef) return (panelId: string) => { closedPanels.push(panelId) }
    return () => {}
  },
}))

// --- electronAPI capture -----------------------------------------------------

type CloseRequest = { source: 'keyboard-shortcut' | 'window-button' | 'unknown' }
let deliveredRequest: ((request: CloseRequest) => void) | null = null
const confirmSpy = mock(() => {})
const cancelSpy = mock(() => {})

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    onCloseRequested: (callback: (request: CloseRequest) => void) => {
      deliveredRequest = callback
      return () => { deliveredRequest = null }
    },
    confirmCloseWindow: confirmSpy,
    cancelCloseWindow: cancelSpy,
  },
})

const { render, cleanup } = await import('@testing-library/react')
const { createElement } = await import('react')
const { useWindowCloseHandler } = await import('../useWindowCloseHandler')

/** Mounts the hook the way App.tsx's WindowCloseHandler component does. */
function Harness({ guard }: { guard?: boolean }) {
  useWindowCloseHandler(guard === undefined ? {} : { assistantTabGuard: guard })
  return null
}

function dispatch(source: CloseRequest['source']) {
  expect(deliveredRequest).toBeTruthy()
  confirmSpy.mockClear()
  cancelSpy.mockClear()
  deliveredRequest!({ source })
}

afterEach(() => {
  cleanup()
  hasOpenLayers = false
  hasOpenModals = false
  panelStack = []
  focusedPanelId = null
  activeTabId = 'home'
  closeTop.mockClear()
  closeTopModal.mockClear()
  closedPanels.length = 0
})

describe('useWindowCloseHandler assistant keyboard guard (POO-104)', () => {
  it('P104-02: assistant active + plain Cmd/W request with no layers → cancel the close, window stays', () => {
    activeTabId = 'polo-ai-tab'
    render(createElement(Harness, { guard: true }))

    dispatch('keyboard-shortcut')

    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('P104-03: dismissible layer takes priority — the guard only eats the bare window close', () => {
    activeTabId = 'polo-ai-tab'
    hasOpenLayers = true
    render(createElement(Harness, { guard: true }))

    dispatch('keyboard-shortcut')

    expect(closeTop).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('P104-03: legacy modal takes priority over the guard', () => {
    activeTabId = 'polo-ai-tab'
    hasOpenModals = true
    render(createElement(Harness, { guard: true }))

    dispatch('keyboard-shortcut')

    expect(closeTopModal).toHaveBeenCalledTimes(1)
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('P104-03: focused panel takes priority over the guard', () => {
    activeTabId = 'polo-ai-tab'
    panelStack = [{ id: 'panel-1' }]
    focusedPanelId = 'panel-1'
    render(createElement(Harness, { guard: true }))

    dispatch('keyboard-shortcut')

    expect(closedPanels).toEqual(['panel-1'])
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('P104-07: window-button close keeps its explicit semantics even with the assistant active', () => {
    activeTabId = 'polo-ai-tab'
    render(createElement(Harness, { guard: true }))

    dispatch('window-button')

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('unknown source keeps the legacy fallback (confirm) — the guard is keyboard-scoped', () => {
    activeTabId = 'polo-ai-tab'
    render(createElement(Harness, { guard: true }))

    dispatch('unknown')

    expect(confirmSpy).toHaveBeenCalledTimes(1)
  })

  it('P104-04: a regular app tab keeps the existing close semantics (window closes)', () => {
    activeTabId = 'webapp-some-app'
    render(createElement(Harness, { guard: true }))

    dispatch('keyboard-shortcut')

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('guard off (screens without TabShell) never swallows the close even if tab state is stale', () => {
    // Stale renderer state from a previous shell: activeTabId still points at
    // the assistant, but this surface renders no TabShellProvider at all.
    activeTabId = 'polo-ai-tab'
    render(createElement(Harness, { guard: false }))

    dispatch('keyboard-shortcut')

    expect(confirmSpy).toHaveBeenCalledTimes(1)
    expect(cancelSpy).not.toHaveBeenCalled()
  })

  it('follows live tab activation: re-subscribes when the active tab changes', () => {
    activeTabId = 'webapp-some-app'
    const { rerender } = render(createElement(Harness, { guard: true }))

    dispatch('keyboard-shortcut')
    expect(confirmSpy).toHaveBeenCalledTimes(1)

    // Assistant becomes active; the same mounted handler must now cancel.
    activeTabId = 'polo-ai-tab'
    rerender(createElement(Harness, { guard: true }))

    dispatch('keyboard-shortcut')
    expect(cancelSpy).toHaveBeenCalledTimes(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })
})
