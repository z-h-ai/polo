import { afterEach, describe, expect, it } from 'bun:test'
import {
  denyAppCatalogAccessForAccount,
  getAppCatalogAccessMode,
  isAppCatalogAccessDeniedForAccount,
  resetAppCatalogAccessModesForTests,
  resumeAppCatalogAccessForAccount,
  setAppCatalogAccessMode,
} from '../app-catalog-access.ts'

describe('app catalog account access gate', () => {
  afterEach(() => {
    resetAppCatalogAccessModesForTests()
  })

  it('denies unseen cold-cache scopes until a trusted login resumes the account', () => {
    expect(getAppCatalogAccessMode('account-a', 'organization-a')).toBe(
      'offline',
    )

    denyAppCatalogAccessForAccount('account-a')
    setAppCatalogAccessMode('account-a', 'organization-a', 'online')

    expect(isAppCatalogAccessDeniedForAccount('account-a')).toBe(true)
    expect(isAppCatalogAccessDeniedForAccount('account-b')).toBe(false)
    expect(getAppCatalogAccessMode('account-a', 'organization-a')).toBe(
      'denied',
    )
    expect(getAppCatalogAccessMode('account-a', 'organization-b')).toBe(
      'denied',
    )
    expect(getAppCatalogAccessMode('account-b', 'organization-a')).toBe(
      'offline',
    )

    resumeAppCatalogAccessForAccount('account-a')

    expect(isAppCatalogAccessDeniedForAccount('account-a')).toBe(false)
    expect(getAppCatalogAccessMode('account-a', 'organization-a')).toBe(
      'online',
    )
    expect(getAppCatalogAccessMode('account-a', 'organization-b')).toBe(
      'offline',
    )
  })

  it('isolates delimiter-colliding account and organization tuples', () => {
    const first = ['account', 'organization\0suffix'] as const
    const second = ['account\0organization', 'suffix'] as const
    const unicode = ['账号:一', `组织:${'界'.repeat(500)}`] as const

    setAppCatalogAccessMode(...first, 'online')
    setAppCatalogAccessMode(...second, 'offline')
    setAppCatalogAccessMode(...unicode, 'online')
    denyAppCatalogAccessForAccount(first[0])

    expect(getAppCatalogAccessMode(...first)).toBe('denied')
    expect(getAppCatalogAccessMode(...second)).toBe('offline')
    expect(getAppCatalogAccessMode(...unicode)).toBe('online')
  })
})
