/** Test-only wire payload from Polo Admin client-connection.ts:95-97 (2026-10-16).
 * Consumers must preserve the custom route; only endpoint/space/models vary offline. */
export function adminNewApiConnection(productSpaceId: string, baseUrl: string, modelIds = ['test-model']) {
  return {
    slug: `polo-space-${productSpaceId}`, name: 'Polo 算力',
    providerType: 'pi_compat' as const, authType: 'api_key_with_endpoint' as const,
    baseUrl, customEndpoint: { api: 'openai-completions' as const },
    apiKey: 'fixture-upstream-key',
    models: modelIds.map(id => ({ id, name: id })), defaultModel: modelIds[0]!,
  }
}
