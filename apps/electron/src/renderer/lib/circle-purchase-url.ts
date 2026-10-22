/**
 * Circle purchase-URL handoff gate (POO-70 C6 / POO-95; P70-SUBSCRIPTION-02).
 *
 * The renewal handoff opens ONE kind of URL in the system browser: the
 * creator-domain purchase path (`/c/{shareId}` plus approved query), resolved
 * by the trusted C1 bridge against the confirmed Admin origin. This module is
 * the RENDERER-SIDE fail-closed gate that runs AGAIN on the C2
 * `resolvedPurchaseUrl` right before `electronAPI.openUrl` — defense in
 * depth: the desktop never opens a URL the renderer itself has not verified,
 * even when the main process already resolved it.
 *
 * Rules (card implementation order item 2, all fail closed):
 * - Only `http:`/`https:` survive; `javascript:`/`data:`/custom schemes are
 *   invalid (rejected before any origin comparison).
 * - The URL's origin must equal the CONTROLLED creator origin — a cross
 *   origin is untrusted. Relative paths are resolved against that same
 *   controlled origin.
 * - Embedded credentials (`user:pass@host`) are rejected.
 * - Only the approved path shape `/c/{shareId}` (one non-empty segment) and
 *   approved query keys are allowed; any other path or query key is invalid.
 *
 * On any rejection the raw provider value is kept untouched in the result —
 * the display keeps its circle/membership/order facts and the original
 * receipt, so failure never destroys the user's recovery candidates
 * (P70-SUBSCRIPTION-03). No order is ever created here and no payment SDK
 * exists on this surface; the browser page owns the actual payment.
 */
// C9/POO-100 integration fix (one-line, owner C6/POO-95 notified via the
// assembly commit): DEEP import instead of the `@polo-ai/shared/admin`
// barrel. The barrel re-exports main-only modules (node:crypto/fs), which
// breaks the renderer build the moment this panel enters the Vite module
// graph — the same deep-import convention the renderer already uses
// (admin/schemas, admin/authorization, admin/catalog-view).
import { resolveMemberCirclePurchaseUrl } from '@polo-ai/shared/admin/member-circles'

/**
 * The controlled creator origin (POL-112 target domain). Both C1's main-side
 * resolution and this renderer gate must agree on it; a mismatch fails
 * closed instead of being bridged over.
 */
export const CIRCLE_PURCHASE_CONTROLLED_ORIGIN = 'https://creator.polo.z-h-ai.com'

/**
 * Approved query keys on the `/c/{shareId}` purchase path. Today's contract
 * carries exactly one marker, `renew=1` (F1). Any unknown key fails closed —
 * the provider cannot smuggle extra parameters past the desktop.
 */
export const APPROVED_PURCHASE_QUERY_KEYS: ReadonlySet<string> = new Set(['renew'])

export type CirclePurchaseUrlResolution =
  | { ok: true; url: string }
  | { ok: false; reason: 'invalid_purchase_url' | 'untrusted_purchase_url_origin' }

/** `/c/{shareId}` — the only approved path shape; one non-empty segment. */
const APPROVED_PURCHASE_PATH = /^\/c\/[^/]+\/?$/

/**
 * Renderer-side gate over an ALREADY-RESOLVED absolute purchase URL (the C2
 * `resolvedPurchaseUrl`). Protocol, origin, credentials, path shape and
 * query keys are all re-verified; anything unexpected fails closed.
 */
export function isApprovedResolvedPurchaseUrl(
  resolvedUrl: string,
  controlledOrigin: string = CIRCLE_PURCHASE_CONTROLLED_ORIGIN,
): boolean {
  let parsed: URL
  try {
    parsed = new URL(resolvedUrl)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false
  if (parsed.username !== '' || parsed.password !== '') return false
  if (parsed.origin !== controlledOrigin) return false
  if (!APPROVED_PURCHASE_PATH.test(parsed.pathname)) return false
  for (const key of parsed.searchParams.keys()) {
    if (!APPROVED_PURCHASE_QUERY_KEYS.has(key)) return false
  }
  return true
}

/**
 * Full renderer-side resolution for the raw provider `purchaseUrl`
 * (e.g. `/c/{shareId}?renew=1`). Reuses the shared resolver for protocol +
 * origin (the same code C1 runs main-side), then applies the renderer-only
 * path/query/credential approval on top. The raw input is never mutated and
 * never returned as openable.
 */
export function resolveCirclePurchaseUrl(
  purchaseUrl: string,
  controlledOrigin: string = CIRCLE_PURCHASE_CONTROLLED_ORIGIN,
): CirclePurchaseUrlResolution {
  // Shared gate: protocol + same-origin (relative paths resolve against the
  // controlled origin). Its reasons are propagated verbatim.
  const shared = resolveMemberCirclePurchaseUrl(purchaseUrl, controlledOrigin)
  if (!shared.ok) return shared
  if (!isApprovedResolvedPurchaseUrl(shared.url, controlledOrigin)) {
    return { ok: false, reason: 'invalid_purchase_url' }
  }
  return { ok: true, url: shared.url }
}

// ---------------------------------------------------------------------------
// Renewal handoff selection (previewRenewal payload → open decision)
// ---------------------------------------------------------------------------

/** The subset of the C2 previewRenewal success payload this gate consumes. */
export interface CirclePurchaseHandoffPayload {
  purchaseUrl: string
  resolvedPurchaseUrl: string | null
  purchaseUrlResolutionError: 'invalid_purchase_url' | 'untrusted_purchase_url_origin' | null
}

export type CirclePurchaseHandoff =
  | { state: 'ready'; url: string }
  | {
    state: 'blocked'
    reason: 'invalid_purchase_url' | 'untrusted_purchase_url_origin'
    /** Raw provider value — kept for traceability, NEVER opened. */
    rawPurchaseUrl: string
  }

/**
 * Decides whether the renewal handoff may open the browser. The gate is
 * CONJUNCTIVE: the C2 payload must have resolved (its failure reason is the
 * authoritative main-side verdict) AND the renderer must independently
 * re-resolve the raw provider value through the full gate. Only a URL the
 * renderer itself verified is ever returned as openable. Price availability
 * is orthogonal — a null `priceMinor` never blocks the handoff (the browser
 * page remains the recovery entry), so it is not part of this decision.
 */
export function selectCirclePurchaseHandoff(
  payload: CirclePurchaseHandoffPayload,
  controlledOrigin: string = CIRCLE_PURCHASE_CONTROLLED_ORIGIN,
): CirclePurchaseHandoff {
  if (!payload.resolvedPurchaseUrl) {
    return {
      state: 'blocked',
      reason: payload.purchaseUrlResolutionError ?? 'invalid_purchase_url',
      rawPurchaseUrl: payload.purchaseUrl,
    }
  }
  const rendererResolution = resolveCirclePurchaseUrl(payload.purchaseUrl, controlledOrigin)
  if (!rendererResolution.ok) {
    return {
      state: 'blocked',
      reason: rendererResolution.reason,
      rawPurchaseUrl: payload.purchaseUrl,
    }
  }
  return { state: 'ready', url: rendererResolution.url }
}
