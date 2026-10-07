import { LEGACY_OPEN_DEEP_LINK_SCHEME } from '@polo-ai/shared/protocol'

export function findDeepLinkArgument(
  argv: readonly string[],
  configuredScheme = process.env.POLO_AI_DEEPLINK_SCHEME || 'poloai',
): string | null {
  // The legacy provider scheme (polo://open, F1 G6) is matched here too so a
  // Windows/Linux cold-start launch picks it up like any other deep link;
  // parseDeepLink still fails closed on every non-`open` legacy shape.
  const schemes = new Set(
    ['poloai', LEGACY_OPEN_DEEP_LINK_SCHEME, configuredScheme].map(scheme => scheme.toLowerCase()),
  )
  for (const argument of argv) {
    try {
      const protocol = new URL(argument).protocol.replace(/:$/, '').toLowerCase()
      if (schemes.has(protocol)) return argument
    } catch {
      // Non-URL process arguments are expected.
    }
  }
  return null
}
