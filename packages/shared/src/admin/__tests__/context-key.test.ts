import { describe, expect, it } from 'bun:test'
import { createOrganizationContextKey } from '../context-key'

describe('createOrganizationContextKey', () => {
  it('round-trips delimiter, Unicode, NUL, and long entity IDs', () => {
    const accountId = `账号:\0${'a'.repeat(500)}`
    const organizationId = `组织:\0${'界'.repeat(250)}`
    const key = createOrganizationContextKey(accountId, organizationId)

    expect(JSON.parse(key)).toEqual([accountId, organizationId])
  })

  it('does not collide for tuples that defeat delimiter concatenation', () => {
    const left = createOrganizationContextKey('account', 'org\0suffix')
    const right = createOrganizationContextKey('account\0org', 'suffix')
    const colonLeft = createOrganizationContextKey('account:org', 'suffix')
    const colonRight = createOrganizationContextKey('account', 'org:suffix')

    expect(left).not.toBe(right)
    expect(colonLeft).not.toBe(colonRight)
  })
})
