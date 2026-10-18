/**
 * GenUI streaming skeleton scanner (P0-2): extractGenUiSkeletons over the
 * PARTIAL JSON of an in-flight render_ui call. Only fully-closed, key-position
 * anchored "type"/"title" string pairs count; type must be whitelisted;
 * nothing else (no business data) is ever extracted. Truncation and string
 * embedded lookalikes must never produce false positives.
 */

import { describe, it, expect } from 'bun:test'
import { GENUI_SKELETON_COMPONENT_TYPES, extractGenUiSkeletons } from '../genuiSkeleton'
import { hasGenUiRenderer } from '../GenUICard'

describe('extractGenUiSkeletons — recognition', () => {
  it('recognizes a fully-closed type and pairs the nearest following title', () => {
    const partial = '{"components":[{"id":"rev","type":"stat-card","title":"Q3 Revenue","label":"Rev"}'
    expect(extractGenUiSkeletons(partial)).toEqual([
      { type: 'stat-card', title: 'Q3 Revenue' },
    ])
  })

  it('accepts whitespace between key, colon, and value', () => {
    const partial = '{ "components" : [ { "type" : "alert" , "title" : "Heads up" }'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'alert', title: 'Heads up' }])
  })

  it('ignores a type whose value string is still streaming (no closing quote)', () => {
    expect(extractGenUiSkeletons('{"components":[{"type":"data-tab')).toEqual([])
    expect(extractGenUiSkeletons('{"type":"form')).toEqual([])
  })

  it('ignores a title without a closing quote (truncated value)', () => {
    const partial = '{"components":[{"type":"progress","title":"Still typi'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'progress' }])
  })

  it('ignores non-string type values', () => {
    expect(extractGenUiSkeletons('{"type":123}')).toEqual([])
    expect(extractGenUiSkeletons('{"type":true}')).toEqual([])
  })

  it('ignores non-whitelisted type discriminators (e.g. table column types)', () => {
    const partial = '{"columns":[{"key":"region","type":"text","label":"Region"}],"type":"data-table"'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'data-table' }])
    // Unknown component type only → nothing
    expect(extractGenUiSkeletons('{"type":"treemap"}')).toEqual([])
  })

  it('unescapes JSON escapes inside the recognized value', () => {
    const partial = String.raw`{"type":"alert","title":"He said \"hi\" — q3"}`
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'alert', title: 'He said "hi" — q3' }])
  })
})

describe('extractGenUiSkeletons — anchoring (no false positives from string values)', () => {
  it('does not match a lookalike INSIDE a string value (escaped quotes break the anchor)', () => {
    // A rowAction/detailTemplate value mentioning a component type — the
    // embedded quotes are backslash-escaped, so the key-position anchor
    // ({ or , directly before the key's opening quote) can never fire.
    const partial = String.raw`{"type":"data-table","detailTemplate":"分析组件 \"type\":\"form\" 的行为"}`
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'data-table' }])
  })

  it('does not match keys inside array element strings', () => {
    // Array values are preceded by [ — not a key position
    const partial = '{"type":"chart","categories":["type","title"]'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'chart' }])
  })

  it('a key-position pair after a value-free key is still anchored (comma before key)', () => {
    const partial = '{"components":[{"id":1,"type":"form"}'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'form' }])
  })
})

describe('extractGenUiSkeletons — multi-component payloads', () => {
  it('extracts components in occurrence order', () => {
    const partial = [
      '{"components":[',
      '{"id":"a","type":"stat-card","title":"Revenue"},',
      '{"id":"b","type":"alert","severity":"info","message":"m"},',
      '{"id":"c","type":"chart"',
    ].join('')
    expect(extractGenUiSkeletons(partial)).toEqual([
      { type: 'stat-card', title: 'Revenue' },
      { type: 'alert' },
      { type: 'chart' },
    ])
  })

  it('a title never leaks across components (window bounded by the next type)', () => {
    // Second component has no title of its own before the third component's
    // type appears — it must NOT steal the third component's title.
    const partial = '{"type":"form","fields":[{"key":"a"}]},{"type":"alert","title":"Late title"'
    expect(extractGenUiSkeletons(partial)).toEqual([
      { type: 'form' },
      { type: 'alert', title: 'Late title' },
    ])
  })

  it('title before type (schema field order id/title/type) yields the type without a title', () => {
    const partial = '{"id":"rev","title":"Q3","type":"stat-card"'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'stat-card' }])
  })

  it('dedupes identical type+title skeletons across components', () => {
    const partial = [
      '{"components":[',
      '{"id":"a","type":"stat-card","title":"Same"},',
      '{"id":"b","type":"stat-card","title":"Same"},',
      '{"id":"c","type":"stat-card","title":"Other"}',
    ].join('')
    expect(extractGenUiSkeletons(partial)).toEqual([
      { type: 'stat-card', title: 'Same' },
      { type: 'stat-card', title: 'Other' },
    ])
  })

  it('returns an empty list for empty or garbage input (total function)', () => {
    expect(extractGenUiSkeletons('')).toEqual([])
    expect(extractGenUiSkeletons('not json at all')).toEqual([])
  })
})

describe('GENUI_SKELETON_COMPONENT_TYPES — registry lockstep', () => {
  it('contains exactly the render_ui component whitelist', () => {
    expect([...GENUI_SKELETON_COMPONENT_TYPES].sort()).toEqual([
      'action-buttons',
      'alert',
      'chart',
      'data-table',
      'form',
      'progress',
      'stat-card',
    ])
  })

  it('every skeleton type has a registered GenUICard renderer', () => {
    for (const type of GENUI_SKELETON_COMPONENT_TYPES) {
      expect(hasGenUiRenderer(type)).toBe(true)
    }
  })
})
