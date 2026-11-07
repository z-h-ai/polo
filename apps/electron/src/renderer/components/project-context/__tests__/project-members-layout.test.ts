import { describe, expect, test } from 'bun:test'
import {
  PROJECT_MEMBERS_HYSTERESIS,
  PROJECT_MEMBERS_MIN_CHAT_WIDTH,
  PROJECT_MEMBERS_PANEL_WIDTH,
  drawerWidthFor,
  resolveProjectMembersMode,
} from '../project-members-layout'

describe('resolveProjectMembersMode', () => {
  test('roomy shell with a free right column pushes', () => {
    expect(resolveProjectMembersMode({
      shellWidth: 1440,
      chatLaneWidth: 900,
      panelWidth: 320,
      gapWidth: 16,
    })).toBe('push')
  })

  test('the compact shell (below 768) always drawers', () => {
    expect(resolveProjectMembersMode({
      shellWidth: 767,
      chatLaneWidth: 2000,
    })).toBe('drawer')
    expect(resolveProjectMembersMode({
      shellWidth: 641,
      chatLaneWidth: 2000,
    })).toBe('drawer')
  })

  test('an occupied tool pane forces the drawer regardless of width', () => {
    expect(resolveProjectMembersMode({
      shellWidth: 1600,
      chatLaneWidth: 1200,
      toolPaneOccupied: true,
    })).toBe('drawer')
  })

  test('unmeasured lanes fail closed to the drawer', () => {
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: 0 })).toBe('drawer')
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: -20 })).toBe('drawer')
  })

  test('first open: exactly at the threshold pushes, one pixel below drawers', () => {
    const lane = PROJECT_MEMBERS_MIN_CHAT_WIDTH + PROJECT_MEMBERS_PANEL_WIDTH
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: lane })).toBe('push')
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: lane - 1 })).toBe('drawer')
  })

  test('hysteresis: push degrades instantly below the floor, drawer upgrades only past the band', () => {
    const laneAt480 = PROJECT_MEMBERS_MIN_CHAT_WIDTH + PROJECT_MEMBERS_PANEL_WIDTH
    const laneAt504 = laneAt480 + PROJECT_MEMBERS_HYSTERESIS
    // An established push falls back as soon as net < 480.
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: laneAt480 - 1, previousMode: 'push' })).toBe('drawer')
    // Inside the band (480 ≤ net < 504) a drawer STAYS a drawer.
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: laneAt504 - 1, previousMode: 'drawer' })).toBe('drawer')
    // Past the band the drawer upgrades to push again.
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: laneAt504, previousMode: 'drawer' })).toBe('push')
  })

  test('gap width is deducted from the net calculation', () => {
    const lane = PROJECT_MEMBERS_MIN_CHAT_WIDTH + PROJECT_MEMBERS_PANEL_WIDTH
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: lane, gapWidth: 24 })).toBe('drawer')
    expect(resolveProjectMembersMode({ shellWidth: 1440, chatLaneWidth: lane + 24, gapWidth: 24 })).toBe('push')
  })
})

describe('drawerWidthFor', () => {
  test('clamps the panel to narrow viewports and never goes negative', () => {
    expect(drawerWidthFor(1200)).toBe(PROJECT_MEMBERS_PANEL_WIDTH)
    expect(drawerWidthFor(300)).toBe(300)
    expect(drawerWidthFor(0)).toBe(0)
  })
})
