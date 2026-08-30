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
