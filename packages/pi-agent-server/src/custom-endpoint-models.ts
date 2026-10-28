export type CustomEndpointInput = 'text' | 'image'

export interface CustomEndpointModelDefaults {
  supportsImages?: boolean
}

export interface CustomEndpointModelOverrides {
  contextWindow?: number
  supportsImages?: boolean
}

export interface CustomEndpointModelEntry extends CustomEndpointModelOverrides {
  id: string
}

export type CustomEndpointModelConfig = string | {
  id: string
  contextWindow?: number
  supportsImages?: boolean
}

/** Strip bare model IDs (remove pi/ prefix if present). */
export function stripPiPrefix(id: string): string {
  return id.startsWith('pi/') ? id.slice(3) : id
}

/** polo-side output limits for custom-endpoint models absent from the sealed pi-ai catalog
 *  (which has no registration extension point and rejects unlisted catalog-route ids).
 *  Values mirror vendor-documented ceilings — the GLM-5.2/5.3 families are listed at 128K
 *  in ZCode's builtin catalog and the upstream endpoint accepts max_tokens=131072 (probed).
 *  Exact-id lookup first, then the longest `base-` prefix so configured variants like
 *  "glm-5.3-flash-0203" resolve to their family entry. */
const SUPPLEMENTAL_OUTPUT_LIMITS: Readonly<Record<string, number>> = {
  'glm-5.2': 131_072,
  'glm-5.3': 131_072,
  'glm-5.3-flash': 131_072,
}
export function supplementalOutputLimit(modelId: string): number | undefined {
  const bare = stripPiPrefix(modelId)
  const exact = SUPPLEMENTAL_OUTPUT_LIMITS[bare]
  if (exact !== undefined) return exact
  let best: string | undefined
  for (const base of Object.keys(SUPPLEMENTAL_OUTPUT_LIMITS)) {
    if (bare.startsWith(`${base}-`) && (best === undefined || base.length > best.length)) best = base
  }
  return best === undefined ? undefined : SUPPLEMENTAL_OUTPUT_LIMITS[best]
}

/**
 * Normalize a user-configured custom endpoint model for Pi SDK registration.
 *
 * Keep explicit per-model capability overrides intact. In particular,
 * `supportsImages: false` is meaningful because it can override a global
 * endpoint default of `supportsImages: true` for text-only models.
 */
export function normalizeCustomEndpointModelEntry(model: CustomEndpointModelConfig): CustomEndpointModelEntry {
  if (typeof model === 'string') {
    return { id: stripPiPrefix(model) }
  }

  return {
    id: stripPiPrefix(model.id),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.supportsImages !== undefined ? { supportsImages: model.supportsImages } : {}),
  }
}

/**
 * Build a synthetic model definition for a custom endpoint.
 * Uses reasonable defaults for context window and max tokens since we can't
 * query the endpoint for its actual capabilities. Image support must be
 * explicitly enabled either at the connection level or per-model.
 */
export function buildCustomEndpointModelDef(
  id: string,
  defaults?: CustomEndpointModelDefaults,
  overrides?: CustomEndpointModelOverrides,
) {
  const supportsImages = overrides?.supportsImages ?? defaults?.supportsImages ?? false
  const input: CustomEndpointInput[] = supportsImages ? ['text', 'image'] : ['text']

  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: overrides?.contextWindow ?? 131_072,
    maxTokens: 8_192,
  }
}
