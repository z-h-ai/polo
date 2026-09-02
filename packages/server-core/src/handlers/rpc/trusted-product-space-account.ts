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

export type TrustedProductSpaceListFetcher = () => Promise<TrustedProductSpaceListResult>

/**
 * The failure mode of the trusted list fetch is part of the switch contract:
 * a transient outage (`service_unavailable`) may keep the current view, but a
 * server speaking an incompatible ProductSpace contract
 * (`product_space_contract_unsupported`) must reach the switch transaction
 * verbatim so every stage fails closed into contract-blocked instead of
 * masquerading as a retryable outage.
 */
export type TrustedProductSpaceListErrorCode =
  | 'service_unavailable'
  | 'product_space_contract_unsupported'

export type TrustedProductSpaceListResult =
  | { ok: true; list: TrustedProductSpaceListSnapshot }
  | { ok: false; errorCode: TrustedProductSpaceListErrorCode }

let listFetcher: TrustedProductSpaceListFetcher | null = null

/**
 * Installs the trusted list fetcher. The installed implementation classifies
 * its own failures into the typed result — the contract-incompatibility code
 * must survive into the switch transaction.
 */
export function setTrustedProductSpaceListFetcher(next: TrustedProductSpaceListFetcher): void {
  listFetcher = next
}

/**
 * Fetches the account's visible ProductSpaces from the trusted Admin API
 * (contract-validated). Installed by the admin handler module; used by the
 * Main-side switch transaction to verify the target space.
 */
export async function fetchTrustedProductSpaceList(): Promise<TrustedProductSpaceListResult> {
  if (!listFetcher) return { ok: false, errorCode: 'service_unavailable' }
  try {
    return await listFetcher()
  } catch {
    // A throwing fetcher is a broken installation, not a contract signal.
    return { ok: false, errorCode: 'service_unavailable' }
  }
}

/**
 * A synchronous, Main-trusted mirror of the authenticated Admin account,
 * maintained by the Admin session lifecycle — set when a login commits its
 * tokens or a startup credential restore resolves, cleared when an ended
 * session deletes them. It is deliberately independent of the runtime
 * fence: revoking the fence (contract loss, logout's revoke step, startup
 * re-bootstrap) clears the fence AND the fence account while the Admin
 * session stays authenticated, so consumers that must decide synchronously
 * — the webview attach gate — can distinguish a genuinely signed-out
 * window from a signed-in one whose ProductSpace scope is momentarily gone.
 *
 * The mirror starts in `unknown`: process start has not yet read the
 * persisted credentials, so neither "signed in" nor "signed out" is known.
 * Sync gates must treat `unknown` as fail-closed. The first trusted
 * credential restore (or a login) moves it to `authenticated` / `signed_out`.
 */
export type SyncTrustedProductSpaceAccountState =
  | { status: 'unknown' }
  | { status: 'signed_out' }
  | { status: 'authenticated'; accountId: string }

let syncAccountState: SyncTrustedProductSpaceAccountState = { status: 'unknown' }

export function setSyncTrustedProductSpaceAccountState(
  state: SyncTrustedProductSpaceAccountState,
): void {
  bumpTrustedAccountGenerationOnTransition(
    state.status === 'authenticated' ? state.accountId : null,
  )
  syncAccountState = state
}

/**
 * Commits a resolved account: a non-null id is `authenticated`, null is the
 * explicitly confirmed `signed_out` (never `unknown`).
 */
export function setSyncTrustedProductSpaceAccountId(accountId: string | null): void {
  bumpTrustedAccountGenerationOnTransition(accountId)
  syncAccountState = accountId
    ? { status: 'authenticated', accountId }
    : { status: 'signed_out' }
}

/**
 * Monotonic lock-free account-transition epoch. The transition owner
 * (account replacement / logout) advances it SYNCHRONOUSLY before its first
 * cleanup await — before any execution enumeration or fence revoke — so
 * in-flight execution starts that captured the previous epoch fail closed
 * even while the synchronous mirror still shows the old account and the
 * fence revoke is still queued behind the switch lock. The epoch never
 * advances backwards: an aborted transition leaves it high, which keeps
 * stale starts refused while fresh starts simply capture the new epoch —
 * no transition state can get stuck and no stale start is ever reopened.
 */
let accountTransitionEpoch = 0

export function beginAccountTransition(): number {
  return ++accountTransitionEpoch
}

export function getAccountTransitionEpoch(): number {
  return accountTransitionEpoch
}

/**
 * Monotonic generation of the trusted Admin account binding. It advances on
 * every account TRANSITION (login, logout, account replacement — never on a
 * same-account token refresh capture). Switch transactions capture it around
 * their contract-list fetch so the short final critical section can prove
 * the fetched list still belongs to the current trusted account WITHOUT
 * acquiring the Admin session lock under the switch lock.
 */
let trustedAccountGeneration = 0

export function getTrustedAccountGeneration(): number {
  return trustedAccountGeneration
}

function bumpTrustedAccountGenerationOnTransition(nextAccountId: string | null): void {
  if (getSyncTrustedProductSpaceAccountId() !== nextAccountId) {
    trustedAccountGeneration += 1
  }
}

export function getSyncTrustedProductSpaceAccountState(): SyncTrustedProductSpaceAccountState {
  return syncAccountState
}

export function getSyncTrustedProductSpaceAccountId(): string | null {
  return syncAccountState.status === 'authenticated' ? syncAccountState.accountId : null
}
