import { describe, expect, it } from 'bun:test'
import { isErrorCode } from '../types'
import {
  SESSION_PROJECT_ERROR_CODES,
  SESSION_PROJECT_ERROR_MESSAGES,
  type SessionProjectErrorCode,
} from '../session-project'
import zhHans from '../../i18n/locales/zh-Hans.json'
import en from '../../i18n/locales/en.json'

/**
 * POO-205 C6: the session project-binding refusal codes ride the SAME
 * transport whitelist as the C1 project codes — a member missing from
 * KNOWN_ERROR_CODES is silently rewritten to HANDLER_ERROR on the wire and
 * the renderer's per-code recovery copy never branches.
 */
describe('session project error codes (POO-205 C6)', () => {
  it('every session project code is a known transport code', () => {
    for (const code of SESSION_PROJECT_ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true)
    }
  })

  it('codes outside the set stay unknown', () => {
    expect(isErrorCode('BRANCH_PROJECT_MISMATCH')).toBe(true)
    expect(isErrorCode('TOTALLY_MADE_UP')).toBe(false)
  })

  it('every code has canonical zh-Hans copy for gateway replies and automation records', () => {
    for (const code of SESSION_PROJECT_ERROR_CODES) {
      expect(typeof SESSION_PROJECT_ERROR_MESSAGES[code as SessionProjectErrorCode]).toBe('string')
      expect((SESSION_PROJECT_ERROR_MESSAGES[code as SessionProjectErrorCode] ?? '').length).toBeGreaterThan(0)
    }
  })

  it('the renderer locale copy agrees with the canonical messages per key', () => {
    // zh-Hans is the canonical surface (server messages + default locale).
    expect(zhHans['errors.projectContextRequired']).toBe(SESSION_PROJECT_ERROR_MESSAGES.PROJECT_CONTEXT_REQUIRED)
    expect(zhHans['errors.branchProjectMismatch']).toBe(SESSION_PROJECT_ERROR_MESSAGES.BRANCH_PROJECT_MISMATCH)
    expect(zhHans['errors.projectBindingRejectedInPersonalSpace'])
      .toBe(SESSION_PROJECT_ERROR_MESSAGES.PROJECT_BINDING_REJECTED_IN_PERSONAL_SPACE)
    // Every locale must at least carry all three keys plus the popover tooltip.
    for (const locale of [zhHans, en] as Array<Record<string, unknown>>) {
      expect(typeof locale['errors.projectContextRequired']).toBe('string')
      expect(typeof locale['errors.branchProjectMismatch']).toBe('string')
      expect(typeof locale['errors.projectBindingRejectedInPersonalSpace']).toBe('string')
      expect(typeof locale['editPopover.enterpriseUnsupported']).toBe('string')
    }
  })
})
