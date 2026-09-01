/**
 * The ProductSpace runtime derives the executing account from the trusted
 * Admin session, never from RPC arguments. The admin handler module installs
 * the provider because only it owns the Admin session coordinator.
 */
export type TrustedProductSpaceAccountProvider = () => Promise<string | null>

let provider: TrustedProductSpaceAccountProvider | null = null

export function setTrustedProductSpaceAccountProvider(
  next: TrustedProductSpaceAccountProvider,
): void {
  provider = next
}

export async function resolveTrustedProductSpaceAccountId(): Promise<string | null> {
  if (!provider) return null
  try {
    return await provider()
  } catch {
    return null
  }
}

export interface TrustedProductSpaceListSnapshot {
  personalProductSpaceId: string
  productSpaces: Array<{
    id: string
    kind: 'personal' | 'enterprise'
    name: string
    accessMode: 'active' | 'read_only'
  }>
}

export type TrustedProductSpaceListFetcher = () => Promise<TrustedProductSpaceListSnapshot | null>

let listFetcher: TrustedProductSpaceListFetcher | null = null

/**
 * Fetches the account's visible ProductSpaces from the trusted Admin API
 * (contract-validated). Installed by the admin handler module; used by the
 * Main-side switch transaction to verify the target space.
 */
export function setTrustedProductSpaceListFetcher(next: TrustedProductSpaceListFetcher): void {
  listFetcher = next
}

export async function fetchTrustedProductSpaceList(): Promise<TrustedProductSpaceListSnapshot | null> {
  if (!listFetcher) return null
  try {
    return await listFetcher()
  } catch {
    return null
  }
}

/**
 * A synchronous, Main-trusted mirror of the currently authenticated Admin
 * account, maintained by the Admin session lifecycle — set when a login
 * commits its tokens, cleared when an ended session deletes them. It is
 * deliberately independent of the runtime fence: revoking the fence (contract
 * loss, logout's revoke step, startup re-bootstrap) clears the fence AND the
 * fence account while the Admin session stays authenticated, so consumers
 * that must decide synchronously — the webview attach gate — can
 * distinguish a genuinely signed-out window from a signed-in one whose
 * ProductSpace scope is momentarily gone. Fail-closed by construction: when
 * unsure, callers treat "authenticated" as present.
 */
let syncAuthenticatedAccountId: string | null = null

export function setSyncTrustedProductSpaceAccountId(accountId: string | null): void {
  syncAuthenticatedAccountId = accountId
}

export function getSyncTrustedProductSpaceAccountId(): string | null {
  return syncAuthenticatedAccountId
}
