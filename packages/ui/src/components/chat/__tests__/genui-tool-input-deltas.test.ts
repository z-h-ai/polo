/**
 * Ephemeral tool_input_delta accumulator (P0-2): the renderer-internal buffer
 * feeding the skeleton scanner. Pure store semantics — append/clear/get and
 * change notifications — plus the TurnCard-facing hygiene contract.
 */

import { describe, it, expect, beforeEach } from 'bun:test'
import {
  appendGenUiToolInputDelta,
  clearGenUiToolInputDelta,
  clearGenUiToolInputDeltasForSession,
  getGenUiToolInputPartials,
  subscribeGenUiToolInputDeltas,
} from '../genuiToolInputDeltas'

describe('genuiToolInputDeltas accumulator', () => {
  beforeEach(() => {
    clearGenUiToolInputDeltasForSession('sess-a')
    clearGenUiToolInputDeltasForSession('sess-b')
  })

  it('accumulates chunks per (sessionId, toolUseId)', () => {
    appendGenUiToolInputDelta('sess-a', 'toolu_1', '{"components":[{"type":"sta')
    appendGenUiToolInputDelta('sess-a', 'toolu_1', 't-card"}]}')
    appendGenUiToolInputDelta('sess-a', 'toolu_2', '{"components":[{"type":"form"')
    appendGenUiToolInputDelta('sess-b', 'toolu_1', 'other session')

    expect(getGenUiToolInputPartials('sess-a').get('toolu_1')).toBe('{"components":[{"type":"stat-card"}]}')
    expect(getGenUiToolInputPartials('sess-a').get('toolu_2')).toBe('{"components":[{"type":"form"')
    expect(getGenUiToolInputPartials('sess-b').get('toolu_1')).toBe('other session')
  })

  it('clearing one tool call leaves siblings intact', () => {
    appendGenUiToolInputDelta('sess-a', 'toolu_1', 'x')
    appendGenUiToolInputDelta('sess-a', 'toolu_2', 'y')
    clearGenUiToolInputDelta('sess-a', 'toolu_1')
    expect(getGenUiToolInputPartials('sess-a').has('toolu_1')).toBe(false)
    expect(getGenUiToolInputPartials('sess-a').get('toolu_2')).toBe('y')
  })

  it('clearing a whole session drops every tool call buffer', () => {
    appendGenUiToolInputDelta('sess-a', 'toolu_1', 'x')
    appendGenUiToolInputDelta('sess-a', 'toolu_2', 'y')
    clearGenUiToolInputDeltasForSession('sess-a')
    expect(getGenUiToolInputPartials('sess-a').size).toBe(0)
  })

  it('notifies subscribers on append and clear', () => {
    let notifications = 0
    const unsubscribe = subscribeGenUiToolInputDeltas(() => { notifications += 1 })

    appendGenUiToolInputDelta('sess-a', 'toolu_1', 'x')
    expect(notifications).toBe(1)
    clearGenUiToolInputDelta('sess-a', 'toolu_1')
    expect(notifications).toBe(2)

    // No-op mutations do not notify
    appendGenUiToolInputDelta('sess-a', 'toolu_missing', '')
    clearGenUiToolInputDelta('sess-a', 'never-existed')
    expect(notifications).toBe(2)

    unsubscribe()
    appendGenUiToolInputDelta('sess-a', 'toolu_1', 'x')
    expect(notifications).toBe(2)
  })

  it('returns a stable reference between mutations (useSyncExternalStore contract)', () => {
    appendGenUiToolInputDelta('sess-a', 'toolu_1', 'x')
    const first = getGenUiToolInputPartials('sess-a')
    const second = getGenUiToolInputPartials('sess-a')
    expect(first).toBe(second)
    appendGenUiToolInputDelta('sess-a', 'toolu_1', 'y')
    expect(getGenUiToolInputPartials('sess-a')).not.toBe(first)
  })

  it('empty/unknown sessions yield an empty, stable map', () => {
    expect(getGenUiToolInputPartials('nope').size).toBe(0)
    expect(getGenUiToolInputPartials(null)).toBe(getGenUiToolInputPartials(undefined))
  })
})
