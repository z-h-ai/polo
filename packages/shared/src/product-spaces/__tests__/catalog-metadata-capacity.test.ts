import { describe, expect, it } from 'bun:test'
import { ProductSpaceCatalogEntrySchema } from '../schemas.ts'

describe('enterprise package catalog metadata capacity', () => {
  it.each(['app', 'skill'])('preserves accepted %s display metadata without truncating conditions', (kind) => {
    const entry = { catalogEntryId: 'entry', kind, artifactInstanceId: 'instance', name: '企'.repeat(512), description: '触'.repeat(8192), availability: 'available', version: { versionId: 'version', version: '1.0.0' }, sources: [{ kind: 'enterprise_import', name: '企业' }], permissions: [], ...(kind === 'skill' ? { enabled: true } : {}) }
    expect(ProductSpaceCatalogEntrySchema.parse(entry)).toEqual(entry)
  })
  it('still refuses an oversized description', () => {
    expect(ProductSpaceCatalogEntrySchema.safeParse({ catalogEntryId: 'entry', kind: 'built_in_app', builtInAppId: 'polo_assistant', name: '助手', description: 'x'.repeat(8193), availability: 'available' }).success).toBe(false)
  })
})
