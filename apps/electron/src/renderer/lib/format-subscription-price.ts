/**
 * Minor-unit subscription price rendering. The member-circle and original-order
 * DTOs both store 2-exponent currency minors; null/negative amounts or a
 * missing currency render empty so callers can show their explicit
 * no-amount state instead of fabricating a number.
 */
export function formatSubscriptionPrice(
  amountMinor: number | null,
  currency: string | null,
  locale?: string,
): string {
  if (amountMinor === null || amountMinor < 0 || !currency) return ''
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).format(amountMinor / 100)
  } catch {
    return `${amountMinor / 100} ${currency}`
  }
}
