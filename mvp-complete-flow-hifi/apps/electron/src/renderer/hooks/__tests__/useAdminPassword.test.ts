import { describe, expect, it, mock } from 'bun:test'
import {
  createAdminPasswordSubmitter,
  validateAdminPassword,
} from '../useAdminPassword'

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

describe('createAdminPasswordSubmitter', () => {
  it('does not send a request for short or mismatched passwords', async () => {
    const request = mock(async () => ({ success: true as const }))
    const submit = createAdminPasswordSubmitter(request)

    expect(await submit('short', 'short')).toEqual({ success: false, reason: 'too_short' })
    expect(await submit('password-123', 'password-456')).toEqual({ success: false, reason: 'mismatch' })
    expect(request).not.toHaveBeenCalled()
  })

  it('submits only the password and reports success', async () => {
    const request = mock(async () => ({ success: true as const }))
    const submit = createAdminPasswordSubmitter(request)

    expect(await submit('password-123', 'password-123')).toEqual({ success: true })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith('password-123')
  })

  it('blocks duplicate submissions while the first request is pending', async () => {
    let resolveRequest!: (result: { success: true }) => void
    const request = mock(() => new Promise<{ success: true }>(resolve => {
      resolveRequest = resolve
    }))
    const submit = createAdminPasswordSubmitter(request)

    const first = submit('password-123', 'password-123')
    const duplicate = await submit('password-123', 'password-123')

    expect(duplicate).toEqual({ success: false, reason: 'busy' })
    expect(request).toHaveBeenCalledTimes(1)
    resolveRequest({ success: true })
    expect(await first).toEqual({ success: true })
  })

  it('maps session and network failures without exposing server details', async () => {
    const unauthorized = createAdminPasswordSubmitter(async () => ({
      success: false,
      errorCode: 'UNAUTHORIZED',
      message: 'internal session detail',
    }))
    expect(await unauthorized('password-123', 'password-123')).toEqual({
      success: false,
      reason: 'session_expired',
    })

    const offline = createAdminPasswordSubmitter(async () => {
      throw new Error('private network stack')
    })
    expect(await offline('password-123', 'password-123')).toEqual({
      success: false,
      reason: 'network_error',
    })
  })
})
