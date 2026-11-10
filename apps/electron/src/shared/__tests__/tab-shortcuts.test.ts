import { describe, expect, it } from 'bun:test'
import {
  cycleVisibleTab,
  resolveTabShortcutTarget,
} from '../tab-browser-types'

/**
 * POO-205 C4 (R6): the keyboard tab navigation mapping is pure and runs over
 * the VISIBLE tabs. In an enterprise committed space the retired Polo tab is
 * already filtered out by visibleTabsAtom — these fixtures therefore carry no
 * Polo tab at all, which is exactly what the shell passes in.
 */

const TABS = [
  { id: 'project-a' },
  { id: 'webapp-1' },
  { id: 'project-b' },
]

describe('resolveTabShortcutTarget (⌘1 = Home, ⌘2… = visible strip order)', () => {
  it('⌘1 is ALWAYS Home — the Polo tab never occupies digit 1', () => {
    expect(resolveTabShortcutTarget(1, TABS)).toEqual({ kind: 'home' })
    expect(resolveTabShortcutTarget(1, [])).toEqual({ kind: 'home' })
  })

  it('⌘2 walks the first VISIBLE tab — the enterprise Polo ghost can never be hit', () => {
    expect(resolveTabShortcutTarget(2, TABS)).toEqual({ kind: 'tab', tabId: 'project-a' })
    expect(resolveTabShortcutTarget(3, TABS)).toEqual({ kind: 'tab', tabId: 'webapp-1' })
    expect(resolveTabShortcutTarget(4, TABS)).toEqual({ kind: 'tab', tabId: 'project-b' })
  })

  it('a digit beyond the strip answers none (the shell keeps the current tab)', () => {
    expect(resolveTabShortcutTarget(5, TABS)).toEqual({ kind: 'none' })
    expect(resolveTabShortcutTarget(9, [])).toEqual({ kind: 'none' })
  })
})

describe('cycleVisibleTab (⌘⇧[ ] over Home + visible tabs)', () => {
  it('cycles Home → first tab → … → last → Home, wrapping at both ends', () => {
    expect(cycleVisibleTab('home', TABS, 1)).toEqual({ kind: 'tab', tabId: 'project-a' })
    expect(cycleVisibleTab('webapp-1', TABS, 1)).toEqual({ kind: 'tab', tabId: 'project-b' })
    expect(cycleVisibleTab('project-b', TABS, 1)).toEqual({ kind: 'home' })
    expect(cycleVisibleTab('home', TABS, -1)).toEqual({ kind: 'tab', tabId: 'project-b' })
  })

  it('an unknown active id starts the cycle from Home', () => {
    expect(cycleVisibleTab('closed-tab', TABS, 1)).toEqual({ kind: 'tab', tabId: 'project-a' })
  })

  it('an empty strip cycles Home ⇄ Home', () => {
    expect(cycleVisibleTab('home', [], 1)).toEqual({ kind: 'home' })
    expect(cycleVisibleTab('home', [], -1)).toEqual({ kind: 'home' })
  })
})
