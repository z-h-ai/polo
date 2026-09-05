import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProductSpaceCatalogAuthorityRecord,
  hasProductSpaceCatalogAuthorityArtifact,
  hasProductSpaceCatalogAuthorityBinding,
  productSpaceCatalogAuthorityKey,
  recordProductSpaceCatalogAuthoritativeEntries,
  resetProductSpaceCatalogAuthorityForTests,
} from '../product-space-catalog-authority'

process.env.POLO_AI_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'polo-catalog-authority-'))

function entry(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'app',
    catalogEntryId: 'entry-a',
    artifactInstanceId: 'artifact-a',
    version: { versionId: 'version-1', version: '1.0.0', checksum: 'a'.repeat(64) },
    name: 'App A',
    description: 'demo',
    availability: 'available',
    sources: [{ kind: 'enterprise_import', name: 'Studio A' }],
    permissions: ['camera'],
    ...overrides,
  }
}

beforeEach(() => {
  resetProductSpaceCatalogAuthorityForTests()
})

describe('ProductSpace Catalog authority', () => {
  it('records a verified Catalog stripped of delivery credentials', () => {
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a',
      'space-a',
      'rev-1',
      [entry()],
    )
    expect(tombstones).toEqual([])
    const record = getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!
    expect(record.catalogRevision).toBe('rev-1')
    expect(record.entries).toHaveLength(1)
    expect(record.entries[0]).toMatchObject({
      catalogEntryId: 'entry-a',
      artifactInstanceId: 'artifact-a',
      versionId: 'version-1',
      version: '1.0.0',
      sources: [{ kind: 'enterprise_import', name: 'Studio A' }],
      permissions: ['camera'],
    })
    // Credential stripping: no checksum (delivery-adjacent) survives.
    expect(JSON.stringify(record.entries[0])).not.toContain('checksum')
    expect(JSON.stringify(record)).not.toContain('downloadUrl')
    expect(hasProductSpaceCatalogAuthorityBinding('account-a', 'space-a', 'entry-a', 'artifact-a')).toBe(true)
    expect(hasProductSpaceCatalogAuthorityArtifact('account-a', 'space-a', 'artifact-a')).toBe(true)
  })

  it('emits tombstones only when a stable identity disappears — never on version upgrades', () => {
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-1', [entry()])
    // Version upgrade: same catalogEntryId + artifactInstanceId, new version.
    const upgraded = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a',
      'space-a',
      'rev-2',
      [entry({ version: { versionId: 'version-2', version: '2.0.0' } })],
    )
    expect(upgraded).toEqual([])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.tombstones).toEqual([])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.entries[0]!.version).toBe('2.0.0')

    // Full disappearance: the last verified identity becomes a tombstone.
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a',
      'space-a',
      'rev-3',
      [],
    )
    expect(tombstones).toHaveLength(1)
    expect(tombstones[0]).toMatchObject({
      catalogEntryId: 'entry-a',
      artifactInstanceId: 'artifact-a',
      version: '2.0.0',
      availability: 'withdrawn',
    })
    expect(hasProductSpaceCatalogAuthorityBinding('account-a', 'space-a', 'entry-a', 'artifact-a')).toBe(true)
  })

  it('clears a tombstone when the identity re-appears', () => {
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-1', [entry()])
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-2', [])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.tombstones).toHaveLength(1)
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-3', [entry()])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.tombstones).toEqual([])
  })

  it('never shares records or bindings across accounts or ProductSpaces', () => {
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-1', [entry()])
    expect(hasProductSpaceCatalogAuthorityBinding('account-a', 'space-b', 'entry-a', 'artifact-a')).toBe(false)
    expect(hasProductSpaceCatalogAuthorityBinding('account-b', 'space-a', 'entry-a', 'artifact-a')).toBe(false)
    expect(hasProductSpaceCatalogAuthorityArtifact('account-a', 'space-b', 'artifact-a')).toBe(false)
    expect(getProductSpaceCatalogAuthorityRecord('account-b', 'space-a')).toBeNull()
    expect(productSpaceCatalogAuthorityKey('account-a', 'space-a'))
      .toBe(JSON.stringify(['product-space-catalog', 1, 'account-a', 'space-a']))
  })

  it('rejects malformed entries instead of recording them', () => {
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a',
      'space-a',
      'rev-1',
      [
        { kind: 'skill', catalogEntryId: 'skill-a' },
        { kind: 'app', catalogEntryId: 'no-artifact' },
        entry(),
      ],
    )
    expect(tombstones).toEqual([])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.entries).toHaveLength(1)
  })
})
