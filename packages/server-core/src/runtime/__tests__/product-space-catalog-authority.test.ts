import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getProductSpaceCatalogAuthorityRecord,
  hasProductSpaceCatalogAuthorityTuple,
  loadProductSpaceCatalogAuthorityTupleSet,
  productSpaceCatalogAuthorityKey,
  productSpaceCatalogAuthorityTupleKey,
  recordProductSpaceCatalogAuthoritativeEntries,
  resetProductSpaceCatalogAuthorityForTests,
} from '../product-space-catalog-authority'

function tuple(
  catalogEntryId = 'entry-a',
  artifactInstanceId = 'artifact-a',
  versionId = 'version-1',
  version = '1.0.0',
): [string, string, string, string] {
  return [catalogEntryId, artifactInstanceId, versionId, version]
}

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
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
    expect(loadProductSpaceCatalogAuthorityTupleSet('account-a', 'space-a'))
      .toEqual(new Set([productSpaceCatalogAuthorityTupleKey(...tuple())]))
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
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple('entry-a', 'artifact-a', 'version-2', '2.0.0'))).toBe(true)
    // The OLD version's tuple is gone once the entry upgraded.
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
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
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-b', ...tuple())).toBe(false)
    expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-a', ...tuple())).toBe(false)
    expect(getProductSpaceCatalogAuthorityRecord('account-b', 'space-a')).toBeNull()
    expect(productSpaceCatalogAuthorityKey('account-a', 'space-a'))
      .toBe(JSON.stringify(['product-space-catalog', 1, 'account-a', 'space-a']))
  })

  it('rejects a syntactically-valid-but-malformed authority file and self-heals on the next fresh Catalog', () => {
    // Seed a GOOD record first, then overwrite the persisted file with
    // legal JSON whose record shapes are malformed (missing tombstones
    // array, entry missing versionId, wrong kind, non-string permission,
    // unknown availability, unknown source discriminant).
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-good', [entry()])
    const file = join(process.env.POLO_AI_CONFIG_DIR!, 'product-space-catalog-authority.json')
    writeFileSync(file, JSON.stringify({
      schemaVersion: 1,
      records: {
        [productSpaceCatalogAuthorityKey('account-a', 'space-a')]: {
          schemaVersion: 1,
          accountId: 'account-a',
          productSpaceId: 'space-a',
          syncedAt: 1,
          catalogRevision: 'rev-bad',
          entries: [{
            kind: 'app',
            catalogEntryId: 'entry-x',
            artifactInstanceId: 'artifact-x',
            // versionId missing — entry malformed.
            version: { version: '1.0.0' },
            name: 'X',
            description: '',
            availability: 'available',
            sources: [],
            permissions: ['not-a-string' as unknown as string],
          }],
          // tombstones missing entirely.
        },
        [productSpaceCatalogAuthorityKey('account-b', 'space-b')]: {
          schemaVersion: 1,
          accountId: 'account-b',
          productSpaceId: 'space-b',
          syncedAt: 1,
          catalogRevision: 'rev-bad-2',
          entries: [],
          tombstones: [{
            kind: 'skill',
            catalogEntryId: 'skill-a',
            artifactInstanceId: 'artifact-skill',
            versionId: 'v',
            version: '1',
            name: 'S',
            description: '',
            availability: 'available',
            sources: [{ kind: 'unknown-source-kind', name: 'X' }],
            permissions: [],
          }],
        },
      },
    }), 'utf8')
    resetProductSpaceCatalogAuthorityForTests()

    // Both malformed scopes are dropped on load: withdrawn management fails
    // closed for them (no trusted tuples) and no record is exposed.
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')).toBeNull()
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple('entry-x', 'artifact-x', 'v', '1.0.0'))).toBe(false)
    expect(getProductSpaceCatalogAuthorityRecord('account-b', 'space-b')).toBeNull()

    // The next verified Catalog fetch rebuilds the scope (self-healing).
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a',
      'space-a',
      'rev-healed',
      [entry()],
    )
    expect(tombstones).toEqual([])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.catalogRevision).toBe('rev-healed')
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
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
