/**
 * GenUI streaming skeleton scanner (P0-2): extractGenUiSkeletons over the
 * PARTIAL JSON of an in-flight render_ui call. Only fully-closed, key-position
 * anchored "type"/"title" string pairs count; type must be whitelisted;
 * nothing else (no business data) is ever extracted. Truncation and string
 * embedded lookalikes must never produce false positives.
 */

import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GENUI_SKELETON_COMPONENT_TYPES, extractGenUiSkeletons, isRenderUiActivityToolName } from '../genuiSkeleton'
import { GENUI_COMPONENT_TYPES, hasGenUiRenderer } from '../GenUICard'

describe('isRenderUiActivityToolName (aligned with the emission-side predicate)', () => {
  it('accepts both the MCP-prefixed and the bare render_ui name', () => {
    expect(isRenderUiActivityToolName('mcp__session__render_ui')).toBe(true)
    expect(isRenderUiActivityToolName('render_ui')).toBe(true)
  })

  it('rejects every other tool', () => {
    expect(isRenderUiActivityToolName('mcp__session__generate_app')).toBe(false)
    expect(isRenderUiActivityToolName('mcp__session__call_llm')).toBe(false)
    expect(isRenderUiActivityToolName('Bash')).toBe(false)
    expect(isRenderUiActivityToolName(undefined)).toBe(false)
  })
})

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

  it('schema field order (id, title, type) pairs each title with its OWN component (P1 regression)', () => {
    // The model-visible JSON Schema declares id/title before type (GenUIBase),
    // so models emit titles PRECEDING their type. A forward-only window loses
    // the first title and misattributes the last one to the wrong component.
    const partial = [
      '{"components":[',
      '{"id":"a","title":"Alpha","type":"data-table","src":"data/x.json","columns":[{"key":"k","label":"K"}]},',
      '{"id":"b","title":"Beta","type":"alert","severity":"info","message":"m"}',
    ].join('')
    expect(extractGenUiSkeletons(partial)).toEqual([
      { type: 'data-table', title: 'Alpha' },
      { type: 'alert', title: 'Beta' },
    ])
  })

  it('mixed field orders: every title lands on its own component', () => {
    const partial = [
      '{"components":[',
      '{"id":"a","title":"First","type":"stat-card"},',          // title before type
      '{"id":"b","type":"progress","title":"Second"},',           // title after type
      '{"id":"c","title":"Third","type":"form","fields":[{"key":"f","label":"F"}]},', // before
      '{"id":"d","type":"chart","title":"Fourth"',                 // after, truncated tail
    ].join('')
    expect(extractGenUiSkeletons(partial)).toEqual([
      { type: 'stat-card', title: 'First' },
      { type: 'progress', title: 'Second' },
      { type: 'form', title: 'Third' },
      { type: 'chart', title: 'Fourth' },
    ])
  })

  it('a title never attaches across a component boundary (nearest of the two adjacent types wins)', () => {
    // "Late title" sits closer to the alert type than to the form type —
    // it belongs to the alert, and the form gets no title, never a borrow.
    const partial = '{"type":"form","fields":[{"key":"a"}]},{"type":"alert","title":"Late title"'
    expect(extractGenUiSkeletons(partial)).toEqual([
      { type: 'form' },
      { type: 'alert', title: 'Late title' },
    ])
  })

  it('a title before the first type belongs to that first type', () => {
    const partial = '{"title":"Leading","type":"stat-card"'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'stat-card', title: 'Leading' }])
  })

  it('keeps the first title when a malformed payload yields two titles for one type', () => {
    const partial = '{"type":"alert","title":"One","title":"Two"'
    expect(extractGenUiSkeletons(partial)).toEqual([{ type: 'alert', title: 'One' }])
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

describe('GENUI_SKELETON_COMPONENT_TYPES — registry lockstep (bidirectional)', () => {
  it('matches the GenUICard renderer registry exactly, both directions', () => {
    // Set equality: a registry renderer without a skeleton whitelist entry is
    // just as wrong as a whitelisted type without a renderer.
    expect([...GENUI_SKELETON_COMPONENT_TYPES].sort()).toEqual([...GENUI_COMPONENT_TYPES].sort())
  })

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

describe('genui.skeleton.types — i18n lockstep (N5: skeleton names a friendly type, never a raw registry key)', () => {
  // packages/ui/src/components/chat/__tests__/ → packages/shared/src/i18n/locales/
  const readLocale = (locale: string): Record<string, unknown> =>
    JSON.parse(
      readFileSync(new URL(`../../../../../shared/src/i18n/locales/${locale}.json`, import.meta.url), 'utf-8'),
    ) as Record<string, unknown>

  for (const locale of ['en', 'zh-Hans']) {
    it(`every registry type has a genui.skeleton.types key in ${locale}`, () => {
      const messages = readLocale(locale)
      for (const type of GENUI_COMPONENT_TYPES) {
        const value = messages[`genui.skeleton.types.${type}`]
        expect(typeof value).toBe('string')
        expect(value as string).not.toBe('')
        // the localized name must be a friendly label, not the raw key echoed back
        expect(value as string).not.toContain('genui.skeleton.types')
      }
    })
  }

  it('the skeleton templates interpolate the friendly name, not the type key', () => {
    const en = readLocale('en')
    expect(en['genui.skeleton.building']).toContain('{{name}}')
    expect(en['genui.skeleton.building']).not.toContain('{{type}}')
    expect(en['genui.skeleton.buildingNamed']).toContain('{{name}}')
    expect(en['genui.skeleton.buildingNamed']).toContain('{{title}}')
    const zh = readLocale('zh-Hans')
    expect(zh['genui.skeleton.building']).toContain('{{name}}')
    expect(zh['genui.skeleton.building']).not.toContain('{{type}}')
    expect(zh['genui.skeleton.buildingNamed']).toContain('{{name}}')
    expect(zh['genui.skeleton.buildingNamed']).toContain('{{title}}')
  })
})
