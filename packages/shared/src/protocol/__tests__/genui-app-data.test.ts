/**
 * P1-3 canvas app data channel — shared-side constants and the cross-package
 * parity guard. session-tools-core must stay a leaf (it cannot import
 * @polo-ai/shared), so the update_app_data 1MB write cap is pinned there and
 * dragged in sync here — the same discipline as the generate_app 512KB cap.
 */

import { describe, expect, it } from 'bun:test'
import { UPDATE_APP_DATA_MAX_BYTES } from '../../../../session-tools-core/src/tool-defs'
import {
  GENUI_APP_DATA_MAX_FILE_BYTES,
  GENUI_APP_DATA_MAX_FILES_PER_CARD,
  GENUI_APP_DATA_MAX_SRC_LENGTH,
  GENUI_APP_DATA_META_NAME,
  GENUI_APP_DATA_WATCH_DEBOUNCE_MS,
  GENUI_BRIDGE_CAPABILITIES_META_NAME,
  parseGenUiAppDataDeclaration,
} from '../dto'

describe('GENUI app data channel constants (P1-3)', () => {
  it('mirrors the payloadSrc 1MB confinement and the update_app_data write cap', () => {
    expect(GENUI_APP_DATA_MAX_FILE_BYTES).toBe(GENUI_APP_DATA_MAX_FILE_BYTES)
    expect(GENUI_APP_DATA_MAX_FILE_BYTES).toBe(1024 * 1024)
    expect(UPDATE_APP_DATA_MAX_BYTES).toBe(GENUI_APP_DATA_MAX_FILE_BYTES)
  })

  it('keeps the model-side declaration bounds', () => {
    expect(GENUI_APP_DATA_META_NAME).toBe('polo-app-data')
    expect(GENUI_APP_DATA_MAX_FILES_PER_CARD).toBe(3)
    expect(GENUI_APP_DATA_MAX_SRC_LENGTH).toBe(1024)
  })

  it('debounces the P2-1 auto-refresh by at least one second', () => {
    expect(GENUI_APP_DATA_WATCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(1000)
  })

  it('the meta name stays distinct from the capabilities meta', () => {
    expect(GENUI_APP_DATA_META_NAME).not.toBe(GENUI_BRIDGE_CAPABILITIES_META_NAME)
  })
})

describe('parseGenUiAppDataDeclaration', () => {
  it('parses whitespace/comma separated declarations', () => {
    expect(parseGenUiAppDataDeclaration('state.json')).toEqual(['state.json'])
    expect(parseGenUiAppDataDeclaration('state.json,rows.json settings.json')).toEqual([
      'state.json',
      'rows.json',
      'settings.json',
    ])
  })

  it('dedupes while preserving first-seen order', () => {
    expect(parseGenUiAppDataDeclaration('b.json a.json b.json')).toEqual(['b.json', 'a.json'])
  })

  it('caps the declaration count per card (fail closed)', () => {
    expect(parseGenUiAppDataDeclaration('1.json 2.json 3.json 4.json')).toHaveLength(3)
  })

  it('voids the whole declaration on NUL (fail closed, never split)', () => {
    expect(parseGenUiAppDataDeclaration('ok.json\0evil.json')).toEqual([])
  })

  it('drops over-length tokens and empty content', () => {
    expect(parseGenUiAppDataDeclaration(`${'x'.repeat(2000)}.json ok.json`)).toEqual(['ok.json'])
    expect(parseGenUiAppDataDeclaration('   ')).toEqual([])
    expect(parseGenUiAppDataDeclaration('')).toEqual([])
  })
})
