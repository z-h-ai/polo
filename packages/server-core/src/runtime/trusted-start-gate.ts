/**
 * Lock-free trusted-start gate shared by every execution start path
 * (Assistant send registration, Local App start). GLOBAL LOCK ORDER: the
 * gate is captured BEFORE the switch lock — capturing resolves the trusted
 * Admin account through the Admin session lock, which must never happen
 * while holding the switch lock (account replacement holds the Admin
 * session lock while revoking the fence through the switch lock).
 *
 * The recheck is pure in-memory: it proves the captured account is still
 * the current trusted account (synchronous mirror), that no account
 * transition began (transition epoch — published synchronously before a
 * replacement's first cleanup await), that the account binding generation
 * is unchanged, and that the committed runtime fence is still bound to the
 * gate's account. A concurrent account replacement therefore fails every
 * stale start closed.
 */
import {
  getAccountTransitionEpoch,
  getSyncTrustedProductSpaceAccountId,
  getTrustedAccountGeneration,
  resolveTrustedProductSpaceAccountId,
} from '../handlers/rpc/trusted-product-space-account'
import { isRuntimeFenceBoundToAccount } from './product-space-executions'

export interface TrustedStartGate {
  accountId: string
  accountGeneration: number
  transitionEpoch: number
}

export async function captureTrustedStartGate(): Promise<TrustedStartGate | null> {
  // The transition epoch must BRACKET account resolution (R31): read it
  // before and after the awaited resolution — a transition that began in
  // between makes the capture stale, and the capture refuses (fail-closed)
  // instead of presenting the new epoch as if it were fresh.
  const transitionEpochBefore = getAccountTransitionEpoch()
  const accountId = await resolveTrustedProductSpaceAccountId()
  if (!accountId) return null
  const transitionEpochAfter = getAccountTransitionEpoch()
  if (transitionEpochAfter !== transitionEpochBefore) return null
  return {
    accountId,
    accountGeneration: getTrustedAccountGeneration(),
    transitionEpoch: transitionEpochAfter,
  }
}

/**
 * True only when the captured gate is still fully authoritative: the same
 * trusted account in the synchronous mirror, unchanged account-binding
 * generation, no account transition begun, and the committed runtime fence
 * still bound to the gate's account.
 */
export function isTrustedStartGateCurrent(gate: TrustedStartGate): boolean {
  return (
    getSyncTrustedProductSpaceAccountId() === gate.accountId
    && getTrustedAccountGeneration() === gate.accountGeneration
    && getAccountTransitionEpoch() === gate.transitionEpoch
    && isRuntimeFenceBoundToAccount(gate.accountId)
  )
}
