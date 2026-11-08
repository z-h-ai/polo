import { describe, expect, it } from 'bun:test'
import { ProductSpaceCatalogEntrySchema } from '../schemas.ts'

describe('enterprise package catalog metadata capacity', () => {
  it.each(['app', 'skill'])('preserves accepted %s display metadata without truncating conditions', (kind) => {
    const entry = { catalogEntryId: 'entry', kind, artifactInstanceId: 'instance', name: '企'.repeat(512), description: '触'.repeat(8192), availability: 'available', version: { versionId: 'version', version: '1.0.0' }, sources: [{ kind: 'enterprise_import', name: '企业' }], permissions: [], ...(kind === 'app' ? { visibility: 'space' as const } : {}), ...(kind === 'skill' ? { enabled: true } : {}) }
    expect<unknown>(ProductSpaceCatalogEntrySchema.parse(entry)).toEqual(entry)
  })
  it('still refuses an oversized description', () => {
    // POO-205 Catalog v2: built_in_app entries no longer exist; the bound is
    // asserted on a v2 app entry (visibility space).
    expect(ProductSpaceCatalogEntrySchema.safeParse({ catalogEntryId: 'entry', kind: 'app', artifactInstanceId: 'instance', name: '助手', description: 'x'.repeat(8193), availability: 'available', version: { versionId: 'version', version: '1.0.0' }, sources: [{ kind: 'enterprise_import', name: '企业' }], permissions: [], visibility: 'space' }).success).toBe(false)
  })
})
