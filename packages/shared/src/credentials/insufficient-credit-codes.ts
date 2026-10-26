/** One classification list for "payer lacks allowance" across every billing
 * backend: the admin runtime (insufficient_credit/quota_exhausted/
 * budget_exhausted), the legacy gateway spellings (insufficient_quota/
 * budget_exceeded/INSUFFICIENT_BALANCE). Every surface must classify through
 * this list so the local proxy and the CLI broker cannot drift apart again. */
export const INSUFFICIENT_CREDIT_ERROR_CODES: readonly string[] = [
  'insufficient_credit',
  'insufficient_quota',
  'quota_exhausted',
  'budget_exceeded',
  'budget_exhausted',
  'INSUFFICIENT_BALANCE',
]

export function isInsufficientCreditCode(code: string | undefined | null): boolean {
  return code !== undefined && code !== null && INSUFFICIENT_CREDIT_ERROR_CODES.includes(code)
}
