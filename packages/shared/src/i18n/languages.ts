import { LOCALE_REGISTRY, type LanguageCode } from "./registry";

export type { LanguageCode } from "./registry";

export interface LanguageConfig {
  nativeName: string;
}

/** All supported language codes, derived from the locale registry. */
export const SUPPORTED_LANGUAGE_CODES: readonly LanguageCode[] = Object.keys(
  LOCALE_REGISTRY,
) as LanguageCode[];

/** Language display metadata, derived from the locale registry. */
export const LANGUAGES: Record<LanguageCode, LanguageConfig> =
  Object.fromEntries(
    Object.entries(LOCALE_REGISTRY).map(([code, entry]) => [
      code,
      { nativeName: entry.nativeName },
    ]),
  ) as Record<LanguageCode, LanguageConfig>;

/**
 * Resolve an OS/BCP-47 locale through the canonical registry. Regional
 * variants fall back to the only registered language sharing their base.
 */
export function resolveSupportedLanguage(locale: string | null | undefined): LanguageCode {
  if (!locale) return "en";
  const normalized = locale.trim().replaceAll("_", "-").toLowerCase();
  const exact = SUPPORTED_LANGUAGE_CODES.find(
    (code) => code.toLowerCase() === normalized,
  );
  if (exact) return exact;

  const base = normalized.split("-")[0];
  return SUPPORTED_LANGUAGE_CODES.find(
    (code) => code.toLowerCase().split("-")[0] === base,
  ) ?? "en";
}

/**
 * Translate an early-process message without calling the mutable i18next
 * singleton. This is safe before Electron app.whenReady()/locale setup.
 */
export function translateRegistryMessage(
  locale: string | null | undefined,
  key: string,
): string {
  const language = resolveSupportedLanguage(locale);
  const messages = LOCALE_REGISTRY[language].messages as Record<string, string>;
  const englishMessages = LOCALE_REGISTRY.en.messages as Record<string, string>;
  return messages[key]
    ?? englishMessages[key]
    ?? key;
}
