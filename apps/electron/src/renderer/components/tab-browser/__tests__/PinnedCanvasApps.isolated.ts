/**
 * POO-154 — pure row-model tests for the Home pinned-canvas-apps section.
 *
 * The section only renders when a pinned canvas app exists, and its actions
 * delegate to TabShell (openApp/removeApp). These tests pin the selection and
 * label contracts — the guard that keeps builtin/polo tabs, knowledge-base
 * entries and sideloaded webapps out of the section, and the fallback name
 * that shows when a pinned entry lost its title.
 */
import { describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AppDefinition } from '../../../../shared/tab-browser-types'

GlobalRegistrator.register()

// The component module pulls the real TabShellContext, which reaches into
// Jotai/Electron-only surface. Nothing under test renders it, so a stub keeps
// this file import-pure.
mock.module('@/context/TabShellContext', () => ({
  useTabShell: () => {
    throw new Error('not used by the pure helpers')
  },
}))

// client-workbench → client-workbench-style → ThemeContext, whose module scope
// calls Vite's import.meta.glob (absent under bun:test). Stub it like the
// membership-banner interaction test does — the hooks here are never invoked.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

const { isPinnedCanvasApp, selectPinnedCanvasApps, pinnedCanvasAppLabel } = await import('../PinnedCanvasApps')

const { KNOWLEDGE_BASE_APP_DEFINITION, POLO_APP_DEFINITION } = await import(
  '../../../../shared/tab-browser-types'
)

/** Minimal i18n stub: only the fallback key is consulted by these helpers. */
const t = ((key: string) => (key === 'homeApps.canvas.fallbackName' ? 'Canvas app' : key)) as never as Parameters<
  typeof pinnedCanvasAppLabel
>[1]

function app(id: string, name: string): AppDefinition {
  return { id, name, url: 'https://app.example', type: 'webapp', createdAt: 1, order: 0 }
}

describe('isPinnedCanvasApp', () => {
  it('accepts only the gen-ui-app- launcher prefix', () => {
    expect(isPinnedCanvasApp(app('gen-ui-app-abc', 'Demo'))).toBe(true)
    expect(isPinnedCanvasApp(app('gen-ui-app-', ''))).toBe(true)
  })

  it('rejects builtin, sideloaded and prefix-impostor ids', () => {
    expect(isPinnedCanvasApp(POLO_APP_DEFINITION)).toBe(false)
    expect(isPinnedCanvasApp(KNOWLEDGE_BASE_APP_DEFINITION)).toBe(false)
    expect(isPinnedCanvasApp(app('web-abc', 'Sideloaded'))).toBe(false)
    expect(isPinnedCanvasApp(app('gen-ui-appx-abc', 'Impostor'))).toBe(false)
  })
})

describe('selectPinnedCanvasApps', () => {
  it('keeps only canvas apps in first-seen order', () => {
    const selected = selectPinnedCanvasApps([
      app('web-1', 'Sideloaded'),
      app('gen-ui-app-b', 'Second'),
      POLO_APP_DEFINITION,
      app('gen-ui-app-a', 'First'),
    ])
    expect(selected.map((candidate) => candidate.id)).toEqual(['gen-ui-app-b', 'gen-ui-app-a'])
  })

  it('returns an empty list for a launcher with no canvas apps', () => {
    expect(selectPinnedCanvasApps([POLO_APP_DEFINITION, app('web-1', 'Sideloaded')])).toEqual([])
  })
})

describe('pinnedCanvasAppLabel', () => {
  it('uses the pinned title when present', () => {
    expect(pinnedCanvasAppLabel(app('gen-ui-app-a', 'Weather'), t)).toBe('Weather')
  })

  it('falls back when the pinned entry lost its title', () => {
    expect(pinnedCanvasAppLabel(app('gen-ui-app-a', ''), t)).toBe('Canvas app')
  })
})
