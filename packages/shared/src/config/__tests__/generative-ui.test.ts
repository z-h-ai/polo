import { beforeEach, describe, expect, it, mock } from 'bun:test'

// The local level reads the user Settings kill switch from disk-backed config;
// substitute a controllable value so the two-level intersection can be tested
// without touching the real config store.
let localInlineEnabled = true
mock.module('../storage.ts', () => ({
  getGenerativeUiInlineEnabled: () => localInlineEnabled,
}))

import {
  GenerativeUiCapabilitySchema,
  isGenerativeUiInlineEnabled,
  isGenerativeUiRemoteInlineDisabled,
  setGenerativeUiRemoteCapability,
} from '../generative-ui.ts'

beforeEach(() => {
  localInlineEnabled = true
  setGenerativeUiRemoteCapability(undefined)
})

describe('isGenerativeUiRemoteInlineDisabled (remote level)', () => {
  it('is enabled when no capability was ever received (absent = enabled)', () => {
    setGenerativeUiRemoteCapability(undefined)
    expect(isGenerativeUiRemoteInlineDisabled()).toBe(false)
  })

  it('is enabled when the generativeUI section is absent (pre-flag servers)', () => {
    setGenerativeUiRemoteCapability({})
    expect(isGenerativeUiRemoteInlineDisabled()).toBe(false)
  })

  it('is enabled when the inline field is absent', () => {
    setGenerativeUiRemoteCapability({ generativeUI: {} })
    expect(isGenerativeUiRemoteInlineDisabled()).toBe(false)
  })

  it('is disabled only by an explicit inline: false', () => {
    setGenerativeUiRemoteCapability({ generativeUI: { inline: false } })
    expect(isGenerativeUiRemoteInlineDisabled()).toBe(true)
  })

  it('re-enables when a later capability drops the flag', () => {
    setGenerativeUiRemoteCapability({ generativeUI: { inline: false } })
    expect(isGenerativeUiRemoteInlineDisabled()).toBe(true)
    setGenerativeUiRemoteCapability({ generativeUI: { inline: true } })
    expect(isGenerativeUiRemoteInlineDisabled()).toBe(false)
  })
})

describe('isGenerativeUiInlineEnabled (remote AND local intersection)', () => {
  it('is enabled when the remote flag is absent and the local switch is on', () => {
    setGenerativeUiRemoteCapability(undefined)
    localInlineEnabled = true
    expect(isGenerativeUiInlineEnabled()).toBe(true)
  })

  it('is disabled when the remote flag is explicitly false even though local is on', () => {
    setGenerativeUiRemoteCapability({ generativeUI: { inline: false } })
    localInlineEnabled = true
    expect(isGenerativeUiInlineEnabled()).toBe(false)
  })

  it('is disabled when the local kill switch is off even though the remote flag is absent', () => {
    setGenerativeUiRemoteCapability(undefined)
    localInlineEnabled = false
    expect(isGenerativeUiInlineEnabled()).toBe(false)
  })

  it('is disabled when either level is off', () => {
    setGenerativeUiRemoteCapability({ generativeUI: { inline: false } })
    localInlineEnabled = false
    expect(isGenerativeUiInlineEnabled()).toBe(false)
  })
})

describe('GenerativeUiCapabilitySchema (tolerant parse of /api/capabilities)', () => {
  it('accepts a payload without the generativeUI section', () => {
    const result = GenerativeUiCapabilitySchema.safeParse({ creatorSkillArtifacts: {} })
    expect(result.success).toBe(true)
  })

  it('accepts a payload with inline present or absent', () => {
    expect(GenerativeUiCapabilitySchema.safeParse({ generativeUI: { inline: false } }).success).toBe(true)
    expect(GenerativeUiCapabilitySchema.safeParse({ generativeUI: {} }).success).toBe(true)
  })

  it('strips unknown sections so they never reach the toggle cache', () => {
    const result = GenerativeUiCapabilitySchema.safeParse({
      generativeUI: { inline: false },
      unknownSection: { later: true },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ generativeUI: { inline: false } })
    }
  })
})
