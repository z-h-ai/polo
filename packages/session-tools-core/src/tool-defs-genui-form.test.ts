/**
 * GenUI form component schema (POO-103): the `form` render_ui component type.
 * Cross-field rules (unique keys, select⇔options) live on the components
 * array superRefine, so they are exercised through RenderUiSchema.
 */

import { describe, expect, it } from 'bun:test'
import { RenderUiSchema } from './tool-defs.ts'

function formComponent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'form',
    id: 'contact-form',
    fields: [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'size', label: 'Size', type: 'select', options: ['S', 'M', 'L'] },
    ],
    ...overrides,
  }
}

describe('GenUI form schema (POO-103)', () => {
  it('accepts a well-formed form component', () => {
    const parsed = RenderUiSchema.safeParse({ components: [formComponent()] })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      const form = parsed.data.components[0]!
      expect(form.type).toBe('form')
      if (form.type === 'form') {
        // Default field type applies.
        expect(form.fields[0]!.type).toBe('text')
      }
    }
  })

  it('rejects more than 12 fields', () => {
    const fields = Array.from({ length: 13 }, (_, index) => ({ key: `f${index}`, label: `F${index}` }))
    const parsed = RenderUiSchema.safeParse({ components: [formComponent({ fields })] })
    expect(parsed.success).toBe(false)
  })

  it('rejects duplicate field keys', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [formComponent({
        fields: [
          { key: 'a', label: 'A' },
          { key: 'a', label: 'A again' },
        ],
      })],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('Duplicate field key "a"'))).toBe(true)
    }
  })

  it('requires options on select fields', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [formComponent({
        fields: [{ key: 'size', label: 'Size', type: 'select' }],
      })],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('requires at least one option'))).toBe(true)
    }
  })

  it('rejects options on non-select fields', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [formComponent({
        fields: [{ key: 'name', label: 'Name', type: 'text', options: ['x'] }],
      })],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('options are only valid on select fields'))).toBe(true)
    }
  })

  it('rejects unknown keys — an "action" attempt fails closed (submit is fixed send-message)', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [formComponent({ action: { kind: 'run-tool', tool: 'bash' } })],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects unknown field types', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [formComponent({
        fields: [{ key: 'a', label: 'A', type: 'textarea' }],
      })],
    })
    expect(parsed.success).toBe(false)
  })

  it('still rejects the other component types unchanged (sanity)', () => {
    expect(RenderUiSchema.safeParse({ components: [{ type: 'stat-card', id: 's', label: 'L', value: 1 }] }).success).toBe(true)
    expect(RenderUiSchema.safeParse({ components: [{ type: 'no-such-type', id: 'x' }] }).success).toBe(false)
  })
})
