import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import {
  createDraftReleaseIdentity,
  parseDraftReleaseIdentity,
  RELEASE_ASSET_NAMES,
} from './electron-release-draft-identity'

async function fixture(): Promise<{ root: string, release: object }> {
  const root = await mkdtemp(join(tmpdir(), 'polo-draft-identity-'))
  const assets = await Promise.all(RELEASE_ASSET_NAMES.map(async (name, index) => {
    const contents = `asset-${index + 1}`
    await writeFile(join(root, name), contents)
    return { id: index + 1, name, size: Buffer.byteLength(contents), state: 'uploaded' }
  }))
  return { root, release: { id: 123, draft: true, assets } }
}

describe('approved Draft Release identity', () => {
  it('pins the numeric release ID and all nine uploaded asset IDs, names, sizes, and SHA-256 digests', async () => {
    const { root, release } = await fixture()
    try {
      const identity = await createDraftReleaseIdentity(root, release)
      expect(identity.releaseId).toBe(123)
      expect(identity.assets).toHaveLength(9)
      expect(identity.assets.map(asset => asset.name).sort()).toEqual([...RELEASE_ASSET_NAMES].sort())
      expect(identity.assets.every(asset => /^[a-f0-9]{64}$/.test(asset.sha256))).toBe(true)
      expect(parseDraftReleaseIdentity(identity)).toEqual(identity)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects non-Draft releases and incomplete or forged approved identities', async () => {
    const { root, release } = await fixture()
    try {
      await expect(createDraftReleaseIdentity(root, { ...release, draft: false }))
        .rejects.toThrow('must remain a Draft')
      expect(() => parseDraftReleaseIdentity({ releaseId: 123, assets: [] }))
        .toThrow('complete release whitelist')
      const identity = await createDraftReleaseIdentity(root, release)
      identity.assets[0]!.sha256 = 'not-a-digest'
      expect(() => parseDraftReleaseIdentity(identity)).toThrow('asset identity is invalid')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
