import { describe, expect, it } from 'bun:test'
import type { ProductSpaceAppIdentity } from '@polo-ai/shared/protocol'
import { sameProductSpaceAppIdentity } from '../product-space-app-identity'

function identity(): ProductSpaceAppIdentity {
  return {
    accountId: 'account-a', productSpaceId: 'space-a', catalogRevision: 'revision-a',
    catalogEntryId: 'entry-a', artifactInstanceId: 'artifact-a',
    versionId: 'version-a', version: '1.0.0',
    sources: [
      { kind: 'creator_circle', name: 'Circle A', circleId: 'circle-a' },
      { kind: 'enterprise_import', name: null, circleId: null },
    ],
    availability: 'available',
  }
}

function expectRejected(value: unknown) {
  expect(sameProductSpaceAppIdentity(identity(), value)).toBe(false)
  expect(sameProductSpaceAppIdentity(value, identity())).toBe(false)
  // Matching malformed shapes must never qualify as a complete identity.
  expect(sameProductSpaceAppIdentity(value, structuredClone(value))).toBe(false)
}

describe('sameProductSpaceAppIdentity', () => {
  it('ignores only object key order, including Main reconstruction and source objects', () => {
    const input = identity()
    const main = {
      accountId: input.accountId, productSpaceId: input.productSpaceId,
      catalogEntryId: input.catalogEntryId, artifactInstanceId: input.artifactInstanceId,
      versionId: input.versionId, version: input.version, catalogRevision: input.catalogRevision,
      sources: input.sources.map(source => ({
        circleId: source.circleId, name: source.name, kind: source.kind,
      })),
      availability: input.availability,
    }
    expect(JSON.stringify(input)).not.toBe(JSON.stringify(main))
    expect(sameProductSpaceAppIdentity(input, main)).toBe(true)
    expect(sameProductSpaceAppIdentity(main, input)).toBe(true)
    expect(sameProductSpaceAppIdentity(input, structuredClone(input))).toBe(true)
  })

  const scalarFields = [
    'accountId', 'productSpaceId', 'catalogEntryId', 'artifactInstanceId',
    'versionId', 'version', 'catalogRevision', 'availability',
  ] as const
  for (const field of scalarFields) {
    it(`rejects a change to ${field}, including exact whitespace and case`, () => {
      for (const value of [field === 'availability' ? 'withdrawn' : 'other',
        ` ${identity()[field]}`, identity()[field].toUpperCase()]) {
        expect(sameProductSpaceAppIdentity(identity(), { ...identity(), [field]: value })).toBe(false)
      }
    })
    it(`rejects missing or malformed ${field}`, () => {
      const missing: Record<string, unknown> = { ...identity() }
      delete missing[field]
      expectRejected(missing)
      for (const value of [undefined, null, 1, true, {}, [], '', ' ']) {
        expectRejected({ ...identity(), [field]: value })
      }
    })
  }
  for (const field of ['kind', 'name', 'circleId'] as const) {
    it(`rejects changes and whitespace in source ${field}`, () => {
      for (const value of ['different', ` ${identity().sources[0]![field]}`, null]) {
        const other = identity()
        other.sources = [{ ...other.sources[0]!, [field]: value }, other.sources[1]!]
        expect(sameProductSpaceAppIdentity(identity(), other)).toBe(false)
      }
      const other = identity()
      other.sources = [other.sources[0]!, { ...other.sources[1]!, [field]: '' }]
      expect(sameProductSpaceAppIdentity(identity(), other)).toBe(false)
    })
    it(`rejects missing or malformed source ${field}`, () => {
      const source: Record<string, unknown> = { ...identity().sources[0]! }
      delete source[field]
      expectRejected({ ...identity(), sources: [source, identity().sources[1]] })
      for (const value of [undefined, 1, true, {}, [], '', ' ']) {
        expectRejected({ ...identity(), sources: [{ ...identity().sources[0], [field]: value }] })
      }
    })
  }
  it('preserves source order, length and duplicate counts', () => {
    const expected = identity()
    for (const sources of [
      [...expected.sources].reverse(), expected.sources.slice(1),
      [...expected.sources, expected.sources[0]!],
      [expected.sources[0]!, expected.sources[0]!],
    ]) expect(sameProductSpaceAppIdentity(expected, { ...expected, sources })).toBe(false)
    const repeated = { ...expected, sources: [...expected.sources, expected.sources[0]!] }
    expect(sameProductSpaceAppIdentity(repeated, structuredClone(repeated))).toBe(true)
    expect(sameProductSpaceAppIdentity(repeated, expected)).toBe(false)
  })
  it('rejects absent, empty, sparse and malformed source arrays', () => {
    const missing: Record<string, unknown> = { ...identity() }
    delete missing.sources
    expectRejected(missing)
    for (const sources of [undefined, null, {}, 'sources', [], Array(2), [null], [1], [[]]]) {
      expectRejected({ ...identity(), sources })
    }
  })
  it('rejects extra identity/source fields even when both sides contain them', () => {
    expectRejected({ ...identity(), extra: 'unexpected' })
    expectRejected({ ...identity(), extra: undefined })
    expectRejected({ ...identity(), sources: [{ ...identity().sources[0], extra: 'unexpected' }] })
    expectRejected({ ...identity(), sources: [{ ...identity().sources[0], extra: undefined }] })
  })
  it('rejects non-object identities and invalid availability values', () => {
    for (const value of [null, undefined, true, 1, 'identity', [], {}]) expectRejected(value)
    expectRejected({ ...identity(), availability: 'installed' })
  })
})
