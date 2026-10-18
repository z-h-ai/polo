/**
 * GenUI action-buttons confirm/params schema (iter/confirm-flow): the optional
 * `confirm` gate, the optional `params` + `promptTemplate` parameterization,
 * and the button-level cross-field refine (params ⇒ send-message +
 * promptTemplate; prompt ⇔ promptTemplate exclusivity). Cross-field rules live
 * on the button's superRefine because a refine on a discriminated-union member
 * would wrap it in ZodEffects and break the union.
 */

import { describe, expect, it } from 'bun:test'
import { RenderUiSchema } from './tool-defs.ts'

function buttonComponent(buttonOverrides: Record<string, unknown> = {}, action: Record<string, unknown> = { kind: 'send-message', prompt: 'Create the replenishment order' }): Record<string, unknown> {
  return {
    type: 'action-buttons',
    id: 'replenish',
    buttons: [
      {
        id: 'create',
        label: 'Create replenish order',
        style: 'primary',
        action,
        ...buttonOverrides,
      },
    ],
  }
}

/**
 * Typed view of the first parsed button. The package's declared zod ^3 does
 * not match the hoisted zod 4 install, so `parsed.data.components[0]`
 * infers as `{}` here (same class as the pre-existing form-test errors);
 * asserting through this local view keeps the file typecheck-clean.
 */
function firstButton(parsed: { success: boolean; data?: unknown }): {
  type: string
  buttons: Array<{
    confirm?: { message: string }
    params?: Array<{ key: string; type: string; required: boolean; options?: string[] }>
    action: { kind: string; prompt?: string; promptTemplate?: string }
  }>
} {
  const component = ((parsed as { data?: { components?: unknown[] } }).data?.components ?? [])[0] as unknown
  return component as { type: string; buttons: Array<{ confirm?: { message: string }; params?: Array<{ key: string; type: string; required: boolean; options?: string[] }>; action: { kind: string; prompt?: string; promptTemplate?: string } }> }
}

describe('GenUI action-buttons schema — zero regression (legacy payloads unchanged)', () => {
  it('still accepts a plain send-message button without confirm/params', () => {
    const parsed = RenderUiSchema.safeParse({ components: [buttonComponent()] })
    expect(parsed.success).toBe(true)
    const button = firstButton(parsed).buttons[0]!
    expect(button.confirm).toBeUndefined()
    expect(button.params).toBeUndefined()
    expect(button.action.kind).toBe('send-message')
    expect(button.action.prompt).toBe('Create the replenishment order')
    expect(button.action.promptTemplate).toBeUndefined()
  })

  it('still accepts a fill-input button', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent({}, { kind: 'fill-input', text: 'Export the table as CSV' })],
    })
    expect(parsed.success).toBe(true)
  })
})

describe('GenUI action-buttons confirm gate', () => {
  it('accepts a confirm gate on a button', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent({ confirm: { message: 'Creates 3 POs totalling ¥120k — continue?' } })],
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a confirm message over 300 chars', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent({ confirm: { message: 'x'.repeat(301) } })],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('GenUI action-buttons params + promptTemplate', () => {
  const params = [
    { key: 'count', label: 'Headcount to add', type: 'number', required: true },
    { key: 'queue', label: 'Queue', type: 'select', options: ['refunds', 'chargebacks'] },
  ]

  it('accepts params with promptTemplate and applies field defaults', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params },
        { kind: 'send-message', promptTemplate: 'Add {{count}} people to the {{queue}} refund queue' },
      )],
    })
    expect(parsed.success).toBe(true)
    const button = firstButton(parsed).buttons[0]!
    expect(button.params![0]!.type).toBe('number')
    expect(button.params![1]!.type).toBe('select')
    expect(button.action.promptTemplate).toBe('Add {{count}} people to the {{queue}} refund queue')
  })

  it('defaults param type to text and required to false', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params: [{ key: 'note', label: 'Note' }] },
        { kind: 'send-message', promptTemplate: 'Note: {{note}}' },
      )],
    })
    expect(parsed.success).toBe(true)
    const param = firstButton(parsed).buttons[0]!.params![0]!
    expect(param.type).toBe('text')
    expect(param.required).toBe(false)
  })

  it('accepts promptTemplate without params (static template is harmless)', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent({}, { kind: 'send-message', promptTemplate: 'No placeholders here' })],
    })
    expect(parsed.success).toBe(true)
  })

  it('accepts confirm and params together (params form advances into the confirm bar)', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { confirm: { message: 'Creates 3 POs — continue?' }, params },
        { kind: 'send-message', promptTemplate: 'Add {{count}} people to the {{queue}} queue' },
      )],
    })
    expect(parsed.success).toBe(true)
  })

  it('enforces the max limits: 8 params, key 40, label 60, 12 options', () => {
    const tooManyParams = Array.from({ length: 9 }, (_, index) => ({ key: `k${index}`, label: `K${index}` }))
    expect(RenderUiSchema.safeParse({ components: [buttonComponent({ params: tooManyParams }, { kind: 'send-message', promptTemplate: 'x' })] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [buttonComponent({ params: [{ key: 'k'.repeat(41), label: 'K' }] }, { kind: 'send-message', promptTemplate: 'x' })] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [buttonComponent({ params: [{ key: 'k', label: 'L'.repeat(61) }] }, { kind: 'send-message', promptTemplate: 'x' })] }).success).toBe(false)
    expect(RenderUiSchema.safeParse({ components: [buttonComponent({ params: [{ key: 'k', label: 'K', type: 'select', options: Array.from({ length: 13 }, (_, i) => `o${i}`) }] }, { kind: 'send-message', promptTemplate: 'x' })] }).success).toBe(false)
  })

  it('rejects unknown param types', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params: [{ key: 'when', label: 'When', type: 'date' }] },
        { kind: 'send-message', promptTemplate: 'When: {{when}}' },
      )],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('GenUI action-buttons cross-field refine', () => {
  it('rejects params with a plain prompt (params require promptTemplate)', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params: [{ key: 'count', label: 'Count' }] },
        { kind: 'send-message', prompt: 'Add people' },
      )],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('must use a send-message action with "promptTemplate"'))).toBe(true)
    }
  })

  it('rejects params on a fill-input action', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params: [{ key: 'count', label: 'Count' }] },
        { kind: 'fill-input', text: 'Add people' },
      )],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects send-message with both prompt and promptTemplate', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent({}, { kind: 'send-message', prompt: 'a', promptTemplate: 'b' })],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('not both'))).toBe(true)
    }
  })

  it('rejects send-message with neither prompt nor promptTemplate', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent({}, { kind: 'send-message' })],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('require "prompt" or "promptTemplate"'))).toBe(true)
    }
  })

  it('rejects duplicate param keys (mirrors the form field contract)', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params: [{ key: 'count', label: 'Count' }, { key: 'count', label: 'Count again' }] },
        { kind: 'send-message', promptTemplate: '{{count}}' },
      )],
    })
    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.some(issue => issue.message.includes('Duplicate param key "count"'))).toBe(true)
    }
  })

  it('requires options on select params and rejects them on non-select params', () => {
    const missingOptions = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params: [{ key: 'queue', label: 'Queue', type: 'select' }] },
        { kind: 'send-message', promptTemplate: '{{queue}}' },
      )],
    })
    expect(missingOptions.success).toBe(false)

    const extraOptions = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { params: [{ key: 'count', label: 'Count', type: 'number', options: ['1'] }] },
        { kind: 'send-message', promptTemplate: '{{count}}' },
      )],
    })
    expect(extraOptions.success).toBe(false)
  })

  it('the confirm/params payload still respects the 4KB components cap', () => {
    const parsed = RenderUiSchema.safeParse({
      components: [buttonComponent(
        { confirm: { message: 'x'.repeat(300) }, params: Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, label: 'L'.repeat(60) })) },
        { kind: 'send-message', promptTemplate: 'x'.repeat(2000) },
      )],
    })
    // Within the cap: accepted. (The cap itself is covered by render-ui.test.ts.)
    expect(parsed.success).toBe(true)
  })
})
