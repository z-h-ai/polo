/**
 * Remote web_app artifact policy (POO-102).
 *
 * The org-level `/api/artifact-policies/web_app` endpoint carries the
 * platform's web_app (Generative UI canvas) bundle policy. The desktop caches
 * it synchronously — following the exact pattern of generative-ui.ts — because
 * both consumers need synchronous reads:
 *
 * - tool registration (generate_app must not register while
 *   `enabled: false`),
 * - the pin gate (a bundle above `maxBundleBytes` is refused at
 *   genui.AUDIT_APP_PIN).
 *
 * Semantics mirror the remote Generative UI toggle: no policy ever received
 * (or a failed best-effort refresh, which keeps the previous cache) reads as
 * the permissive default — enabled, bounded by the local
 * HARD_WEBAPP_BUNDLE_POLICY. The remote policy can only tighten; every cached
 * value passes through clampWebAppArtifactPolicy, and a response above the
 * local hard caps fails validation there and clamps to a disabled state
 * (fail-closed).
 */

import {
  clampWebAppArtifactPolicy,
} from '../creator-skills/schemas.ts'
import { HARD_WEBAPP_BUNDLE_POLICY } from '../creator-skills/types.ts'

export interface WebAppArtifactPolicyState {
  enabled: boolean
  maxBundleBytes: number
  maxFileCount: number
}

/** Permissive default when no remote policy has ever been received. */
const DEFAULT_WEB_APP_POLICY: WebAppArtifactPolicyState = {
  enabled: true,
  maxBundleBytes: HARD_WEBAPP_BUNDLE_POLICY.maxBundleBytes,
  maxFileCount: HARD_WEBAPP_BUNDLE_POLICY.maxFileCount,
}

let cachedPolicy: WebAppArtifactPolicyState | undefined

/**
 * Update the cached policy. The input is clamped through
 * clampWebAppArtifactPolicy, so an above-hard-cap or malformed response can
 * never loosen the local ceiling (it disables instead). Callers refreshing
 * best-effort simply skip this call when the fetch fails, keeping the
 * previous cache.
 */
export function setWebAppArtifactPolicy(
  policy: { enabled: boolean; maxBundleBytes: number; maxFileCount: number } | undefined | null,
): void {
  cachedPolicy = policy ? clampWebAppArtifactPolicy(policy) : undefined
}

/** The effective policy: last clamped remote value, else the default. */
export function getWebAppArtifactPolicyState(): WebAppArtifactPolicyState {
  return cachedPolicy ?? DEFAULT_WEB_APP_POLICY
}

/** True unless the server explicitly sent `enabled: false` (or an invalid policy). */
export function isWebAppArtifactPolicyEnabled(): boolean {
  return getWebAppArtifactPolicyState().enabled
}
