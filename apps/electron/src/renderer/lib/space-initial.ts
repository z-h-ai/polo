/**
 * Journey #9 — the space-avatar glyph, shared by the space switcher menu and
 * the login-time space select screen (the two implementations used to drift:
 * both hardcoded the CJK glyphs 我/企 regardless of the user's language).
 *
 * A personal space is identified by a LOCALIZED glyph (i18n key — zh-Hans
 * renders 我, other locales render their own word); a named enterprise space
 * shows the first letter of its name; an unnamed (blank/whitespace) one falls
 * back to the localized enterprise glyph — the fallback is deterministic, it
 * never guesses a letter from an empty string.
 */
export type SpaceAvatarGlyph =
  | { kind: 'localized'; key: string }
  | { kind: 'letter'; letter: string }

export function productSpaceAvatarGlyph(
  name: string,
  kind: 'personal' | 'enterprise',
): SpaceAvatarGlyph {
  if (kind === 'personal') {
    return { kind: 'localized', key: 'productSpace.avatar.personal' }
  }
  const trimmed = name.trim()
  if (!trimmed) {
    return { kind: 'localized', key: 'productSpace.avatar.enterprise' }
  }
  return { kind: 'letter', letter: trimmed[0]!.toUpperCase() }
}
