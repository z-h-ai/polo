/**
 * Journey #1 — formats the SERVER-provided quota reset fact for the banner.
 * Only ever called with a reset epoch the server actually sent; the banner
 * renders no reset copy without one.
 */
export function formatQuotaResetTime(resetAt: number, resolvedLanguage: string | undefined): string {
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) return String(resetAt)
  try {
    return new Intl.DateTimeFormat(resolvedLanguage || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date)
  } catch {
    return date.toLocaleString()
  }
}
