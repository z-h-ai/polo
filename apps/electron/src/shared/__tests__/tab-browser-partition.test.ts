import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  LEGACY_TAB_APP_PARTITION_PREFIX,
  legacyTabAppPartitionForScope,
  tabAppPartitionForScope,
} from '../tab-browser-partition'

/** Reference SHA-256 computed with Node crypto for the same UTF-8 input. */
function referenceSha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex')
}

describe('tab-app partition identity', () => {
  it('implements SHA-256 correctly (known vectors vs Node crypto)', () => {
    // The partition naming depends on this pure-JS SHA-256 matching the
    // reference in both renderer and Main. Replicate the module's
    // length-prefixed encoding and compare with Node's digest.
    for (const vector of [
      '',
      'abc',
      'product-space',
      '账号/空间/工作区 ✓ multi-byte',
      'a'.repeat(55),
      'a'.repeat(56),
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(65),
      'a'.repeat(200),
    ]) {
      const encodedTuple = [
        vector.length, vector,
        0, '',
        0, '',
      ].join('\u0000')
      const expected = `persist:tab-app-${referenceSha256(encodedTuple).slice(0, 32)}`
      expect(tabAppPartitionForScope({
        accountId: vector,
        productSpaceId: '',
        workspaceId: '',
      })).toBe(expected)
    }
  })

  it('separates every account, ProductSpace, and Workspace tuple', () => {
    const base = { accountId: 'account-a', productSpaceId: 'space-a', workspaceId: 'ws-1' }
    const variants = [
      { ...base },
      { ...base, workspaceId: 'ws-2' },
      { ...base, accountId: 'account-b' },
      { ...base, productSpaceId: 'space-b' },
      // Unambiguous even when fields merely concatenate into each other.
      { accountId: 'account-x1', productSpaceId: 'space-y', workspaceId: 'ws' },
      { accountId: 'account-x', productSpaceId: '1space-y', workspaceId: 'ws' },
    ]
    const partitions = variants.map(variant => tabAppPartitionForScope(variant))
    expect(new Set(partitions).size).toBe(partitions.length)
    for (const partition of partitions) {
      expect(partition).toMatch(/^persist:tab-app-[0-9a-f]{32}$/)
    }
  })

  it('stays collision-free for inputs the superseded 32-bit digest collapsed', () => {
    // Synthetic workspace IDs whose 32-bit FNV-1a digests collide — the
    // regression the old scheme failed. The SHA-256-based names must differ.
    const collisions: Array<[string, string]> = []
    const seen = new Map<string, string>()
    for (let index = 0; collisions.length === 0 && index < 500_000; index += 1) {
      const workspaceId = `ws-collision-probe-${index}`
      let hash = 0x811c9dc5
      for (let position = 0; position < workspaceId.length; position += 1) {
        hash ^= workspaceId.charCodeAt(position)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      const digest = hash.toString(36)
      const previous = seen.get(digest)
      if (previous !== undefined) {
        collisions.push([previous, workspaceId])
      } else {
        seen.set(digest, workspaceId)
      }
    }
    expect(collisions).toHaveLength(1)
    const [left, right] = collisions[0]!
    const leftPartition = tabAppPartitionForScope({ accountId: 'account-a', productSpaceId: 'space-a', workspaceId: left })
    const rightPartition = tabAppPartitionForScope({ accountId: 'account-a', productSpaceId: 'space-a', workspaceId: right })
    expect(leftPartition).not.toBe(rightPartition)
  })

  it('derives the superseded legacy partition name for cleanup', () => {
    const legacy = legacyTabAppPartitionForScope({ accountId: 'account-a', productSpaceId: 'space-a' })
    expect(legacy).toMatch(new RegExp(`^${LEGACY_TAB_APP_PARTITION_PREFIX.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}[a-z0-9]+$`))
    // The legacy name ignores the workspace dimension (the flaw that was
    // fixed) and differs from every current partition.
    expect(legacy).not.toBe(tabAppPartitionForScope({ accountId: 'account-a', productSpaceId: 'space-a', workspaceId: 'ws-1' }))
  })
})
