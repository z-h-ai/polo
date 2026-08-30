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
