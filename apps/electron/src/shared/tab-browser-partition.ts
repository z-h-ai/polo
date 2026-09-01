/**
 * Shared derivation of the ProductSpace-scoped session partition for tab
 * webapps. The renderer (TabShellContext) and the Main process
 * (webview-security) MUST compute the identical name: Main re-derives the
 * partition from its own trusted state (Admin account + committed fence +
 * window workspace) and installs the webview permission policy on it before
 * the guest navigates — the renderer never reports the partition itself.
 */

/** FNV-1a, collision-resistant enough for partition naming (32-bit). */
function stableHash(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0')
}

/**
 * The scoped partition for one account+ProductSpace+Workspace tuple. The
 * workspace id is part of the digest so two windows on different local
 * Workspaces never share webapp storage.
 */
export function tabAppPartitionForScope(input: {
  accountId: string
  productSpaceId: string
  workspaceId: string
}): string {
  const digest = stableHash(
    JSON.stringify([input.accountId, input.productSpaceId, input.workspaceId]),
  )
  return `persist:tab-app-${digest}`
}

/** Matches every scoped tab-app partition (never the assistant pane one). */
export function isTabAppPartition(partition: string | undefined | null): boolean {
  return typeof partition === 'string' && partition.startsWith('persist:tab-app-')
}
