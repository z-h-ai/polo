/**
 * POO-198 — the sidebar occlusion coordinator's decision logic.
 *
 * The pane's native views must yield whenever DOM paints over them and come
 * back when it clears. The hit test itself is stubbed (elementFromPoint +
 * getBoundingClientRect) so the assertions are about the *rule* — a painting
 * element above the surface occludes, a transparent pointer guard and the
 * pane's own DOM do not — not about HappyDOM's layout fidelity.
 * Run per-file: `bun test ./apps/electron/src/renderer/hooks/__tests__/use-native-pane-occlusion.isolated.ts`
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

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

if (typeof (globalThis as any).ResizeObserver === 'undefined') {
  ;(globalThis as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// Scan synchronously: every schedule() is a decision we can assert right after
// the DOM change that caused it. Returning 0 (never a live frame id) mirrors
// the real contract that the id is only meaningful while the frame is pending.
;(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
  cb(0)
  return 0
}
;(globalThis as any).cancelAnimationFrame = () => {}

// --- electronAPI capture ------------------------------------------------------

const occlusionCalls: Array<[string, boolean]> = []

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    browserPane: {
      setEmbedOcclusion: async (...args: [boolean]) => {
        occlusionCalls.push(['browserPane', ...args])
      },
    },
    canvasPane: {
      setEmbedOcclusion: async (...args: [boolean]) => {
        occlusionCalls.push(['canvasPane', ...args])
      },
    },
  },
})

const { render, cleanup, act } = await import('@testing-library/react')
const { createElement, useRef } = await import('react')
const { useNativePaneOcclusion } = await import('../use-native-pane-occlusion')

/** Surface rect every probe lands in, and the element the hit test reports. */
const SURFACE_RECT = { left: 900, top: 60, width: 420, height: 700, right: 1320, bottom: 760, x: 900, y: 60, toJSON: () => ({}) }
let hitElement: Element | null = null

function buildPane() {
  const appRoot = document.createElement('div')
  appRoot.id = 'root'
  const paneRoot = document.createElement('div')
  appRoot.appendChild(paneRoot)
  const surface = document.createElement('div')
  surface.setAttribute('data-native-surface', 'true')
  paneRoot.appendChild(surface)
  surface.getBoundingClientRect = () => ({ ...SURFACE_RECT } as DOMRect)
  document.body.appendChild(appRoot)
  return { appRoot, paneRoot, surface }
}

function mountPane(paneRoot: HTMLElement, visible = true) {
  function Host() {
    const ref = useRef<HTMLElement | null>(paneRoot)
    useNativePaneOcclusion(ref, visible)
    return null
  }
  render(createElement(Host))
}

beforeEach(() => {
  document.body.innerHTML = ''
  occlusionCalls.length = 0
  hitElement = null
  document.elementFromPoint = () => hitElement
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useNativePaneOcclusion (POO-198)', () => {
  it('an overlay painting over the surface sends both panes to Main, and its removal brings them back', async () => {
    const { paneRoot } = buildPane()
    const overlay = document.createElement('div')
    overlay.style.backgroundColor = 'rgb(250, 250, 251)'
    document.body.appendChild(overlay)
    hitElement = overlay

    mountPane(paneRoot)
    await act(async () => {})

    expect(occlusionCalls).toEqual([
      ['browserPane', true],
      ['canvasPane', true],
    ])

    // The overlay unmounts (portal removal) → the hit test falls back to the
    // pane's own DOM → the views come back.
    hitElement = paneRoot
    await act(async () => {
      overlay.remove()
    })

    expect(occlusionCalls).toEqual([
      ['browserPane', true],
      ['canvasPane', true],
      ['browserPane', false],
      ['canvasPane', false],
    ])
  })

  it('a transparent pointer guard over the surface (the sash drag mask) does not occlude', async () => {
    const { paneRoot } = buildPane()
    const mask = document.createElement('div')
    mask.style.backgroundColor = 'rgba(0, 0, 0, 0)'
    document.body.appendChild(mask)
    hitElement = mask

    mountPane(paneRoot)
    await act(async () => {})

    expect(occlusionCalls).toEqual([])
  })

  it('the pane covering its own surface and a hidden pane both stay inert', async () => {
    const { paneRoot } = buildPane()
    hitElement = paneRoot
    mountPane(paneRoot)
    await act(async () => {})
    expect(occlusionCalls).toEqual([])

    cleanup()
    occlusionCalls.length = 0
    const overlay = document.createElement('div')
    overlay.style.backgroundColor = 'rgb(250, 250, 251)'
    document.body.appendChild(overlay)
    hitElement = overlay
    const hidden = buildPane()
    mountPane(hidden.paneRoot, false)
    await act(async () => {})
    expect(occlusionCalls).toEqual([])
  })

  it('a surface with no measured box (pane hidden behind a zero width) is never reported covered', async () => {
    const { paneRoot, surface } = buildPane()
    surface.getBoundingClientRect = () =>
      ({ ...SURFACE_RECT, width: 0, height: 0 } as DOMRect)
    const overlay = document.createElement('div')
    overlay.style.backgroundColor = 'rgb(250, 250, 251)'
    document.body.appendChild(overlay)
    hitElement = overlay

    mountPane(paneRoot)
    await act(async () => {})

    expect(occlusionCalls).toEqual([])
  })
})
