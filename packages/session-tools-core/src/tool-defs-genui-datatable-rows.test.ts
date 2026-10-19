/**
 * GenUI data-table row-level schema (iter/row-actions): optional `rowAction`,
 * `detailTemplate`, and per-column `link`. Everything is additive-optional —
 * a payload without them must keep parsing exactly as before, and the
 * strict-mode "no inline rows" guard must stay intact.
 */

import { describe, expect, it } from 'bun:test'
import { RenderUiSchema } from './tool-defs.ts'
import { buildRenderUiSchemaForComponentTypes } from './genui-schema.ts'

function dataTableComponent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'data-table',
    id: 'skus',
    src: 'data/skus.json',
    columns: [
      { key: 'sku', label: 'SKU' },
      { key: 'qty', label: 'Qty', type: 'number' },
    ],
    ...overrides,
  }
}

describe('GenUI data-table row-level schema (iter/row-actions)', () => {
  it('still accepts a payload without the new fields (zero regression)', () => {
    const parsed = RenderUiSchema.safeParse({ components: [dataTableComponent()] })
    expect(parsed.success).toBe(true)
  })

  it('still rejects inline rows and unknown keys (strict mode unchanged)', () => {
    expect(RenderUiSchema.safeParse({ components: [dataTableComponent({ rows: [{ sku: 'S1' }] })] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [dataTableComponent({ rowActions: [] })] }).success).toBe(false)
  })

  it('accepts rowAction, detailTemplate and column link together', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTableComponent({
        rowAction: { label: '补货', promptTemplate: '为 {{sku}} 生成补货工单' },
        detailTemplate: '分析 {{sku}} 在 {{qty}} 件库存下的周转',
        columns: [
          { key: 'sku', label: 'SKU', link: true },
          { key: 'qty', label: 'Qty', type: 'number' },
        ],
      })],
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // The superRefine-wrapped array infers `{}` elements under this zod
      // version (see tool-defs-genui-form.test.ts) — assert through a cast.
      const table = parsed.data.components[0] as {
        type: string
        rowAction?: { promptTemplate: string }
        detailTemplate?: string
        columns: Array<{ link?: boolean }>
      }
      expect(table.type).toBe('data-table')
      expect(table.rowAction?.promptTemplate).toBe('为 {{sku}} 生成补货工单')
      expect(table.detailTemplate).toBe('分析 {{sku}} 在 {{qty}} 件库存下的周转')
      expect(table.columns[0]!.link).toBe(true)
    }
  })

  it('rejects a rowAction label over 20 chars', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTableComponent({ rowAction: { label: 'x'.repeat(21), promptTemplate: 'p {{sku}}' } })],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a promptTemplate over 500 chars', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTableComponent({ rowAction: { label: '补货', promptTemplate: 'x'.repeat(501) } })],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a detailTemplate over 500 chars', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTableComponent({ detailTemplate: 'x'.repeat(501) })],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a non-boolean column link', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTableComponent({ columns: [{ key: 'sku', label: 'SKU', link: 'yes' }] })],
    })
    expect(parsed.success).toBe(false)
  })

  it('keeps the rowAction shape strict (unknown keys inside rowAction fail)', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [dataTableComponent({ rowAction: { label: '补货', promptTemplate: 'p', kind: 'send-message' } })],
    })
    expect(parsed.success).toBe(false)
  })

  it('is available through the dynamic per-component schema assembly (POO-104 seam)', () => {
    const schema = buildRenderUiSchemaForComponentTypes(['data-table'])
    expect(schema).not.toBeNull()
    const parsed = schema!.safeParse({
      components: [dataTableComponent({ rowAction: { label: '补货', promptTemplate: '为 {{sku}} 生成补货工单' } })],
    })
    expect(parsed.success).toBe(true)
  })
})
