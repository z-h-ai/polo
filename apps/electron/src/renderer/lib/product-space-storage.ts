import {
  ListProductSpacesResponseSchema,
  createProductSpaceContextKey as createSharedProductSpaceContextKey,
} from '@polo-ai/shared/product-spaces'
import type {
  AccountId,
  ProductSpaceId,
  ProductSpaceSummary,
} from '@polo-ai/shared/product-spaces'
import type {
  ProductSpaceContextStorage,
  ProductSpaceLegacyCleanupLedgerPreference,
  VerifiedProductSpaceContextPreference,
} from '@polo-ai/shared/config/product-space-context'

const PRODUCT_SPACE_SCOPED_STORAGE_PREFIX = 'polo-product-space:v1:'

const activeProductSpaceIdsByAccount = new Map<string, string>()

export function resetProductSpaceStorageMemoryForTests(): void {
  activeProductSpaceIdsByAccount.clear()
}

function isActiveProductSpaceAvailable(space: ProductSpaceSummary): boolean {
  // A restricted enterprise space stays listed so its restriction reason can be
  // shown, but an unavailable selection must never be auto-restored.
  return space.accessMode === 'active'
}

export type VerifiedProductSpaceContext = VerifiedProductSpaceContextPreference

export function getStoredActiveProductSpaceId(accountId: string): string | null {
  return activeProductSpaceIdsByAccount.get(accountId) ?? null
}

export function setStoredActiveProductSpaceId(
  accountId: string,
  productSpaceId: string,
): void {
  activeProductSpaceIdsByAccount.set(accountId, productSpaceId)
}

export function clearStoredActiveProductSpaceId(accountId: string): void {
  activeProductSpaceIdsByAccount.delete(accountId)
}

function applyVerifiedActiveProductSpace(
  accountId: string,
  context: VerifiedProductSpaceContext | undefined,
): void {
  if (!context) return
  if (context.activeProductSpaceId) {
    setStoredActiveProductSpaceId(accountId, context.activeProductSpaceId)
    return
  }
  clearStoredActiveProductSpaceId(accountId)
}

function parseVerifiedProductSpaceContext(
  value: unknown,
): VerifiedProductSpaceContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parsed = value as Partial<VerifiedProductSpaceContext>
  const list = ListProductSpacesResponseSchema.safeParse(parsed.list)
  if (
    !list.success
    || (parsed.activeProductSpaceId !== null
      && typeof parsed.activeProductSpaceId !== 'string')
    || typeof parsed.verifiedAt !== 'number'
    || !Number.isInteger(parsed.verifiedAt)
    || parsed.verifiedAt < 0
  ) {
    return null
  }
  const activeProductSpaceId = parsed.activeProductSpaceId ?? null
  const trustedActive = activeProductSpaceId
    && list.data.productSpaces.some(space => (
      space.id === activeProductSpaceId && isActiveProductSpaceAvailable(space)
    ))
  if (activeProductSpaceId && !trustedActive) return null
  return {
    list: list.data,
    activeProductSpaceId: trustedActive ? activeProductSpaceId : null,
    verifiedAt: parsed.verifiedAt,
  }
}

function sanitizeProductSpaceContextStorage(
  value: ProductSpaceContextStorage | null,
): ProductSpaceContextStorage {
  const verifiedContext = parseVerifiedProductSpaceContext(value?.verifiedContext)
  return {
    ...(verifiedContext ? { verifiedContext } : {}),
  }
}

export async function getProductSpaceContextStorage(
  accountId: string,
): Promise<ProductSpaceContextStorage> {
  try {
    return sanitizeProductSpaceContextStorage(
      await window.electronAPI.getProductSpaceContextStorage(accountId),
    )
  } catch {
    // The live server list remains authoritative; an unreachable preference
    // store simply starts without a device-local selection.
    return {}
  }
}

export async function setVerifiedProductSpaceContext(
  accountId: string,
  list: unknown,
  activeProductSpaceId: string | null,
): Promise<void> {
  const verifiedContext = parseVerifiedProductSpaceContext({
    list,
    activeProductSpaceId,
    verifiedAt: Date.now(),
  })
  if (!verifiedContext) return
  await window.electronAPI.updateProductSpaceContextStorage(accountId, {
    verifiedContext,
  })
  applyVerifiedActiveProductSpace(accountId, verifiedContext)
}

export async function clearVerifiedProductSpaceContext(
  accountId: string,
): Promise<void> {
  await window.electronAPI.updateProductSpaceContextStorage(accountId, {
    verifiedContext: null,
  }).catch(() => {
    // The in-memory selection was already cleared by the caller.
  })
}

/**
 * The verifiable one-shot cleanup ledger. A cleanup is only recorded when the
 * runtime reported success for every step; anything else stays unrecorded so
 * the next bootstrap retries and keeps failing closed.
 */
export async function readLegacyCleanupLedger(
  accountId: string,
): Promise<ProductSpaceLegacyCleanupLedgerPreference | null> {
  try {
    const stored = await window.electronAPI.getProductSpaceContextStorage(accountId)
    const ledger = stored?.legacyCleanup ?? null
    if (ledger && Object.values(ledger.results).every(passed => passed)) {
      return ledger
    }
    return null
  } catch {
    return null
  }
}

export async function writeLegacyCleanupLedger(
  accountId: string,
  results: Record<string, boolean>,
): Promise<boolean> {
  const allPassed = Object.values(results).every(passed => passed)
  if (!allPassed) return false
  try {
    await window.electronAPI.updateProductSpaceContextStorage(accountId, {
      legacyCleanup: { completedAt: Date.now(), results },
    })
    return true
  } catch {
    return false
  }
}

export function createProductSpaceContextKey(
  accountId: string,
  productSpaceId: string,
): string {
  return createSharedProductSpaceContextKey(
    accountId as unknown as AccountId,
    productSpaceId as unknown as ProductSpaceId,
  )
}

export function createProductSpaceScopedStorageKey(
  accountId: string,
  productSpaceId: string,
  namespace: string,
): string {
  return `${PRODUCT_SPACE_SCOPED_STORAGE_PREFIX}${
    createProductSpaceContextKey(accountId, productSpaceId)
  }:${namespace}`
}

