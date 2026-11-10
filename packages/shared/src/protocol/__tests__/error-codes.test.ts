import { describe, expect, it } from 'bun:test'
import { isErrorCode } from '../types'

/**
 * POO-205: the project & my-apps wire codes (poo205-contract-r1) must be
 * members of KNOWN_ERROR_CODES — the transport preserves only codes it
 * knows, so a missing prj_* member is silently rewritten to HANDLER_ERROR
 * on the wire and the renderer's per-code recovery copy never branches.
 */
describe('isErrorCode (transport whitelist)', () => {
  it('recognizes the project contract prj_* codes', () => {
    expect(isErrorCode('prj_last_owner')).toBe(true)
    expect(isErrorCode('prj_not_found')).toBe(true)
  })
})
