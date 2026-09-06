import { beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __dropAuthorityProcessCacheForTests,
  getProductSpaceCatalogAuthorityRecord,
  hasProductSpaceCatalogAuthorityTuple,
  loadProductSpaceCatalogAuthorityTupleSet,
  productSpaceCatalogAuthorityKey,
  productSpaceCatalogAuthorityTupleKey,
  recordProductSpaceCatalogAuthoritativeEntries,
  resetProductSpaceCatalogAuthorityForTests,
  revokeProductSpaceCatalogAuthority,
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

  it('drops records persisted under a foreign or __proto__-shaped key and self-heals', () => {
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-key-a', [entry()])
    recordProductSpaceCatalogAuthoritativeEntries('account-b', 'space-b', 'rev-key-b', [entry()])

    // Tamper: move account-b/space-b's record under account-a/space-a's key,
    // and add a `__proto__`-shaped key.
    const file = join(process.env.POLO_AI_CONFIG_DIR!, 'product-space-catalog-authority.json')
    const bRecord = JSON.parse(JSON.stringify(getProductSpaceCatalogAuthorityRecord('account-b', 'space-b')))
    resetProductSpaceCatalogAuthorityForTests()
    // Tamper: move account-b/space-b's record under account-a/space-a's key,
    // and add a `__proto__`-shaped key (the prototype assignment never
    // becomes an own property, mirroring real tamper attempts).
    const parsed: {
      schemaVersion: number
      records: Record<string, unknown>
    } = {
      schemaVersion: 1,
      records: {},
    }
    parsed.records[productSpaceCatalogAuthorityKey('account-a', 'space-a')] = bRecord
    parsed.records[productSpaceCatalogAuthorityKey('account-b', 'space-b')] = bRecord
    parsed.records['__proto__'] = bRecord
    writeFileSync(file, JSON.stringify(parsed), 'utf8')

    // A's scope must NOT borrow B's tuples from the mis-keyed record...
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')).toBeNull()
    // ...while B's own correctly-keyed record still loads.
    expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', ...tuple())).toBe(true)

    // Self-heal: the next verified Catalog rebuilds A's scope.
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-healed', [entry()])
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
  })

  it('drops over-cap persisted records and self-heals', () => {
    // Legal-JSON record exceeding the persisted tombstone cap.
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-cap', [entry()])
    const file = join(process.env.POLO_AI_CONFIG_DIR!, 'product-space-catalog-authority.json')
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const key = productSpaceCatalogAuthorityKey('account-a', 'space-a')
    const ghostTombstones = Array.from({ length: 10_001 }, (_, index) => ({
      kind: 'app',
      catalogEntryId: `ghost-${index}`,
      artifactInstanceId: `ghost-artifact-${index}`,
      versionId: `ghost-version-${index}`,
      version: '1.0.0',
      name: `Ghost ${index}`,
      description: '',
      availability: 'withdrawn',
      sources: [{ kind: 'enterprise_import', name: 'G' }],
      permissions: [],
      withdrawnAt: 1,
    }))
    parsed.records[key].tombstones = ghostTombstones
    writeFileSync(file, JSON.stringify(parsed), 'utf8')
    resetProductSpaceCatalogAuthorityForTests()

    // The over-cap record is dropped on load...
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')).toBeNull()
    // ...and the next verified Catalog rebuilds the scope.
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-cap-healed', [entry()])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.catalogRevision).toBe('rev-cap-healed')
  })

  it('rejects source-discriminant and blank/length contract violations from persisted records', () => {
    const badEntries = [
      // creator_circle without circleId.
      entry({ sources: [{ kind: 'creator_circle', name: 'Circle' }] }),
      // polo with an arbitrary name.
      entry({ sources: [{ kind: 'polo', name: 'Not Polo' }] }),
      // polo with a circleId.
      entry({ sources: [{ kind: 'polo', name: 'Polo', circleId: 'c1' }] }),
      // enterprise_import with a circleId.
      entry({ sources: [{ kind: 'enterprise_import', name: 'Org', circleId: 'c1' }] }),
      // unknown source kind.
      entry({ sources: [{ kind: 'unknown-source-kind', name: 'X' }] }),
      // empty sources.
      entry({ sources: [] }),
      // blank name.
      entry({ name: '   ' }),
      // over-long name.
      entry({ name: 'x'.repeat(257) }),
      // non-string permission member.
      entry({ permissions: [42 as unknown as string] }),
      // unknown availability.
      entry({ availability: 'sort-of-available' }),
      // non-string description.
      entry({ description: 42 as unknown as string }),
    ]
    for (const [index, badEntry] of badEntries.entries()) {
      recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', `rev-bad-${index}`, [badEntry])
      resetProductSpaceCatalogAuthorityForTests()
      expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')).toBeNull()
    }

    // Self-heal: a good record persists normally afterwards.
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-healed-2', [entry()])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.catalogRevision).toBe('rev-healed-2')
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

  describe('durable revocation', () => {
    const authorityFile = (): string => join(process.env.POLO_AI_CONFIG_DIR!, 'product-space-catalog-authority.json')

    function seedScopes(): void {
      recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-1', [entry()])
      recordProductSpaceCatalogAuthoritativeEntries('account-b', 'space-b', 'rev-1', [
        entry({ catalogEntryId: 'entry-b', artifactInstanceId: 'artifact-b' }),
      ])
    }

    it('persists the revocation as a durable denied record: restart loads it fail-closed', () => {
      seedScopes()
      revokeProductSpaceCatalogAuthority('account-a', 'space-a')
      // Memory is revoked...
      expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')).toBeNull()
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      // ...and the DISK holds an explicit denied record for exactly this scope.
      const onDisk = JSON.parse(readFileSync(authorityFile(), 'utf8'))
      const deniedRecord = onDisk.records[productSpaceCatalogAuthorityKey('account-a', 'space-a')]
      expect(deniedRecord.kind).toBe('denied')
      expect(deniedRecord.accountId).toBe('account-a')
      expect(deniedRecord.productSpaceId).toBe('space-a')
      // Other scopes are untouched in memory and on disk.
      expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')).toBe(true)
      expect(Object.keys(onDisk.records)).toContain(productSpaceCatalogAuthorityKey('account-b', 'space-b'))
      // A restart reloads the denied record and stays fail-closed for the
      // scope while the other scope keeps working.
      __dropAuthorityProcessCacheForTests()
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')).toBe(true)
    })

    it('a WRITE fault propagates and leaves NO trustworthy authority file across restarts', () => {
      seedScopes()
      // writeFileSync fault: the temp target exists as a DIRECTORY.
      const tmpPath = `${authorityFile()}.${process.pid}.tmp`
      mkdirSync(tmpPath)
      try {
        expect(() => revokeProductSpaceCatalogAuthority('account-a', 'space-a')).toThrow()
      } finally {
        rmSync(tmpPath, { recursive: true, force: true })
      }
      // Catastrophic fallback: the authority FILE was removed — without it
      // there is no trustworthy authority, in this process...
      expect(existsSync(authorityFile())).toBe(false)
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')).toBe(false)
      // ...and in a REAL restarted process (both-write failure can never
      // leave the stale record trusted).
      const moduleAbs = join(import.meta.dir, '..', 'product-space-catalog-authority.ts')
      const probe = `
        const { pathToFileURL } = await import('node:url')
        const mod = await import(pathToFileURL(${JSON.stringify(moduleAbs)}).href)
        console.log(JSON.stringify({
          deniedTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-a', 'space-a', 'entry-a', 'artifact-a', 'version-1', '1.0.0'),
          otherTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0'),
        }))
      `
      const restarted = Bun.spawnSync({
        cmd: [process.execPath, '-e', probe],
        cwd: join(import.meta.dir, '..', '..', '..'),
        env: { ...process.env, POLO_AI_CONFIG_DIR: process.env.POLO_AI_CONFIG_DIR! },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(restarted.exitCode).toBe(0)
      const out = JSON.parse(restarted.stdout.toString().trim()) as { deniedTrusted: boolean; otherTrusted: boolean }
      expect(out.deniedTrusted).toBe(false)
      expect(out.otherTrusted).toBe(false)

      // A fresh verified Catalog re-records the scope durably.
      recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-fresh', [entry()])
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
    })

    it('a RENAME fault propagates, fails everything closed on the damaged path, and recovers on retry', () => {
      seedScopes()
      // renameSync fault: the target path is occupied by a directory, so
      // the temp write succeeds but the atomic rename cannot.
      rmSync(authorityFile())
      mkdirSync(authorityFile())
      expect(() => revokeProductSpaceCatalogAuthority('account-a', 'space-a')).toThrow()
      // The damaged path is UNREADABLE — nothing may be trusted from it
      // (in-process the last-known snapshot is allowed; a RELOAD — and
      // therefore any restart — fails closed for every scope).
      __dropAuthorityProcessCacheForTests()
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')).toBe(false)

      // Clear the obstacle: the retry lands the revocation durably and the
      // fresh record recovery works normally afterwards.
      rmSync(authorityFile(), { recursive: true, force: true })
      revokeProductSpaceCatalogAuthority('account-a', 'space-a')
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-after', [entry()])
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
    })

    it('a malformed or invalid-schema authority file is a GLOBAL fail-closed, never an all-clear', () => {
      seedScopes()
      // Unreadable/malformed: garbage JSON.
      writeFileSync(authorityFile(), '{not json', 'utf8')
      __dropAuthorityProcessCacheForTests()
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')).toBe(false)
      // Invalid schema version: equally untrusted.
      writeFileSync(authorityFile(), JSON.stringify({ schemaVersion: 999, records: {} }), 'utf8')
      __dropAuthorityProcessCacheForTests()
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      // A malformed denied record does not disable the denial either: the
      // record is dropped, the file has no trusted authority for the scope.
      const malformedDenied = JSON.parse(readFileSync(authorityFile(), 'utf8'))
      malformedDenied.schemaVersion = 1
      malformedDenied.records[productSpaceCatalogAuthorityKey('account-a', 'space-a')] = { kind: 'denied' }
      writeFileSync(authorityFile(), JSON.stringify(malformedDenied), 'utf8')
      __dropAuthorityProcessCacheForTests()
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
    })

    it('a fresh Catalog after a failed revoke never resurrects the denied identities as tombstones', () => {
      seedScopes()
      const tmpPath = `${authorityFile()}.${process.pid}.tmp`
      mkdirSync(tmpPath)
      try {
        expect(() => revokeProductSpaceCatalogAuthority('account-a', 'space-a')).toThrow()
      } finally {
        rmSync(tmpPath, { recursive: true, force: true })
      }
      // Scope denied: stale record invisible.
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)

      // A fresh verified Catalog containing ONLY a new entry must be built
      // from "no previous authority": the old identity may NOT reappear as a
      // withdrawn tombstone.
      const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
        'account-a',
        'space-a',
        'rev-fresh',
        [entry({
          catalogEntryId: 'entry-fresh',
          artifactInstanceId: 'artifact-fresh',
          version: { versionId: 'version-fresh', version: '2.0.0' },
        })],
      )
      expect(tombstones).toEqual([])
      const record = getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!
      expect(record.tombstones).toEqual([])
      expect(record.entries.map(e => e.catalogEntryId)).toEqual(['entry-fresh'])
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      expect(hasProductSpaceCatalogAuthorityTuple(
        'account-a', 'space-a', 'entry-fresh', 'artifact-fresh', 'version-fresh', '2.0.0',
      )).toBe(true)
    })

    it('a fresh Catalog write fault keeps the deny and propagates instead of clearing it', () => {
      seedScopes()
      const tmpPath = `${authorityFile()}.${process.pid}.tmp`
      mkdirSync(tmpPath)
      try {
        expect(() => revokeProductSpaceCatalogAuthority('account-a', 'space-a')).toThrow()
      } finally {
        rmSync(tmpPath, { recursive: true, force: true })
      }

      // The fresh record's OWN write fails: the error propagates and the
      // scope stays denied (no early marker clear, no swallowed error).
      const freshTmp = `${authorityFile()}.${process.pid}.tmp`
      mkdirSync(freshTmp)
      try {
        expect(() => recordProductSpaceCatalogAuthoritativeEntries(
          'account-a', 'space-a', 'rev-denied-fresh', [entry()],
        )).toThrow()
        expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      } finally {
        rmSync(freshTmp, { recursive: true, force: true })
      }

      // Retry once the obstacle is gone: the fresh record persists durably
      // and the deny clears.
      const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
        'account-a', 'space-a', 'rev-denied-fresh-2', [entry()],
      )
      expect(tombstones).toEqual([])
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
    })

    it('revoking an unknown scope without a pending marker is a no-op', () => {
      expect(() => revokeProductSpaceCatalogAuthority('account-x', 'space-x')).not.toThrow()
      expect(existsSync(authorityFile())).toBe(false)
    })

    it('the durable denial survives a REAL process restart; a fresh success in a restarted process recovers it', () => {
      seedScopes()
      revokeProductSpaceCatalogAuthority('account-a', 'space-a')
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)

      const moduleAbs = join(import.meta.dir, '..', 'product-space-catalog-authority.ts')
      const probe = `
        const { pathToFileURL } = await import('node:url')
        const mod = await import(pathToFileURL(${JSON.stringify(moduleAbs)}).href)
        const deniedTrusted = mod.hasProductSpaceCatalogAuthorityTuple(
          'account-a', 'space-a', 'entry-a', 'artifact-a', 'version-1', '1.0.0')
        const otherTrusted = mod.hasProductSpaceCatalogAuthorityTuple(
          'account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')
        const tombstones = mod.recordProductSpaceCatalogAuthoritativeEntries(
          'account-a', 'space-a', 'rev-restart-fresh',
          [{ kind: 'app', catalogEntryId: 'entry-restarted', artifactInstanceId: 'artifact-restarted',
             version: { versionId: 'version-restarted', version: '3.0.0' }, name: 'Restarted',
             description: '', availability: 'available',
             sources: [{ kind: 'enterprise_import', name: 'Studio R' }], permissions: [] }])
        const freshTrusted = mod.hasProductSpaceCatalogAuthorityTuple(
          'account-a', 'space-a', 'entry-restarted', 'artifact-restarted', 'version-restarted', '3.0.0')
        const oldStillUntrusted = mod.hasProductSpaceCatalogAuthorityTuple(
          'account-a', 'space-a', 'entry-a', 'artifact-a', 'version-1', '1.0.0')
        console.log(JSON.stringify({ deniedTrusted, otherTrusted, tombstones: tombstones.length, freshTrusted, oldStillUntrusted }))
      `
      const restarted = Bun.spawnSync({
        cmd: [process.execPath, '-e', probe],
        cwd: join(import.meta.dir, '..', '..', '..'),
        env: { ...process.env, POLO_AI_CONFIG_DIR: process.env.POLO_AI_CONFIG_DIR! },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(restarted.exitCode).toBe(0)
      const out = JSON.parse(restarted.stdout.toString().trim()) as {
        deniedTrusted: boolean
        otherTrusted: boolean
        tombstones: number
        freshTrusted: boolean
        oldStillUntrusted: boolean
      }
      // Restarted process: the durable denial is loaded fail-closed, other
      // scopes unaffected, the fresh success resurrects ZERO tombstones and
      // trusts only the fresh identity.
      expect(out.deniedTrusted).toBe(false)
      expect(out.otherTrusted).toBe(true)
      expect(out.tombstones).toBe(0)
      expect(out.freshTrusted).toBe(true)
      expect(out.oldStillUntrusted).toBe(false)

      // Process 3 (another independent restart): the fresh record survives
      // and the old identity stays gone.
      const probe2 = `
        const { pathToFileURL } = await import('node:url')
        const mod = await import(pathToFileURL(${JSON.stringify(moduleAbs)}).href)
        console.log(JSON.stringify({
          freshTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-a', 'space-a', 'entry-restarted', 'artifact-restarted', 'version-restarted', '3.0.0'),
          oldUntrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-a', 'space-a', 'entry-a', 'artifact-a', 'version-1', '1.0.0'),
        }))
      `
      const third = Bun.spawnSync({
        cmd: [process.execPath, '-e', probe2],
        cwd: join(import.meta.dir, '..', '..', '..'),
        env: { ...process.env, POLO_AI_CONFIG_DIR: process.env.POLO_AI_CONFIG_DIR! },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(third.exitCode).toBe(0)
      const finalState = JSON.parse(third.stdout.toString().trim()) as {
        freshTrusted: boolean
        oldUntrusted: boolean
      }
      expect(finalState.freshTrusted).toBe(true)
      expect(finalState.oldUntrusted).toBe(false)
    })
  })
})
