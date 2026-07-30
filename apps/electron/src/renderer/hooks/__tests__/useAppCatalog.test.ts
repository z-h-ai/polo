import { describe, expect, it } from 'bun:test'
import { isNewerCatalogVersion } from '../useAppCatalog'

describe('organization app catalog version comparison', () => {
  it('only marks higher semantic versions as updates', () => {
    expect(isNewerCatalogVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerCatalogVersion('1.10.0', '1.9.9')).toBe(true)
    expect(isNewerCatalogVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerCatalogVersion('1.0.0', '2.0.0')).toBe(false)
  })

  it('supports a leading v and does not guess for opaque versions', () => {
    expect(isNewerCatalogVersion('v2.0.0', '1.0.0')).toBe(true)
    expect(isNewerCatalogVersion('release-b', 'release-a')).toBe(false)
    expect(isNewerCatalogVersion('release-a', 'release-a')).toBe(false)
  })
})
