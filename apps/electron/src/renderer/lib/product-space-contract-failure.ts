/**
 * The single global channel for ProductSpace contract incompatibility
 * (PC-F11). Any ProductSpace DTO consumer — space list, unified Catalog,
 * resolve-launch — reports `product_space_contract_unsupported` here instead
 * of degrading into a local load error; the App subscribes once and funnels
 * every report into the hook's contract-blocked transition, which revokes
 * the Main fence, clears all projections and renders the upgrade gate.
 */

export interface ProductSpaceContractFailure {
  errorCode: 'product_space_contract_unsupported'
  source: string
}

type Listener = (failure: ProductSpaceContractFailure) => void

const listeners = new Set<Listener>()

export function reportProductSpaceContractFailure(
  failure: ProductSpaceContractFailure,
): void {
  for (const listener of [...listeners]) {
    try {
      listener(failure)
    } catch {
      // A broken listener must not swallow the report.
    }
  }
}

export function subscribeToProductSpaceContractFailures(
  listener: Listener,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Classifies an admin/IPC error payload for the contract channel. */
export function isProductSpaceContractUnsupported(
  error: { errorCode?: string | null; code?: string | null } | null | undefined,
): boolean {
  return error?.errorCode === 'product_space_contract_unsupported'
    || error?.code === 'product_space_contract_unsupported'
}
