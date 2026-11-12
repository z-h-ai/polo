/**
 * Focus tests: composer float caret anchor fallback (UX session R-AT follow-up).
 *
 * getCaretRect() can fail (no selection, collapsed zero-size rect). The old
 * fallback estimated the caret row with a hardcoded 20px line-height, which
 * drifted onto the wrong row for long multi-line (CJK) text. The shared
 * `resolveComposerFloatAnchor` must:
 *  1. prefer the real caret measurement,
 *  2. fall back anchored to the rich-text input CONTAINER (never outside it),
 *  3. read the element's actual computed line-height, not a guess.
 * Coordinate contract: viewport-space caret top edge (see viewport-portal.tsx).
 */
import { describe, it, expect, afterEach } from 'bun:test'
import { resolveComposerFloatAnchor } from '../composer-float-anchor'

interface RectInit {
  left?: number; top?: number; right?: number; bottom?: number
  width?: number; height?: number; x?: number; y?: number
}

function makeRect(init: RectInit = {}): DOMRect {
  const left = init.left ?? 0
  const top = init.top ?? 0
  const width = init.width ?? 0
  const height = init.height ?? 0
  return {
    left, top, width, height,
    right: init.right ?? left + width,
    bottom: init.bottom ?? top + height,
    x: init.x ?? left,
    y: init.y ?? top,
    toJSON: () => ({}),
  } as unknown as DOMRect
}

function makeInput(opts: {
  rect?: RectInit
  caretRect?: DOMRect | null
  exposeCaretRect?: boolean
  element?: Element | null
} = {}) {
  const input: Record<string, unknown> = {
    getBoundingClientRect: () => makeRect(opts.rect),
  }
  if (opts.exposeCaretRect !== false) input.getCaretRect = () => opts.caretRect ?? null
  if (opts.element !== undefined) input.element = opts.element
  return input as unknown as Parameters<typeof resolveComposerFloatAnchor>[0]
}

const CONTAINER: RectInit = { left: 100, top: 200, width: 400, height: 200, right: 500, bottom: 400 }

const originalWindow = (globalThis as unknown as { window?: unknown }).window

function setComputedLineHeight(value: string | undefined) {
  ;(globalThis as unknown as { window?: unknown }).window = {
    getComputedStyle: () => ({ lineHeight: value, fontSize: '14px' }),
  }
}

function clearWindow() {
  delete (globalThis as unknown as { window?: unknown }).window
}

afterEach(() => {
  if (originalWindow === undefined) clearWindow()
  else (globalThis as unknown as { window?: unknown }).window = originalWindow
})

describe('resolveComposerFloatAnchor', () => {
  it('returns null when there is no input handle', () => {
    expect(resolveComposerFloatAnchor(null, '')).toBeNull()
    expect(resolveComposerFloatAnchor(undefined, '')).toBeNull()
  })

  it('prefers the real caret measurement (viewport-space caret top)', () => {
    const caret = makeRect({ left: 321, top: 445, width: 1, height: 18, x: 321, y: 445 })
    const anchor = resolveComposerFloatAnchor(makeInput({ rect: CONTAINER, caretRect: caret }), '')
    expect(anchor).toEqual({ x: 321, y: 445 })
  })

  it('falls back to the container when getCaretRect returns null', () => {
    setComputedLineHeight('20px')
    const anchor = resolveComposerFloatAnchor(
      makeInput({ rect: CONTAINER, caretRect: null, element: {} as Element }),
      'first line',
    )
    expect(anchor).toEqual({ x: 100, y: 220 })
  })

  it('falls back when the caret rect is a collapsed zero-size measurement', () => {
    setComputedLineHeight('20px')
    const zero = makeRect({ x: 0, y: 0, width: 0, height: 0 })
    const anchor = resolveComposerFloatAnchor(
      makeInput({ rect: CONTAINER, caretRect: zero, element: {} as Element }),
      '',
    )
    expect(anchor).toEqual({ x: 100, y: 220 })
  })

  it('anchors x to the container left edge (never outside the composer)', () => {
    setComputedLineHeight('20px')
    const anchor = resolveComposerFloatAnchor(
      makeInput({ rect: CONTAINER, caretRect: null, element: {} as Element }),
      '',
    )
    expect(anchor?.x).toBe(100)
  })

  it('estimates the caret row with the ACTUAL computed line-height', () => {
    // Editor renders `lineHeight: 1.25` over text-sm → 17.5px, NOT 20px.
    setComputedLineHeight('17.5px')
    // 3 newlines before the caret → caret sits on line index 3 → bottom edge = top + 4 × 17.5.
    const anchor = resolveComposerFloatAnchor(
      makeInput({ rect: CONTAINER, caretRect: null, element: {} as Element }),
      '第一行\n第二行\n第三行\n',
    )
    expect(anchor).toEqual({ x: 100, y: 200 + 4 * 17.5 })
  })

  it('keeps the estimate inside the container for very long multi-line text', () => {
    setComputedLineHeight('20px')
    const manyLines = Array.from({ length: 100 }, (_, i) => `第${i}行`).join('\n')
    const anchor = resolveComposerFloatAnchor(
      makeInput({ rect: CONTAINER, caretRect: null, element: {} as Element }),
      manyLines,
    )
    expect(anchor).toEqual({ x: 100, y: 400 })
  })

  it('still falls back without an exposed element, using the line-height default', () => {
    clearWindow()
    const anchor = resolveComposerFloatAnchor(makeInput({ rect: CONTAINER, caretRect: null }), '')
    expect(anchor).toEqual({ x: 100, y: 220 })
  })

  it('returns null when the container rect carries no layout (detached node)', () => {
    const anchor = resolveComposerFloatAnchor(makeInput({ rect: {}, caretRect: null }), '')
    expect(anchor).toBeNull()
  })

  it('supports bare handles that expose no getCaretRect at all', () => {
    clearWindow()
    const anchor = resolveComposerFloatAnchor(makeInput({ rect: CONTAINER, exposeCaretRect: false }), '')
    expect(anchor).toEqual({ x: 100, y: 220 })
  })
})
