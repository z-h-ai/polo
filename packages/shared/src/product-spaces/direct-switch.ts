/**
 * The only legacy state that may be cleared during the direct switch.
 * Workspace metadata and user exports are deliberately absent from this
 * interface, making it impossible for this helper to delete either.
 */
export interface LegacyOrganizationStateInvalidator {
  removeLegacyOrganizationAuthorizationCache(): void | Promise<void>
  removeLegacyOrganizationCatalogCache(): void | Promise<void>
  removeLegacyOrganizationInstallationStateCache(): void | Promise<void>
  removeLegacyOrganizationRuntimeCache(): void | Promise<void>
  removeLegacyOrganizationSkillEnablementCache(): void | Promise<void>
  removeLegacyOrganizationSessionIndex(): void | Promise<void>
}

export const LEGACY_ORGANIZATION_STATE_INVALIDATION_STEPS = [
  'authorization',
  'catalog',
  'installation-state',
  'runtime',
  'skill-enablement',
  'session-index',
] as const

/**
 * One-shot pre-release cleanup. It performs no ProductSpace inference and
 * never receives a Workspace or filesystem path, so legacy creator-space
 * state cannot be guessed into a personal ProductSpace.
 */
export async function invalidateLegacyOrganizationState(
  invalidator: LegacyOrganizationStateInvalidator,
): Promise<void> {
  await invalidator.removeLegacyOrganizationAuthorizationCache()
  await invalidator.removeLegacyOrganizationCatalogCache()
  await invalidator.removeLegacyOrganizationInstallationStateCache()
  await invalidator.removeLegacyOrganizationRuntimeCache()
  await invalidator.removeLegacyOrganizationSkillEnablementCache()
  await invalidator.removeLegacyOrganizationSessionIndex()
}
