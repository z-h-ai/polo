import { sha256HexFromUtf8 } from './sha256'

/**
 * Shared derivation of the ProductSpace-scoped session partition for tab
 * webapps. The renderer (TabShellContext) and the Main process
 * (webview-security) MUST compute the identical name: Main re-derives the
 * partition from its own trusted state (Admin account + committed fence +
 * window workspace) and enforces it at `will-attach-webview` — the renderer
 * never reports the partition itself.
 *
 * The digest is a full SHA-256 (truncated to 128 bits, hex). Persistence
 * isolation is an identity guarantee: a collision would make two different
 * account+ProductSpace+Workspace tuples share cookies and storage, so the
 * earlier 32-bit FNV-1a scheme was replaced after a demonstrable collision
 * between distinct synthetic workspace IDs. `legacyTabAppPartitionForScope`
 * reproduces the superseded name purely so Main can clear the orphaned
 * storage once.
 */

export const TAB_APP_PARTITION_PREFIX = 'persist:tab-app-'

/**
 * The superseded 425e90a1 naming, reproduced EXACTLY (same 32-bit FNV-1a
 * variant, same `JSON.stringify` triple input, same base36 encoding, same
 * prefix) so the orphaned storage of every workspace of a tuple can be
 * located and cleared once. Kept for cleanup only.
 */
export function legacyTabAppPartitionForScope(input: {
  accountId: string
  productSpaceId: string
  workspaceId: string
}): string {
  let hash = 0x811c9dc5
  const inputString = JSON.stringify([
    input.accountId,
    input.productSpaceId,
    input.workspaceId,
  ])
  for (let index = 0; index < inputString.length; index += 1) {
    hash ^= inputString.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `persist:tab-app-${hash.toString(36).padStart(7, '0')}`
}

/**
 * The scoped partition for one account+ProductSpace+Workspace tuple: the
 * SHA-256 digest is truncated to 128 bits — a 2^-128 collision bound for
 * the identity tuples, so two different tuples never share cookies/storage.
 */
export function tabAppPartitionForScope(input: {
  accountId: string
  productSpaceId: string
  workspaceId: string
}): string {
  // Length-prefixed fields make the encoding unambiguous.
  const encoded = [
    input.accountId.length, input.accountId,
    input.productSpaceId.length, input.productSpaceId,
    input.workspaceId.length, input.workspaceId,
  ].join('\u0000')
  return `${TAB_APP_PARTITION_PREFIX}${sha256HexFromUtf8(encoded).slice(0, 32)}`
}

/** Matches every scoped tab-app partition (never the assistant pane one). */
export function isTabAppPartition(partition: string | undefined | null): boolean {
  return typeof partition === 'string' && partition.startsWith(TAB_APP_PARTITION_PREFIX)
}
