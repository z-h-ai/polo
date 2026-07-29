import { describe, expect, it } from 'bun:test'
import { validateAdminPassword } from '../useAdminPassword'

describe('validateAdminPassword', () => {
  it('rejects passwords shorter than eight characters', () => {
    expect(validateAdminPassword('short', 'short')).toBe('too_short')
  })

  it('rejects mismatched confirmation without submitting', () => {
    expect(validateAdminPassword('password-123', 'password-456')).toBe('mismatch')
  })

  it('accepts matching passwords with at least eight characters', () => {
    expect(validateAdminPassword('password-123', 'password-123')).toBeNull()
  })
})
