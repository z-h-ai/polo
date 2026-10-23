import { describe, it, expect } from 'bun:test'
import { getDefaultStore } from 'jotai'
import {
  CANVAS_PANE_DEFAULT_RATIO,
  CANVAS_PANE_MAX_RATIO,
  CANVAS_PANE_MIN_RATIO,
  canvasPaneRatioFromPointer,
  clampCanvasPaneRatio,
  canvasPaneAppAtomFamily,
  canvasPaneWidthAtomFamily,
} from '../canvas-pane'

describe('clampCanvasPaneRatio', () => {
  it('keeps in-band ratios untouched', () => {
    expect(clampCanvasPaneRatio(CANVAS_PANE_DEFAULT_RATIO)).toBe(0.45)
    expect(clampCanvasPaneRatio(0.33)).toBe(0.33)
  })

  it('clamps drags into the 25%–70% band', () => {
    expect(clampCanvasPaneRatio(0.05)).toBe(CANVAS_PANE_MIN_RATIO)
    expect(clampCanvasPaneRatio(0.95)).toBe(CANVAS_PANE_MAX_RATIO)
  })

  it('falls back to the default for unusable values', () => {
    expect(clampCanvasPaneRatio(Number.NaN)).toBe(CANVAS_PANE_DEFAULT_RATIO)
    expect(clampCanvasPaneRatio(Number.POSITIVE_INFINITY)).toBe(CANVAS_PANE_DEFAULT_RATIO)
  })
})

describe('canvas pane atom families', () => {
  it('start closed at the default width and are stable per session', () => {
    const store = getDefaultStore()
    expect(store.get(canvasPaneAppAtomFamily('sess-1'))).toBeNull()
    expect(store.get(canvasPaneWidthAtomFamily('sess-1'))).toBe(CANVAS_PANE_DEFAULT_RATIO)
    expect(canvasPaneAppAtomFamily('sess-1')).toBe(canvasPaneAppAtomFamily('sess-1'))
  })

  it('holds one app per session and keeps sessions isolated', () => {
    const store = getDefaultStore()
    const app = { appId: 'app-1', title: 'Demo', indexPath: '/tmp/app-1/index.html', version: 1 }
    store.set(canvasPaneAppAtomFamily('sess-1'), app)
    expect(store.get(canvasPaneAppAtomFamily('sess-1'))).toEqual(app)
    expect(store.get(canvasPaneAppAtomFamily('sess-2'))).toBeNull()

    store.set(canvasPaneWidthAtomFamily('sess-1'), 0.62)
    store.set(canvasPaneWidthAtomFamily('sess-2'), 0.3)
    expect(store.get(canvasPaneWidthAtomFamily('sess-1'))).toBe(0.62)
    expect(store.get(canvasPaneWidthAtomFamily('sess-2'))).toBe(0.3)
  })
})

describe('canvasPaneRatioFromPointer', () => {
  // A 1000px row with a 6px right inset: content box spans [0, 994].
  const rectRight = 1000
  const inset = 6
  const innerWidth = 994

  it('maps the pointer linearly across the row (before clamping)', () => {
    // In-band probe points: 0.7 of the content box and 0.25 of it.
    expect(canvasPaneRatioFromPointer(rectRight, inset, innerWidth, 994 - 0.7 * 994)).toBeCloseTo(0.7)
    expect(canvasPaneRatioFromPointer(rectRight, inset, innerWidth, 994 - 0.25 * 994)).toBeCloseTo(0.25)
    expect(canvasPaneRatioFromPointer(rectRight, inset, innerWidth, 994 - 0.5 * 994)).toBeCloseTo(0.5)
  })

  it('clamps into the pane band and ignores the border-box remainder', () => {
    expect(canvasPaneRatioFromPointer(rectRight, inset, innerWidth, 1000)).toBe(CANVAS_PANE_MIN_RATIO)
    expect(canvasPaneRatioFromPointer(rectRight, inset, innerWidth, -100)).toBe(CANVAS_PANE_MAX_RATIO)
  })

  it('falls back to the default ratio on a degenerate row', () => {
    expect(canvasPaneRatioFromPointer(rectRight, inset, 0, 500)).toBe(CANVAS_PANE_DEFAULT_RATIO)
    expect(canvasPaneRatioFromPointer(rectRight, inset, -5, 500)).toBe(CANVAS_PANE_DEFAULT_RATIO)
  })
})
