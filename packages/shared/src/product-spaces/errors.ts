export const PRODUCT_SPACE_ERROR_CODES = [
  'validation_error',
  'unauthorized',
  'token_revoked',
  'account_disabled',
  'staff_account_not_allowed',
  'product_space_restricted',
  'personal_space_preparing',
  'product_space_not_found',
  'catalog_entry_not_found',
  'catalog_entry_unavailable',
  'skill_not_enabled',
  'version_blocked',
  'usage_limit_reached',
  'service_unavailable',
] as const

export type ProductSpaceErrorCode = typeof PRODUCT_SPACE_ERROR_CODES[number]

/** Local-only failures must never be presented as successful server auth. */
export const PRODUCT_SPACE_RUNTIME_ERROR_PREFIX = 'runtime_' as const
