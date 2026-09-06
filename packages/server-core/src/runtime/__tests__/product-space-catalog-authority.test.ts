import { beforeEach, describe, expect, it } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __dropAuthorityProcessCacheForTests,
  getProductSpaceCatalogAuthorityRecord,
  hasProductSpaceCatalogAuthorityTuple,
  loadProductSpaceCatalogAuthorityTupleSet,
  productSpaceCatalogAuthorityKey,
  productSpaceCatalogAuthorityTupleKey,
  resetProductSpaceCatalogAuthorityForTests,
  revokeProductSpaceCatalogAuthority,
} from '../product-space-catalog-authority'
import { recordProductSpaceCatalogAuthoritativeEntries } from '../product-space-catalog-authority-commit'
import * as publicAuthority from '../product-space-catalog-authority'

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

    // Cold-start default-distrust: no disk record (mis-keyed or not) creates
    // TRUST — neither scope serves tuples from the tampered file.
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')).toBeNull()
    expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', ...tuple())).toBe(false)

    // Self-heal: revalidating A rebuilds A's scope with A's OWN entries —
    // never B's tuples from the mis-keyed record.
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-healed', [entry()])
    expect(tombstones).toEqual([])
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.catalogRevision).toBe('rev-healed')
    expect(getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!.entries[0]!.catalogEntryId).toBe('entry-a')
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

    it('a WRITE fault propagates and NO fresh process trusts the stale authority (dual-fault, unrelated scope untouched)', () => {
      seedScopes()
      // writeFileSync fault: the temp target exists as a DIRECTORY. The
      // directory is also made read-only-proof irrelevant here — the point
      // is the atomic rename fails and NO unlink fallback exists: the file
      // (including the unrelated scope) stays untouched on disk.
      const tmpPath = `${authorityFile()}.${process.pid}.tmp`
      mkdirSync(tmpPath)
      try {
        expect(() => revokeProductSpaceCatalogAuthority('account-a', 'space-a')).toThrow()
      } finally {
        rmSync(tmpPath, { recursive: true, force: true })
      }
      // In-process: the denied scope AND the unrelated scope's trust are
      // untouched by the failed write — the denial is exact-scope.
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')).toBe(true)
      // The file stays on disk (candidate/display cache)...

      // ...but a REAL restarted process trusts NOTHING: cold-start
      // default-distrust means even the dual-fault stale authority can never
      // become a grant without a fresh server revalidation.
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

      // A fresh verified Catalog re-records the scope durably and restores
      // THIS process' trust.
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

      // P2 uses the INTERNAL commit entry (the grant mutator is not on the
      // public subpath — see the boundary test below).
      const moduleAbs = join(import.meta.dir, '..', 'product-space-catalog-authority-internal.ts')
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
      // Restarted process: cold-start trusts NOTHING from disk (both scopes
      // are candidates); the fresh success resurrects ZERO tombstones and
      // grants only the revalidated fresh identity.
      expect(out.deniedTrusted).toBe(false)
      expect(out.otherTrusted).toBe(false)
      expect(out.tombstones).toBe(0)
      expect(out.freshTrusted).toBe(true)
      expect(out.oldStillUntrusted).toBe(false)

      // Process 3 (another independent restart): the fresh record is a
      // CANDIDATE only — cold-start distrusts it until THIS process
      // revalidates; then it trusts exactly the fresh identity.
      const probe2 = `
        const { pathToFileURL } = await import('node:url')
        const mod = await import(pathToFileURL(${JSON.stringify(moduleAbs)}).href)
        const coldTrusted = mod.hasProductSpaceCatalogAuthorityTuple(
          'account-a', 'space-a', 'entry-restarted', 'artifact-restarted', 'version-restarted', '3.0.0')
        mod.recordProductSpaceCatalogAuthoritativeEntries(
          'account-a', 'space-a', 'rev-p3',
          [{ kind: 'app', catalogEntryId: 'entry-restarted', artifactInstanceId: 'artifact-restarted',
             version: { versionId: 'version-restarted', version: '3.0.0' }, name: 'Restarted',
             description: '', availability: 'available',
             sources: [{ kind: 'enterprise_import', name: 'Studio R' }], permissions: [] }])
        console.log(JSON.stringify({
          coldTrusted,
          revalidatedTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
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
        coldTrusted: boolean
        revalidatedTrusted: boolean
        oldUntrusted: boolean
      }
      expect(finalState.coldTrusted).toBe(false)
      expect(finalState.revalidatedTrusted).toBe(true)
      expect(finalState.oldUntrusted).toBe(false)
    })
  })
})

describe('R24: denied-recovery transaction (no cross-scope laundering)', () => {
  const authorityFile = (): string => join(process.env.POLO_AI_CONFIG_DIR!, 'product-space-catalog-authority.json')

  function seedScopes(): void {
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-1', [entry()])
    recordProductSpaceCatalogAuthoritativeEntries('account-b', 'space-b', 'rev-1', [
      entry({ catalogEntryId: 'entry-b', artifactInstanceId: 'artifact-b' }),
    ])
  }

  it('P1 denied A → P2 fresh-A persist fails → B succeeds: disk A stays denied, cache unpublishable', () => {
    // P1: durable deny A.
    seedScopes()
    revokeProductSpaceCatalogAuthority('account-a', 'space-a')
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)

    // P2 (same process model): fresh-A persist FAILS (temp occupied)…
    const tmpPath = `${authorityFile()}.${process.pid}.tmp`
    mkdirSync(tmpPath)
    try {
      expect(() => recordProductSpaceCatalogAuthoritativeEntries(
        'account-a', 'space-a', 'fresh-a', [entry()],
      )).toThrow()
      // …A is still denied/untrusted in this process, and the shared cache
      // was NEVER published with the failed candidate.
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
    } finally {
      // The transient fault clears (the blocker is removed)…
      rmSync(tmpPath, { recursive: true, force: true })
    }

    // …B then refreshes SUCCESSFULLY: the durable file must keep A's
    // denied record — B's success cannot launder A's failed candidate.
    recordProductSpaceCatalogAuthoritativeEntries('account-b', 'space-b', 'fresh-b', [
      entry({ catalogEntryId: 'entry-b2', artifactInstanceId: 'artifact-b2' }),
    ])
    const onDisk = JSON.parse(readFileSync(authorityFile(), 'utf8'))
    const aRecord = onDisk.records[productSpaceCatalogAuthorityKey('account-a', 'space-a')]
    expect(aRecord.kind).toBe('denied')
    expect(onDisk.records[productSpaceCatalogAuthorityKey('account-b', 'space-b')].catalogRevision).toBe('fresh-b')
    // A remains denied after B's success.
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
    expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b2', 'artifact-b2', 'version-1', '1.0.0')).toBe(true)

    // P3 (fresh process, READ-ONLY directory): fresh A goes down the normal
    // path and must THROW (no swallow, no in-process trust) while the disk
    // stays untouched.
    chmodSync(dirname(authorityFile()), 0o555)
    try {
      expect(() => recordProductSpaceCatalogAuthoritativeEntries(
        'account-a', 'space-a', 'fresh-a-p3', [entry()],
      )).toThrow()
      const onDisk = JSON.parse(readFileSync(authorityFile(), 'utf8'))
      expect(onDisk.records[productSpaceCatalogAuthorityKey('account-a', 'space-a')].kind).toBe('denied')
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
    } finally {
      chmodSync(dirname(authorityFile()), 0o755)
    }

    // After permissions are restored, a fresh revalidation recovers A.
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a', 'space-a', 'fresh-a-recovered', [entry()],
    )
    expect(tombstones).toEqual([])
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
  })

  it('P1 denied A → P2 fresh-A fails under a REAL 0555 read-only containing directory → P3 fresh process still denies A', () => {
    seedScopes()
    revokeProductSpaceCatalogAuthority('account-a', 'space-a')

    // REAL POSIX dual fault: the containing directory is made read-only so
    // BOTH the temp-file creation and any old-file mutation are denied,
    // while the pre-existing authority file stays perfectly readable.
    const dir = dirname(authorityFile())
    chmodSync(dir, 0o555)
    try {
      expect(() => recordProductSpaceCatalogAuthoritativeEntries(
        'account-a', 'space-a', 'fresh-readonly', [entry()],
      )).toThrow()
      // The old file is intact and readable; A stays denied in this process.
      expect(readFileSync(authorityFile(), 'utf8')).toContain('"kind":"denied"')
      expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(false)
      // Unrelated scope keeps its precise in-process trust.
      expect(hasProductSpaceCatalogAuthorityTuple('account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0')).toBe(true)

      // A REAL fresh process (third process) reads the readable candidate
      // file but must trust NOTHING before its own revalidation.
      const moduleAbs = join(import.meta.dir, '..', 'product-space-catalog-authority-internal.ts')
      const probe = `
        const { pathToFileURL } = await import('node:url')
        const mod = await import(pathToFileURL(${JSON.stringify(moduleAbs)}).href)
        console.log(JSON.stringify({
          deniedTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-a', 'space-a', 'entry-a', 'artifact-a', 'version-1', '1.0.0'),
          otherTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0'),
          deniedOnDisk: JSON.parse(
            require('node:fs').readFileSync(
              process.env.POLO_AI_CONFIG_DIR + '/product-space-catalog-authority.json', 'utf8',
            ),
          ).records[${JSON.stringify(productSpaceCatalogAuthorityKey('account-a', 'space-a'))}].kind,
        }))
      `
      const fresh = Bun.spawnSync({
        cmd: [process.execPath, '-e', probe],
        cwd: join(import.meta.dir, '..', '..', '..'),
        env: { ...process.env, POLO_AI_CONFIG_DIR: process.env.POLO_AI_CONFIG_DIR! },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(fresh.exitCode).toBe(0)
      const out = JSON.parse(fresh.stdout.toString().trim()) as {
        deniedTrusted: boolean
        otherTrusted: boolean
        deniedOnDisk: string
      }
      expect(out.deniedTrusted).toBe(false)
      expect(out.otherTrusted).toBe(false)
      expect(out.deniedOnDisk).toBe('denied')
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})

describe('R24: public-surface boundary (no public grant API)', () => {
  it('the public subpath exposes NO grant-capable mutator', async () => {
    const pub = await import('../product-space-catalog-authority')
    expect((pub as Record<string, unknown>).recordProductSpaceCatalogAuthoritativeEntries).toBeUndefined()
    // Public read/revoke APIs cannot mint trust either: a fresh process
    // state + revoke/read round-trip leaves the tuples untrusted.
    resetProductSpaceCatalogAuthorityForTests()
    seedScopesNoop()
    expect(hasProductSpaceCatalogAuthorityTuple('account-x', 'space-x', ...tuple())).toBe(false)
    expect(() => revokeProductSpaceCatalogAuthority('account-x', 'space-x')).not.toThrow()
    expect(hasProductSpaceCatalogAuthorityTuple('account-x', 'space-x', ...tuple())).toBe(false)
  })

  function seedScopesNoop(): void {
    recordA()
  }
  function recordA(): void {
    // no-op: the boundary test proves trust CANNOT be created without the
    // internal commit entry — nothing is seeded here on purpose.
  }

  it('the package exports map does NOT expose the commit module', () => {
    const pkg = JSON.parse(readFileSync(
      join(import.meta.dir, '..', '..', '..', 'package.json'),
      'utf8',
    )) as { exports: Record<string, string> }
    const exposed = Object.values(pkg.exports ?? {}).join('|')
    expect(exposed).not.toContain('product-space-catalog-authority-commit')
    expect(exposed).toContain('product-space-catalog-authority')
  })
})

describe('R24: explicit kind union decoding', () => {
  const authorityFile = (): string => join(process.env.POLO_AI_CONFIG_DIR!, 'product-space-catalog-authority.json')
  const moduleAbs = join(import.meta.dir, '..', 'product-space-catalog-authority-internal.ts')

  function writeRecords(records: Record<string, unknown>): void {
    writeFileSync(authorityFile(), JSON.stringify({
      schemaVersion: 1,
      records,
    }), 'utf8')
    __dropAuthorityProcessCacheForTests()
  }

  function probeTrusted(entryId: string, artifactId: string, versionId = 'version-1', version = '1.0.0'): boolean {
    const probe = `
      const { pathToFileURL } = await import('node:url')
      const mod = await import(pathToFileURL(${JSON.stringify(moduleAbs)}).href)
      console.log(JSON.stringify({
        trusted: mod.hasProductSpaceCatalogAuthorityTuple(
          'account-a', 'space-a', ${JSON.stringify(entryId)}, ${JSON.stringify(artifactId)}, ${JSON.stringify(versionId)}, ${JSON.stringify(version)}),
    }))
    `
    const proc = Bun.spawnSync({
      cmd: [process.execPath, '-e', probe],
      cwd: join(import.meta.dir, '..', '..', '..'),
      env: { ...process.env, POLO_AI_CONFIG_DIR: process.env.POLO_AI_CONFIG_DIR! },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(proc.exitCode).toBe(0)
    return JSON.parse(proc.stdout.toString().trim()).trusted
  }

  const scopeKey = JSON.stringify(['product-space-catalog', 1, 'account-a', 'space-a'])

  it('an explicit kind=authority record is a candidate on cold start and grants after revalidation', () => {
    const explicit = {
      kind: 'authority',
      schemaVersion: 1,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      syncedAt: 1,
      catalogRevision: 'rev-explicit',
      entries: [{
        kind: 'app', catalogEntryId: 'entry-x', artifactInstanceId: 'artifact-x',
        versionId: 'version-1', version: '1.0.0', name: 'X', description: '',
        availability: 'available', sources: [{ kind: 'enterprise_import', name: 'S' }],
        permissions: [],
      }],
      tombstones: [],
    }
    writeRecords({ [scopeKey]: explicit })
    // Cold start: candidate — never a grant.
    expect(probeTrusted('entry-x', 'artifact-x')).toBe(false)
    // Fresh revalidation migrates/refreshes and grants in-process.
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-2', [entry()])
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
    // The durable record is migrated to the explicit kind.
    const onDisk = JSON.parse(readFileSync(authorityFile(), 'utf8'))
    expect(onDisk.records[scopeKey].kind).toBe('authority')
  })

  it('a legacy (missing-kind) record is a non-granting candidate that migrates on fresh success', () => {
    const legacy = {
      schemaVersion: 1,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      syncedAt: 1,
      catalogRevision: 'rev-legacy',
      entries: [{
        kind: 'app', catalogEntryId: 'entry-legacy', artifactInstanceId: 'artifact-legacy',
        versionId: 'version-1', version: '1.0.0', name: 'L', description: '',
        availability: 'available', sources: [{ kind: 'enterprise_import', name: 'S' }],
        permissions: [],
      }],
      tombstones: [],
    }
    writeRecords({ [scopeKey]: legacy })
    // Never grants.
    expect(probeTrusted('entry-legacy', 'artifact-legacy')).toBe(false)
    // Fresh success migrates the record to kind=authority.
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-migrate', [entry()])
    const onDisk = JSON.parse(readFileSync(authorityFile(), 'utf8'))
    expect(onDisk.records[scopeKey].kind).toBe('authority')
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
  })

  it('an unknown kind is dropped (fail closed) and a fresh Catalog rebuilds the scope', () => {
    const unknownKind = {
      kind: 'quarantined-by-someone',
      schemaVersion: 1,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      syncedAt: 1,
      catalogRevision: 'rev-unknown',
      entries: [],
      tombstones: [],
    }
    writeRecords({ [scopeKey]: unknownKind })
    expect(probeTrusted('entry-any', 'artifact-any')).toBe(false)
    // The malformed/unknown record is dropped at load — the reload sees no
    // trusted authority and a fresh Catalog rebuilds cleanly.
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-rebuild', [entry()])
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
  })
})

describe('R25: wildcard traversal + deep snapshot + legacy zero-contribution', () => {
  const authorityFile = (): string => join(process.env.POLO_AI_CONFIG_DIR!, 'product-space-catalog-authority.json')
  const scopeKey = JSON.stringify(['product-space-catalog', 1, 'account-a', 'space-a'])
  const moduleAbs = join(import.meta.dir, '..', 'product-space-catalog-authority-internal.ts')

  it('blocks plain and percent-encoded traversal to the commit/internal modules while safe exports stay usable', async () => {
    const attempts = [
      ['plain commit traversal', '@polo-ai/server-core/handlers/rpc/../../runtime/product-space-catalog-authority-commit'],
      ['encoded commit traversal', '@polo-ai/server-core/handlers/rpc/%2e%2e%2f%2e%2e%2fruntime/product-space-catalog-authority-commit'],
      ['plain internal traversal', '@polo-ai/server-core/handlers/rpc/../../runtime/product-space-catalog-authority-internal'],
      ['runtime commit direct', '@polo-ai/server-core/runtime/product-space-catalog-authority-commit'],
      ['runtime internal direct', '@polo-ai/server-core/runtime/product-space-catalog-authority-internal'],
    ]
    for (const [label, specifier] of attempts) {
      try {
        const mod = await import(/* @vite-ignore */ specifier)
        // An import that resolves must not expose the grant mutator.
        expect((mod as Record<string, unknown>).recordProductSpaceCatalogAuthoritativeEntries).toBeUndefined()
      } catch (error) {
        const code = (error as { code?: string }).code
        expect(['ERR_PACKAGE_PATH_NOT_EXPORTED', 'ERR_MODULE_NOT_FOUND'] as string[]).toContain(code as string)
      }
    }
    // Safe exports remain usable.
    const admin = await import('@polo-ai/server-core/handlers/rpc/admin')
    expect(typeof admin.registerAdminHandlers).toBe('function')
  })

  it('the public record getter returns a deep snapshot: mutating every layer cannot forge trust', () => {
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-1', [entry()])
    const snapshot = publicAuthority.getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!
    expect(snapshot.entries).toHaveLength(1)
    // Mutate every aliasable layer of the returned value.
    try {
      (snapshot.entries as unknown as unknown[]).length = 0
    } catch {}
    const first = snapshot.entries[0] as unknown as Record<string, unknown>
    if (first) {
      try {
        first.catalogEntryId = 'forged-entry'
        ;(first.sources as unknown as unknown[]).length = 0
        ;((first as { permissions: unknown[] }).permissions as unknown[]).length = 0
      } catch {}
    }
    try {
      (snapshot.tombstones as unknown as unknown[]).length = 0
    } catch {}
    try {
      (snapshot as unknown as { catalogRevision: string }).catalogRevision = 'forged-revision'
    } catch {}

    // Internal trust is untouched at every layer.
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
    expect(loadProductSpaceCatalogAuthorityTupleSet('account-a', 'space-a')).toEqual(
      new Set([productSpaceCatalogAuthorityTupleKey(...tuple())]),
    )
    const reread = publicAuthority.getProductSpaceCatalogAuthorityRecord('account-a', 'space-a')!
    expect(reread.entries).toHaveLength(1)
    expect((reread.entries[0] as { catalogEntryId: string }).catalogEntryId).toBe('entry-a')
    expect(reread.catalogRevision).toBe('rev-1')
    expect(Object.isFrozen(reread.entries)).toBe(true)
    expect(Object.isFrozen(reread.entries[0])).toBe(true)
  })

  it('a malformed legacy candidate (invalid entry) contributes ZERO tombstones to a fresh empty Catalog', () => {
    const malformedEntry = {
      schemaVersion: 1,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      syncedAt: 1,
      catalogRevision: 'rev-legacy-malformed',
      entries: [{
        kind: 'app', catalogEntryId: 'entry-forged', artifactInstanceId: 'artifact-forged',
        versionId: 'version-forged', version: '1.0.0', name: 'Forged', description: '',
        availability: 'available', sources: [], permissions: [],
      }],
      tombstones: [],
    }
    writeFileSync(authorityFile(), JSON.stringify({
      schemaVersion: 1,
      records: { [scopeKey]: malformedEntry },
    }), 'utf8')
    __dropAuthorityProcessCacheForTests()

    // Fresh EMPTY Catalog: the malformed legacy entry must NOT become a
    // retained trusted tombstone.
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a', 'space-a', 'rev-empty', [],
    )
    expect(tombstones).toEqual([])
    expect(hasProductSpaceCatalogAuthorityTuple(
      'account-a', 'space-a', 'entry-forged', 'artifact-forged', 'version-forged', '1.0.0',
    )).toBe(false)
    const onDisk = JSON.parse(readFileSync(authorityFile(), 'utf8'))
    const record = onDisk.records[scopeKey]
    expect(record.kind).toBe('authority')
    expect(record.tombstones).toEqual([])
  })

  it('an invalid legacy tombstone and an over-cap legacy record contribute nothing and stay untrusted', () => {
    const invalidTombstone = {
      schemaVersion: 1,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      syncedAt: 1,
      catalogRevision: 'rev-legacy-invalid-tombstone',
      entries: [],
      tombstones: [{ kind: 'app', catalogEntryId: 'ghost', artifactInstanceId: 'ghost-a',
        versionId: 'version-ghost', version: '1.0.0', name: 'Ghost', description: '',
        availability: 'withdrawn', sources: [], permissions: [], withdrawnAt: 1 }],
    }
    writeFileSync(authorityFile(), JSON.stringify({
      schemaVersion: 1, records: { [scopeKey]: invalidTombstone },
    }), 'utf8')
    __dropAuthorityProcessCacheForTests()
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a', 'space-a', 'rev-empty', [],
    )
    expect(tombstones).toEqual([])
    expect(hasProductSpaceCatalogAuthorityTuple(
      'account-a', 'space-a', 'ghost', 'ghost-a', 'version-ghost', '1.0.0',
    )).toBe(false)
  })

  it('a valid-looking forged legacy record never grants, even with a non-empty fresh response', () => {
    const forgedLegacy = {
      schemaVersion: 1,
      accountId: 'account-a',
      productSpaceId: 'space-a',
      syncedAt: 1,
      catalogRevision: 'rev-forged-legacy',
      entries: [{
        kind: 'app', catalogEntryId: 'entry-forged', artifactInstanceId: 'artifact-forged',
        versionId: 'version-forged', version: '1.0.0', name: 'Forged', description: '',
        availability: 'available', sources: [{ kind: 'enterprise_import', name: 'S' }],
        permissions: [],
      }],
      tombstones: [],
    }
    writeFileSync(authorityFile(), JSON.stringify({
      schemaVersion: 1, records: { [scopeKey]: forgedLegacy },
    }), 'utf8')
    __dropAuthorityProcessCacheForTests()
    expect(hasProductSpaceCatalogAuthorityTuple(
      'account-a', 'space-a', 'entry-forged', 'artifact-forged', 'version-forged', '1.0.0',
    )).toBe(false)

    // Fresh non-empty response: only the fresh response's own live rows grant.
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a', 'space-a', 'rev-fresh-nonempty',
      [entry({ catalogEntryId: 'entry-real', artifactInstanceId: 'artifact-real' })],
    )
    expect(tombstones).toEqual([])
    expect(hasProductSpaceCatalogAuthorityTuple(
      'account-a', 'space-a', 'entry-forged', 'artifact-forged', 'version-forged', '1.0.0',
    )).toBe(false)
    expect(hasProductSpaceCatalogAuthorityTuple(
      'account-a', 'space-a', 'entry-real', 'artifact-real', 'version-1', '1.0.0',
    )).toBe(true)
  })

  it('the REAL 0555 containing-directory dual fault: create/unlink/rename denied, old bytes intact, cold process denies, fresh commit under 0555 throws, recovery after chmod', () => {
    // uid disposition: POSIX permission checks are bypassed for uid 0; the
    // probe asserts the fault domain only for non-root runs (CI/dev run as
    // uid 501 on macOS / unprivileged on Linux).
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      console.log('skipped: running as uid 0 bypasses permission faults')
      return
    }
    recordProductSpaceCatalogAuthoritativeEntries('account-a', 'space-a', 'rev-1', [entry()])
    recordProductSpaceCatalogAuthoritativeEntries('account-b', 'space-b', 'rev-1', [
      entry({ catalogEntryId: 'entry-b', artifactInstanceId: 'artifact-b' }),
    ])
    // Dedicated targets for rename + old-file mutation BEFORE chmod.
    const renameTarget = join(dirname(authorityFile()), 'r25-rename-probe.bin')
    const oldFileSnapshot = readFileSync(authorityFile(), 'utf8')
    writeFileSync(renameTarget, 'x')
    const dir = dirname(authorityFile())
    chmodSync(dir, 0o555)
    try {
      // create denied
      let createErrno: string | null = null
      try {
        writeFileSync(join(dir, 'r25-create-probe.bin'), 'x')
      } catch (error) {
        createErrno = (error as { code?: string }).code ?? 'unknown'
      }
      expect(createErrno).toBe('EACCES')
      // rename denied
      let renameErrno: string | null = null
      try {
        renameSync(renameTarget, join(dir, 'r25-rename-dest.bin'))
      } catch (error) {
        // macOS returns EPERM on cross-permission renames into a read-only
        // directory; Linux returns EACCES. Either is a denied rename.
        const code = (error as { code?: string }).code
        renameErrno = code ?? `unknown: ${String(error).slice(0, 60)}`
      }
      expect(['EACCES', 'EPERM', 'ENOENT'] as string[]).toContain(renameErrno as string)
      // old-file unlink/mutation denied
      let unlinkErrno: string | null = null
      try {
        rmSync(authorityFile())
      } catch (error) {
        unlinkErrno = (error as { code?: string }).code ?? 'unknown'
      }
      expect(['EACCES', 'EPERM'] as string[]).toContain(unlinkErrno as string)
      // Old authority bytes intact (readable).
      expect(readFileSync(authorityFile(), 'utf8')).toBe(oldFileSnapshot)

      // revoke + fresh persist must BOTH throw inside this fault domain.
      expect(() => revokeProductSpaceCatalogAuthority('account-a', 'space-a')).toThrow()
      expect(() => recordProductSpaceCatalogAuthoritativeEntries(
        'account-a', 'space-a', 'fresh-0555', [entry()],
      )).toThrow()
      // Old bytes STILL intact.
      expect(readFileSync(authorityFile(), 'utf8')).toBe(oldFileSnapshot)

      // P3: a cold child process must deny BOTH scopes before revalidation
      // AND its fresh commit attempt under 0555 must throw.
      const moduleAbs = join(import.meta.dir, '..', 'product-space-catalog-authority-internal.ts')
      const probe = `
        const { pathToFileURL } = await import('node:url')
        const fs = await import('node:fs')
        const mod = await import(pathToFileURL(${JSON.stringify(moduleAbs)}).href)
        let commitThrew = false
        try {
          mod.recordProductSpaceCatalogAuthoritativeEntries(
            'account-a', 'space-a', 'rev-p3-0555',
            [{ kind: 'app', catalogEntryId: 'entry-p3', artifactInstanceId: 'artifact-p3',
               version: { versionId: 'version-p3', version: '9.0.0' }, name: 'P3', description: '',
               availability: 'available', sources: [{ kind: 'enterprise_import', name: 'S' }],
               permissions: [] }])
        } catch { commitThrew = true }
        console.log(JSON.stringify({
          commitThrew,
          aTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-a', 'space-a', 'entry-a', 'artifact-a', 'version-1', '1.0.0'),
          bTrusted: mod.hasProductSpaceCatalogAuthorityTuple(
            'account-b', 'space-b', 'entry-b', 'artifact-b', 'version-1', '1.0.0'),
          oldBytesIntact: fs.readFileSync(
            process.env.POLO_AI_CONFIG_DIR + '/product-space-catalog-authority.json', 'utf8',
          ) === ${JSON.stringify(oldFileSnapshot)},
        }))
      `
      const p3 = Bun.spawnSync({
        cmd: [process.execPath, '-e', probe],
        cwd: join(import.meta.dir, '..', '..', '..'),
        env: { ...process.env, POLO_AI_CONFIG_DIR: process.env.POLO_AI_CONFIG_DIR! },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(p3.exitCode).toBe(0)
      const p3Out = JSON.parse(p3.stdout.toString().trim()) as {
        commitThrew: boolean
        aTrusted: boolean
        bTrusted: boolean
        oldBytesIntact: boolean
      }
      expect(p3Out.commitThrew).toBe(true)
      expect(p3Out.aTrusted).toBe(false)
      expect(p3Out.bTrusted).toBe(false)
      expect(p3Out.oldBytesIntact).toBe(true)
    } finally {
      chmodSync(dir, 0o755)
      rmSync(renameTarget, { force: true })
      rmSync(join(dir, 'r25-create-probe.bin'), { force: true })
      rmSync(join(dir, 'r25-rename-dest.bin'), { force: true })
    }

    // Permission restored: fresh commit succeeds and recovers the scope.
    const tombstones = recordProductSpaceCatalogAuthoritativeEntries(
      'account-a', 'space-a', 'rev-recovered', [entry()],
    )
    expect(tombstones).toEqual([])
    expect(hasProductSpaceCatalogAuthorityTuple('account-a', 'space-a', ...tuple())).toBe(true)
  })
})
