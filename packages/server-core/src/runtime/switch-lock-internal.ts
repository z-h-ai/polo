/**
 * INTERNAL switch mutex + test observation seam.
 *
 * This module is deliberately NOT listed in the package `exports` map:
 * only in-package source (relative imports) can reach it. Public package
 * consumers of `./runtime/product-space-executions` get the purpose-scoped
 * mutex runner (`runUnderSwitchMutex`) but never the labeled scheduler or
 * its observation registry.
 *
 * Tokens are STRUCTURED identities (typed objects discriminated by
 * `phase`) — never arbitrary strings. They are purely observational for
 * tests; they do not alter lock semantics and carry no capability.
 */
export type CatalogAuthorityCommitToken = {
  phase: 'catalog-authority-commit'
  accountId: string
  productSpaceId: string
  invocation: number
}
export type CatalogAuthorityRevokeToken = {
  phase: 'catalog-authority-revoke'
  accountId: string
  productSpaceId: string
  invocation: number
}
export type RuntimePublicMutexToken = { phase: 'runtime-public-mutex' }
export type RuntimeRevokeFenceToken = { phase: 'runtime-revoke-fence' }
export type RuntimeRevokeFenceIfBoundToken = { phase: 'runtime-revoke-fence-if-bound' }
export type ProductSpaceSwitchToken = { phase: 'product-space-switch'; productSpaceId: string }
export type ProductSpaceListFetchToken = { phase: 'product-space-list-fetch' }
export type ProductSpaceFinalizeToken = { phase: 'product-space-finalize' }
export type ProductSpaceRestoreOfflineToken = { phase: 'product-space-restore-offline' }
export type AssistantSwitchToken = { phase: 'assistant-switch'; productSpaceId: string }

export function productSpaceSwitchToken(productSpaceId: string): ProductSpaceSwitchToken {
  return { phase: 'product-space-switch', productSpaceId }
}
export type TestHolderToken = { phase: 'test-holder' }
export type TestThrowingToken = { phase: 'test-throwing' }
export type GenericSwitchToken = { phase: 'generic-switch' }

export type SwitchLockToken =
  | GenericSwitchToken
  | CatalogAuthorityCommitToken
  | CatalogAuthorityRevokeToken
  | RuntimePublicMutexToken
  | RuntimeRevokeFenceToken
  | RuntimeRevokeFenceIfBoundToken
  | ProductSpaceSwitchToken
  | ProductSpaceListFetchToken
  | ProductSpaceFinalizeToken
  | ProductSpaceRestoreOfflineToken
  | AssistantSwitchToken
  | TestHolderToken
  | TestThrowingToken

export interface SwitchLockEvent {
  seq: number
  token: SwitchLockToken
}

const log: SwitchLockEvent[] = []
let seq = 0
let pending = 0

let switchLockTail: Promise<unknown> = Promise.resolve()

/**
 * Production mutex: strictly serializes queued tasks (FIFO). The token is a
 * structured observational identity — it does not alter lock semantics.
 */
export async function withSwitchLock<T>(
  operation: () => Promise<T>,
  token: SwitchLockToken = { phase: 'generic-switch' },
): Promise<T> {
  const previous = switchLockTail
  let release!: () => void
  switchLockTail = new Promise<void>(resolve => {
    release = resolve
  })
  pending += 1
  const event = { seq: ++seq, token }
  log.push(event)
  await previous.catch(() => {})
  try {
    return await operation()
  } finally {
    pending -= 1
    const done = log.findIndex(entry => entry.seq === event.seq)
    if (done !== -1) log.splice(done, 1)
    release()
  }
}

/** Test-observable queue depth (waiting + running). */
export function pendingSwitchLockTasks(): number {
  return pending
}

/**
 * Test-observable enqueue/settle token registry. Returns DEEP COPIES of the
 * structured tokens — the internal registry is never exposed by reference.
 */
export function switchLockEventLog(): SwitchLockEvent[] {
  return log.map(entry => ({
    seq: entry.seq,
    token: JSON.parse(JSON.stringify(entry.token)) as SwitchLockToken,
  }))
}
