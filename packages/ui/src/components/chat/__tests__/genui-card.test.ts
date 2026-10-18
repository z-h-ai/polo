import { describe, it, expect } from 'bun:test'
import {
  parseGenUiComponents,
  mergeGenUiComponents,
  hasGenUiRenderer,
  formatStatDelta,
  formatStatValue,
  resolveStatDeltaTone,
  interpolateGenUiTemplate,
  missingGenUiParamKeys,
  resolveGenUiActionButtonText,
  planGenUiButtonPress,
  planGenUiParamsSubmit,
  type GenUiActionButton,
} from '../GenUICard'

describe('parseGenUiComponents', () => {
  it('accepts the { components: [...] } tool-input shape', () => {
    const parsed = parseGenUiComponents({
      components: [
        { type: 'stat-card', id: 's1', label: 'Revenue', value: 42 },
        { type: 'alert', id: 'a1', severity: 'info', message: 'hi' },
      ],
    })
    expect(parsed.length).toBe(2)
    expect(parsed[0]!.type).toBe('stat-card')
    expect(parsed[1]!.type).toBe('alert')
  })

  it('accepts a bare component array', () => {
    const parsed = parseGenUiComponents([
      { type: 'progress', id: 'p1', status: 'running', label: 'Working' },
    ])
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.id).toBe('p1')
  })

  it('keeps unknown types so unknown entries render the fallback instead of being dropped', () => {
    const parsed = parseGenUiComponents({
      components: [
        { type: 'chart', id: 'c1' },
        { type: 'stat-card', id: 's1', label: 'Keep', value: 1 },
      ],
    })
    expect(parsed.length).toBe(2)
    expect(parsed[0]!.id).toBe('c1')
    expect((parsed[0] as { type?: string }).type).toBe('chart')
    expect(parsed[1]!.id).toBe('s1')
    // No registered renderer for 'chart' → GenUICard renders GenUiUnknownFallback.
    expect(hasGenUiRenderer('chart')).toBe(false)
  })

  it('drops entries without a usable id', () => {
    const parsed = parseGenUiComponents({
      components: [
        { type: 'alert', severity: 'info', message: 'no id' },
        { type: 'alert', id: '', severity: 'info', message: 'empty id' },
        { type: 'alert', id: 'ok', severity: 'info', message: 'fine' },
      ],
    })
    expect(parsed.length).toBe(1)
    expect(parsed[0]!.id).toBe('ok')
  })

  it('returns empty for garbage input', () => {
    expect(parseGenUiComponents(undefined)).toEqual([])
    expect(parseGenUiComponents(null)).toEqual([])
    expect(parseGenUiComponents('nope')).toEqual([])
    expect(parseGenUiComponents({ components: 'not-an-array' })).toEqual([])
    expect(parseGenUiComponents({ components: [null, 42, 'x'] })).toEqual([])
  })
})

describe('mergeGenUiComponents', () => {
  it('keeps first-seen order across calls', () => {
    const merged = mergeGenUiComponents([
      [
        { type: 'stat-card', id: 'b', label: 'B', value: 1 },
        { type: 'stat-card', id: 'a', label: 'A', value: 2 },
      ],
      [{ type: 'alert', id: 'c', severity: 'info', message: 'C' }],
    ])
    expect(merged.map(c => c.id)).toEqual(['b', 'a', 'c'])
  })

  it('overrides same-id components in place (update semantics)', () => {
    const merged = mergeGenUiComponents([
      [
        { type: 'stat-card', id: 's1', label: 'Old label', value: 1 },
        { type: 'alert', id: 'a1', severity: 'info', message: 'kept' },
      ],
      [{ type: 'stat-card', id: 's1', label: 'New label', value: 2 }],
    ])
    expect(merged.length).toBe(2)
    expect(merged[0]!.id).toBe('s1')
    const stat = merged[0] as { label: string; value: number }
    expect(stat.label).toBe('New label')
    expect(stat.value).toBe(2)
    expect(merged[1]!.id).toBe('a1')
  })

  it('skips empty groups', () => {
    const merged = mergeGenUiComponents([
      [],
      [{ type: 'progress', id: 'p1', status: 'success', label: 'Done' }],
      [],
    ])
    expect(merged.length).toBe(1)
    expect(merged[0]!.id).toBe('p1')
  })
})

describe('hasGenUiRenderer (fallback decision)', () => {
  it('registers all five P0 component types', () => {
    expect(hasGenUiRenderer('stat-card')).toBe(true)
    expect(hasGenUiRenderer('data-table')).toBe(true)
    expect(hasGenUiRenderer('alert')).toBe(true)
    expect(hasGenUiRenderer('progress')).toBe(true)
    expect(hasGenUiRenderer('action-buttons')).toBe(true)
  })

  it('falls back to the read-only JSON view for unknown types', () => {
    expect(hasGenUiRenderer('chart')).toBe(false)
    expect(hasGenUiRenderer('')).toBe(false)
  })
})

describe('formatStatDelta (schema delta is a decimal fraction: 0.152 = +15.2%)', () => {
  it('prefixes positive deltas with +', () => {
    expect(formatStatDelta(0.152)).toBe('+15.2%')
    expect(formatStatDelta(0.15)).toBe('+15%')
    expect(formatStatDelta(1.5)).toBe('+150%')
  })

  it('keeps negative deltas signed by the number itself', () => {
    expect(formatStatDelta(-0.034)).toBe('-3.4%')
    expect(formatStatDelta(-0.05)).toBe('-5%')
  })

  it('renders zero unsigned', () => {
    expect(formatStatDelta(0)).toBe('0%')
  })

  it('rounds to one decimal place', () => {
    expect(formatStatDelta(0.15234)).toBe('+15.2%')
    expect(formatStatDelta(-0.02689)).toBe('-2.7%')
  })
})

describe('formatStatValue (optional stat-card format hint)', () => {
  it('shows the value verbatim without a format (zero regression)', () => {
    expect(formatStatValue(0.093)).toBe('0.093')
    expect(formatStatValue(42)).toBe('42')
    expect(formatStatValue('1,234 台')).toBe('1,234 台')
  })

  it('renders percent from the schema’s decimal fraction', () => {
    expect(formatStatValue(0.093, 'percent')).toBe('9.3%')
    expect(formatStatValue(0.1, 'percent')).toBe('10%')
    expect(formatStatValue(0, 'percent')).toBe('0%')
  })

  it('adds thousands separators for number and currency', () => {
    expect(formatStatValue(1234567.891, 'number')).toBe('1,234,567.891')
    expect(formatStatValue(1234.5, 'currency', '$')).toBe('$1,234.5')
    // Multi-char currency codes get a separating space; symbols do not.
    expect(formatStatValue(1234.5, 'currency', 'CNY')).toBe('CNY 1,234.5')
    expect(formatStatValue(1234.5, 'currency')).toBe('1,234.5')
  })

  it('falls back to the raw string when the value is not numeric', () => {
    expect(formatStatValue('N/A', 'percent')).toBe('N/A')
    expect(formatStatValue('N/A', 'currency', '$')).toBe('N/A')
  })

  it('accepts numeric strings', () => {
    expect(formatStatValue('0.093', 'percent')).toBe('9.3%')
    expect(formatStatValue('1234.5', 'currency', '$')).toBe('$1,234.5')
  })
})

describe('resolveStatDeltaTone (goodWhen direction semantics)', () => {
  it('keeps rises green / falls red by default (zero regression)', () => {
    expect(resolveStatDeltaTone('up', undefined)).toBe('success')
    expect(resolveStatDeltaTone('down', undefined)).toBe('destructive')
    expect(resolveStatDeltaTone('up', 'up')).toBe('success')
    expect(resolveStatDeltaTone('down', 'up')).toBe('destructive')
  })

  it('inverts the color for goodWhen down (queue growth +45% renders red)', () => {
    expect(resolveStatDeltaTone('up', 'down')).toBe('destructive')
    expect(resolveStatDeltaTone('down', 'down')).toBe('success')
  })

  it('mutes the color for goodWhen neutral', () => {
    expect(resolveStatDeltaTone('up', 'neutral')).toBe('muted')
    expect(resolveStatDeltaTone('down', 'neutral')).toBe('muted')
  })

  it('stays muted without a trend or on flat, regardless of goodWhen', () => {
    expect(resolveStatDeltaTone(undefined, 'up')).toBe('muted')
    expect(resolveStatDeltaTone('flat', 'up')).toBe('muted')
    expect(resolveStatDeltaTone(undefined, 'down')).toBe('muted')
    expect(resolveStatDeltaTone('flat', 'down')).toBe('muted')
  })
})

// ── Confirm / params gates (iter/confirm-flow) ───────────────────────────────

const PLAIN_BUTTON: GenUiActionButton = {
  id: 'b1',
  label: 'Create order',
  style: 'primary',
  action: { kind: 'send-message', prompt: 'Create the replenishment order' },
}

describe('interpolateGenUiTemplate (params → promptTemplate)', () => {
  it('replaces every occurrence of a filled key with the trimmed value', () => {
    expect(interpolateGenUiTemplate('Add {{count}} people ({{count}} total) to {{queue}}', { count: ' 2 ', queue: 'refunds' }))
      .toBe('Add 2 people (2 total) to refunds')
  })

  it('leaves placeholders visible when their key was not filled', () => {
    expect(interpolateGenUiTemplate('Add {{count}} people to {{queue}}', { queue: 'refunds' }))
      .toBe('Add {{count}} people to refunds')
  })

  it('returns the template unchanged with no values', () => {
    expect(interpolateGenUiTemplate('Add {{count}}', {})).toBe('Add {{count}}')
  })
})

describe('missingGenUiParamKeys (required interception)', () => {
  const params = [
    { key: 'count', label: 'Count', type: 'number' as const, required: true },
    { key: 'queue', label: 'Queue', type: 'select' as const, required: true, options: ['refunds'] },
    { key: 'note', label: 'Note', type: 'text' as const },
  ]

  it('reports required keys left blank, in declaration order', () => {
    expect(missingGenUiParamKeys(params, {})).toEqual(['count', 'queue'])
    expect(missingGenUiParamKeys(params, { count: '  ', queue: 'refunds' })).toEqual(['count'])
  })

  it('reports nothing when every required key is filled', () => {
    expect(missingGenUiParamKeys(params, { count: '2', queue: 'refunds' })).toEqual([])
  })

  it('ignores optional params left blank', () => {
    expect(missingGenUiParamKeys([params[2]!], {})).toEqual([])
  })
})

describe('resolveGenUiActionButtonText (the text that gets backfilled)', () => {
  it('passes a plain prompt through unchanged (zero regression)', () => {
    expect(resolveGenUiActionButtonText(PLAIN_BUTTON.action)).toBe('Create the replenishment order')
  })

  it('passes fill-input text through unchanged', () => {
    expect(resolveGenUiActionButtonText({ kind: 'fill-input', text: 'Export as CSV' })).toBe('Export as CSV')
  })

  it('interpolates promptTemplate with the filled values', () => {
    expect(resolveGenUiActionButtonText(
      { kind: 'send-message', promptTemplate: 'Add {{count}} people to the {{queue}} queue' },
      { count: '2', queue: 'refunds' },
    )).toBe('Add 2 people to the refunds queue')
  })

  it('falls back to an empty prompt for a malformed send-message action', () => {
    expect(resolveGenUiActionButtonText({ kind: 'send-message' })).toBe('')
  })
})

describe('planGenUiButtonPress (confirm 展开: the gate sequence)', () => {
  it('executes directly when the button has no gates (zero regression)', () => {
    const press = planGenUiButtonPress(PLAIN_BUTTON)
    expect(press).toEqual({ gate: 'execute', text: 'Create the replenishment order' })
  })

  it('opens the confirm bar for a confirm button instead of executing', () => {
    const confirmButton: GenUiActionButton = {
      ...PLAIN_BUTTON,
      confirm: { message: 'Creates 3 POs totalling ¥120k — continue?' },
    }
    expect(planGenUiButtonPress(confirmButton)).toEqual({ gate: 'confirm' })
  })

  it('opens the params form first for a params button', () => {
    const paramsButton: GenUiActionButton = {
      ...PLAIN_BUTTON,
      params: [{ key: 'count', label: 'Count', type: 'number', required: true }],
      action: { kind: 'send-message', promptTemplate: 'Add {{count}} people' },
    }
    expect(planGenUiButtonPress(paramsButton)).toEqual({ gate: 'params' })
  })

  it('never plans an execute for a gated click before the gates pass (cancel = collapse, no backfill)', () => {
    const gated: GenUiActionButton = {
      ...PLAIN_BUTTON,
      confirm: { message: 'sure?' },
      params: [{ key: 'count', label: 'Count' }],
      action: { kind: 'send-message', promptTemplate: 'Add {{count}}' },
    }
    for (const values of [{}, { count: '2' }]) {
      const press = planGenUiButtonPress(gated, values)
      expect(press.gate === 'execute').toBe(false)
    }
  })
})

describe('planGenUiParamsSubmit (params 执行 → next gate)', () => {
  const paramsButton: GenUiActionButton = {
    id: 'p1',
    label: 'Add people',
    style: 'primary',
    params: [
      { key: 'count', label: 'Count', type: 'number', required: true },
      { key: 'note', label: 'Note', type: 'text' },
    ],
    action: { kind: 'send-message', promptTemplate: 'Add {{count}} people. Note: {{note}}' },
  }

  it('intercepts missing required values instead of executing', () => {
    const plan = planGenUiParamsSubmit(paramsButton, {})
    expect(plan).toEqual({ ok: false, missing: ['count'] })
  })

  it('advances to execute with the interpolated text when values are complete', () => {
    const plan = planGenUiParamsSubmit(paramsButton, { count: '2' })
    expect(plan).toEqual({ ok: true, gate: 'execute', text: 'Add 2 people. Note: {{note}}' })
  })

  it('advances to the confirm bar when the button also declares confirm', () => {
    const gated: GenUiActionButton = { ...paramsButton, confirm: { message: 'Adds headcount — continue?' } }
    expect(planGenUiParamsSubmit(gated, { count: '2' })).toEqual({ ok: true, gate: 'confirm' })
  })
})
