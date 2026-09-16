/**
 * Collision-free identity for an account-scoped organization context.
 *
 * Admin entity IDs may contain delimiters (including NUL), Unicode, and up to
 * 512 characters. A JSON tuple preserves both field boundaries and the exact
 * original values, unlike delimiter concatenation.
 */
export function createOrganizationContextKey(
  accountId: string,
  organizationId: string,
): string {
  return JSON.stringify([accountId, organizationId])
}
