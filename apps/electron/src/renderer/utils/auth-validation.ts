/**
 * Shared authentication validation utilities
 * Used by both CredentialRequest and AuthRequestCard components
 */

import { i18n } from '@polo-ai/shared/i18n'

/**
 * Validate basic auth credentials based on whether password is required
 *
 * @param username - The username/API key value
 * @param password - The password value
 * @param passwordRequired - Whether password field is required (defaults to true for backward compatibility)
 * @returns true if credentials are valid, false otherwise
 */
export function validateBasicAuthCredentials(
  username: string,
  password: string,
  passwordRequired: boolean = true
): boolean {
  const hasUsername = username.trim().length > 0
  const hasPassword = password.trim().length > 0

  return passwordRequired
    ? hasUsername && hasPassword  // Both required
    : hasUsername                  // Only username required
}

/**
 * Get the password value to submit based on whether it's required
 * When password is not required, always submit empty string regardless of field content
 *
 * @param password - The password field value
 * @param passwordRequired - Whether password is required
 * @returns The password value to submit (trimmed or empty string)
 */
export function getPasswordValue(
  password: string,
  passwordRequired: boolean = true
): string {
  return passwordRequired ? password.trim() : ''
}

/**
 * Resolve display copy with the historical English string as the floor.
 *
 * POO-179: i18next returns undefined when called before `setupI18n` (unit
 * tests, early module evaluation); the English fallback keeps those callers
 * byte-identical to the pre-localization output.
 */
function translateOr(key: string, fallback: string, options?: Record<string, unknown>): string {
  const translated = i18n.t(key, { ...options, defaultValue: fallback })
  return typeof translated === 'string' ? translated : fallback
}

/**
 * Get the password label with optional suffix
 *
 * POO-179: the "optional" suffix is display copy, resolved at call time.
 * Validation/submit behavior is unchanged.
 *
 * @param baseLabel - The base label (e.g., "Password")
 * @param passwordRequired - Whether password is required
 * @returns The label with the localized " (optional)" suffix if not required
 */
export function getPasswordLabel(
  baseLabel: string,
  passwordRequired: boolean = true
): string {
  return passwordRequired
    ? baseLabel
    : translateOr('auth.optionalField', `${baseLabel} (optional)`, { field: baseLabel })
}

/**
 * Get the password placeholder text
 *
 * POO-179: placeholder templates are display copy, resolved at call time.
 *
 * @param baseLabel - The base label (e.g., "Password")
 * @param passwordRequired - Whether password is required
 * @returns Appropriate placeholder text
 */
export function getPasswordPlaceholder(
  baseLabel: string,
  passwordRequired: boolean = true
): string {
  return passwordRequired
    ? translateOr('auth.enterField', `Enter ${baseLabel.toLowerCase()}`, {
        field: baseLabel.toLowerCase(),
      })
    : translateOr('auth.optionalLeaveBlank', 'Optional - leave blank')
}
