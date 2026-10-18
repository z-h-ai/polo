/**
 * GenUI data-table row-level actions and drill-down (iter/row-actions):
 * pure template-fill / link-resolution helpers plus the plain-path spec
 * contract that keeps tables without row extras byte-identical to before.
 */

import { describe, it, expect } from 'bun:test'
import {
  buildGenUiDataTableSpec,
  escapeGenUiHtml,
  fillGenUiTemplate,
  isSafeGenUiHref,
  resolveGenUiCellLink,
  type GenUiDataTable,
} from '../GenUICard'

describe('fillGenUiTemplate (row action / detail template interpolation)', () => {
  it('replaces {{col.key}} placeholders with the row values', () => {
    const fill = fillGenUiTemplate('为 {{sku}} 生成补货工单', { sku: 'SKU-3311' })
    expect(fill.text).toBe('为 SKU-3311 生成补货工单')
    expect(fill.escapedText).toBe('为 SKU-3311 生成补货工单')
    expect(fill.missingKeys).toEqual([])
  })

  it('fills multiple placeholders from multiple columns', () => {
    const fill = fillGenUiTemplate('Compare {{a}} and {{b}} for {{a}}', { a: 'X', b: 'Y' })
    expect(fill.text).toBe('Compare X and Y for X')
    expect(fill.missingKeys).toEqual([])
  })

  it('tolerates whitespace inside the placeholder braces', () => {
    expect(fillGenUiTemplate('Show {{ sku }} row', { sku: 'S1' }).text).toBe('Show S1 row')
  })

  it('replaces missing values with the empty string and reports the key', () => {
    const fill = fillGenUiTemplate('为 {{sku}} 生成补货工单 (qty={{qty}})', {})
    // The placeholder becomes '' — the surrounding literal spaces stay.
    expect(fill.text).toBe('为  生成补货工单 (qty=)')
    expect(fill.escapedText).toBe('为  生成补货工单 (qty=)')
    expect(fill.missingKeys).toEqual(['sku', 'qty'])
  })

  it('treats null, undefined and empty-string values as missing', () => {
    expect(fillGenUiTemplate('{{a}}-{{b}}-{{c}}', { a: null, b: undefined, c: '' }).missingKeys)
      .toEqual(['a', 'b', 'c'])
  })

  it('HTML-escapes interpolated values in escapedText while text stays raw', () => {
    const row = { name: '<b>"AT&T"</b>', note: "it's" }
    const fill = fillGenUiTemplate('{{name}} ({{note}})', row)
    expect(fill.text).toBe('<b>"AT&T"</b> (it\'s)')
    expect(fill.escapedText).toBe('&lt;b&gt;&quot;AT&amp;T&quot;&lt;/b&gt; (it&#39;s)')
  })

  it('escapes literals outside placeholders too', () => {
    expect(fillGenUiTemplate('a & b {{x}}', { x: 'v' }).escapedText).toBe('a &amp; b v')
  })

  it('serializes non-string values via String, objects via JSON', () => {
    expect(fillGenUiTemplate('qty={{qty}}', { qty: 42 }).text).toBe('qty=42')
    expect(fillGenUiTemplate('ok={{ok}}', { ok: true }).text).toBe('ok=true')
    expect(fillGenUiTemplate('o={{o}}', { o: { k: 1 } }).text).toBe('o={"k":1}')
  })

  it('leaves a template without placeholders untouched', () => {
    const fill = fillGenUiTemplate('plain prompt', {})
    expect(fill.text).toBe('plain prompt')
    expect(fill.missingKeys).toEqual([])
  })
})

describe('escapeGenUiHtml', () => {
  it('escapes all five HTML specials', () => {
    expect(escapeGenUiHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;')
  })

  it('leaves strings without specials unchanged', () => {
    expect(escapeGenUiHtml('SKU-3311 为 例')).toBe('SKU-3311 为 例')
  })
})

describe('isSafeGenUiHref (source links must not reach the URL handler unsanitized)', () => {
  it('allows http(s) URLs', () => {
    expect(isSafeGenUiHref('https://contracts.example/clauses/3-2')).toBe(true)
    expect(isSafeGenUiHref('http://intranet.local/doc.pdf')).toBe(true)
  })

  it('rejects script and other dangerous schemes', () => {
    expect(isSafeGenUiHref('javascript:alert(1)')).toBe(false)
    expect(isSafeGenUiHref('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeGenUiHref('vbscript:msgbox')).toBe(false)
    expect(isSafeGenUiHref('file:///etc/passwd')).toBe(false)
  })

  it('rejects non-URLs', () => {
    expect(isSafeGenUiHref('3.2')).toBe(false)
    expect(isSafeGenUiHref('')).toBe(false)
  })
})

describe('resolveGenUiCellLink (href from the same-named field\'s link value or the value itself)', () => {
  it('uses a plain http(s) URL value as its own href', () => {
    expect(resolveGenUiCellLink('https://example.com/doc.pdf')).toEqual({ href: 'https://example.com/doc.pdf' })
  })

  it('reads { value, link } objects: href from link, display from value', () => {
    expect(resolveGenUiCellLink({ value: '3.2', link: 'https://example.com/clause-3-2' })).toEqual({
      href: 'https://example.com/clause-3-2',
      label: '3.2',
    })
    expect(resolveGenUiCellLink({ text: '条款 3.2', link: 'https://example.com/32' })?.label).toBe('条款 3.2')
  })

  it('returns null for non-linkable values so cells keep the default rendering', () => {
    expect(resolveGenUiCellLink('3.2')).toBeNull() // clause number, not a URL
    expect(resolveGenUiCellLink('')).toBeNull()
    expect(resolveGenUiCellLink(null)).toBeNull()
    expect(resolveGenUiCellLink(undefined)).toBeNull()
    expect(resolveGenUiCellLink(['https://example.com'])).toBeNull() // arrays never linkify
  })

  it('returns null when the object link is missing or unsafe', () => {
    expect(resolveGenUiCellLink({ value: '3.2' })).toBeNull()
    expect(resolveGenUiCellLink({ value: 'x', link: 'javascript:alert(1)' })).toBeNull()
    expect(resolveGenUiCellLink({ value: 'x', link: 42 })).toBeNull()
  })
})

describe('buildGenUiDataTableSpec (plain-path contract, zero regression)', () => {
  const base: GenUiDataTable = {
    type: 'data-table',
    id: 't1',
    title: 'SKUs',
    src: 'data/skus.json',
    columns: [{ key: 'sku', label: 'SKU' }],
  }

  it('carries exactly src/title/columns — same as the pre-row-actions payload', () => {
    expect(JSON.parse(buildGenUiDataTableSpec(base))).toEqual({
      src: 'data/skus.json',
      title: 'SKUs',
      columns: [{ key: 'sku', label: 'SKU' }],
    })
  })

  it('keeps row extras out of the spec even when present (behavior rides the render hooks)', () => {
    const spec = JSON.parse(buildGenUiDataTableSpec({
      ...base,
      rowAction: { label: '补货', promptTemplate: '为 {{sku}} 生成补货工单' },
      detailTemplate: '分析 {{sku}}',
      columns: [{ key: 'sku', label: 'SKU', link: true }],
    }))
    expect(Object.keys(spec).sort()).toEqual(['columns', 'src', 'title'])
    expect(spec.columns[0]).toEqual({ key: 'sku', label: 'SKU', link: true })
  })

  it('omits an absent title instead of serializing undefined', () => {
    const spec = JSON.parse(buildGenUiDataTableSpec({ ...base, title: undefined }))
    expect(Object.keys(spec).sort()).toEqual(['columns', 'src'])
  })
})
