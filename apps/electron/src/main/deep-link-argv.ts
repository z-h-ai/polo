export function findDeepLinkArgument(
  argv: readonly string[],
  configuredScheme = process.env.POLO_AI_DEEPLINK_SCHEME || 'poloai',
): string | null {
  const schemes = new Set(['poloai', configuredScheme].map(scheme => scheme.toLowerCase()))
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
