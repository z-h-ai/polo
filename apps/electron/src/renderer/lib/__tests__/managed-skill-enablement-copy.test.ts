import { describe, expect, it } from 'bun:test'
import {
  MANAGED_ENABLEMENT_FALLBACK_ERROR_KEY,
  managedEnablementErrorCode,
  managedEnablementErrorKey,
} from '../managed-skill-enablement-copy'
import { MANAGED_SKILL_ENABLEMENT_ERROR_CODES } from '@polo-ai/shared/skills'

describe('managedEnablementErrorKey', () => {
  it('maps every declared enablement error code away from the raw string (M3)', () => {
    for (const code of MANAGED_SKILL_ENABLEMENT_ERROR_CODES) {
      const key = managedEnablementErrorKey(code)
      expect(key).toMatch(/^skillsList\.enableFailedReason\./)
      expect(key).not.toContain(code)
    }
  })

  it('gives each refusal its own message key', () => {
    expect(managedEnablementErrorKey('revision_conflict')).toBe('skillsList.enableFailedReason.revisionConflict')
    expect(managedEnablementErrorKey('OFFLINE_READ_ONLY')).toBe('skillsList.enableFailedReason.offlineReadOnly')
    expect(managedEnablementErrorKey('bundled_skill_not_disableable')).toBe('skillsList.enableFailedReason.bundledSkill')
    expect(managedEnablementErrorKey('managed_skill_not_toggleable')).toBe('skillsList.enableFailedReason.managedSkill')
    expect(managedEnablementErrorKey('shadowed_builtin_not_toggleable')).toBe('skillsList.enableFailedReason.shadowedBuiltin')
    expect(managedEnablementErrorKey('skill_not_found')).toBe('skillsList.enableFailedReason.skillNotFound')
    expect(managedEnablementErrorKey('workspace_context_mismatch')).toBe('skillsList.enableFailedReason.workspaceContext')
  })

  it('falls back to the generic key for unknown codes', () => {
    expect(managedEnablementErrorKey('something_new')).toBe(MANAGED_ENABLEMENT_FALLBACK_ERROR_KEY)
    expect(managedEnablementErrorKey('')).toBe(MANAGED_ENABLEMENT_FALLBACK_ERROR_KEY)
  })
})

describe('managedEnablementErrorCode', () => {
  it('extracts the code the hook rethrows', () => {
    expect(managedEnablementErrorCode(new Error('revision_conflict'))).toBe('revision_conflict')
    expect(managedEnablementErrorCode('OFFLINE_READ_ONLY')).toBe('OFFLINE_READ_ONLY')
  })
})
