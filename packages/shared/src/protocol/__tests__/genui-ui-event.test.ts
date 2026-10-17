/**
 * POO-103 protocol helpers: modelContext truncation, bridge-capability
 * parsing, and the ui-event id/type validators.
 */

import { describe, expect, it } from 'bun:test'
import {
  GENUI_MODEL_CONTEXT_MAX_BYTES,
  isValidGenUiUiCardId,
  isValidGenUiUiEventType,
  parseGenUiBridgeCapabilities,
  truncateGenUiModelContext,
} from '../dto'

describe('truncateGenUiModelContext', () => {
  it('returns short contexts untouched', () => {
    const result = truncateGenUiModelContext('订单 #123 状态已更新')
    expect(result).toEqual({ text: '订单 #123 状态已更新', truncated: false })
  })

  it('truncates multi-byte content to the byte cap without splitting a code point', () => {
    // Every CJK char is 3 UTF-8 bytes: 1000 chars = 3000 bytes > 2048.
    const context = '订'.repeat(1000)
    const result = truncateGenUiModelContext(context)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(GENUI_MODEL_CONTEXT_MAX_BYTES)
    // The cut must land on a char boundary: re-encoding round-trips.
    expect(Buffer.from(result.text, 'utf8').toString('utf8')).toBe(result.text)
    expect(result.text.length).toBe(Math.floor(GENUI_MODEL_CONTEXT_MAX_BYTES / 3))
  })

  it('truncates exactly at the cap without flagging', () => {
    const context = 'a'.repeat(GENUI_MODEL_CONTEXT_MAX_BYTES)
    const result = truncateGenUiModelContext(context)
    expect(result.truncated).toBe(false)
    expect(result.text).toBe(context)
  })

  it('never produces a lone trailing surrogate', () => {
    // Emoji are 4-byte surrogate pairs; a naive byte cut splits them.
    const context = '🙂'.repeat(600) // 2400 bytes
    const result = truncateGenUiModelContext(context)
    expect(result.truncated).toBe(true)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(GENUI_MODEL_CONTEXT_MAX_BYTES)
    // Every remaining char is a full pair: length is even, no lone surrogates.
    expect(result.text.length % 2).toBe(0)
    for (const char of result.text) {
      expect(char.codePointAt(0)).toBe(0x1f642)
    }
  })
})

describe('parseGenUiBridgeCapabilities', () => {
  it('parses comma/space separated declarations', () => {
    expect(parseGenUiBridgeCapabilities('ui-event')).toEqual(['ui-event'])
    expect(parseGenUiBridgeCapabilities('ui-event, other-capability  ui-event')).toEqual(['ui-event'])
  })

  it('drops unknown capabilities (fail closed)', () => {
    expect(parseGenUiBridgeCapabilities('run-tool, filesystem, ui-event')).toEqual(['ui-event'])
  })

  it('returns empty for absent or empty content', () => {
    expect(parseGenUiBridgeCapabilities(undefined)).toEqual([])
    expect(parseGenUiBridgeCapabilities(null)).toEqual([])
    expect(parseGenUiBridgeCapabilities('')).toEqual([])
    expect(parseGenUiBridgeCapabilities('   ')).toEqual([])
  })
})

describe('ui-event validators', () => {
  it('accepts well-formed card ids and rejects the rest', () => {
    expect(isValidGenUiUiCardId('app-abc123-a1b2c3d4')).toBe(true)
    expect(isValidGenUiUiCardId('app_1.v2')).toBe(true)
    expect(isValidGenUiUiCardId('')).toBe(false)
    expect(isValidGenUiUiCardId('-leading-dash')).toBe(false)
    expect(isValidGenUiUiCardId('has space')).toBe(false)
    expect(isValidGenUiUiCardId(`${'a'.repeat(129)}`)).toBe(false)
    expect(isValidGenUiUiCardId(42)).toBe(false)
  })

  it('accepts only the whitelisted event types', () => {
    expect(isValidGenUiUiEventType('button-click')).toBe(true)
    expect(isValidGenUiUiEventType('value-change')).toBe(true)
    expect(isValidGenUiUiEventType('submit')).toBe(true)
    expect(isValidGenUiUiEventType('run-tool')).toBe(false)
    expect(isValidGenUiUiEventType('')).toBe(false)
  })
})
