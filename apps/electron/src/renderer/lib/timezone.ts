/**
 * Timezone input helpers
 *
 * The Preferences page stores a free-text timezone (IANA "Area/City" style)
 * in ~/.polo-ai/preferences.json. These helpers validate that input so users
 * get an inline hint on typos instead of silently saving a broken value.
 *
 * Validation is deliberately forgiving: anything the platform's Intl layer
 * accepts as a timezone counts as valid (including canonical names, aliases
 * like "UTC"/"PRC" and offsets like "Etc/GMT+8"), while obvious typos
 * ("Asia/Shanghia") are rejected.
 */

/**
 * Loosely-shaped timezone candidates: letters/digits/_/-/+ and optional
 * "/segment" parts. This only filters obviously broken input (spaces, CJK,
 * punctuation) — the authoritative check is the Intl lookup below.
 */
const TIMEZONE_SHAPE_RE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/

/**
 * Check whether a user-typed timezone value is usable.
 *
 * @param value raw input value (whitespace is trimmed first)
 * @returns true when empty (the field is optional) or when the platform
 *          recognizes the value as a timezone; false for typos/bad formats.
 */
export function isValidTimezoneInput(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return true
  if (!TIMEZONE_SHAPE_RE.test(trimmed)) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed })
    return true
  } catch {
    return false
  }
}
