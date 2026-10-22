import { describe, it, expect } from 'bun:test'
import { getDefaultStore } from 'jotai'
import {
  CANVAS_PANE_DEFAULT_RATIO,
  CANVAS_PANE_MAX_RATIO,
  CANVAS_PANE_MIN_RATIO,
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
