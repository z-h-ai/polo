/**
 * Legacy installation/runtime cache invalidation lives in the Electron Main
 * process (local-app runtime). The admin/product-space handler modules cannot
 * import Main code, so Main installs this cleaner at bootstrap and the
 * one-shot direct-switch cleanup invokes it with verifiable results.
 */
export type LegacyLocalAppCleaner = () => Promise<{
  ok: boolean
  failedRefs: string[]
}>

let cleaner: LegacyLocalAppCleaner | null = null

export function setLegacyLocalAppCleaner(next: LegacyLocalAppCleaner): void {
  cleaner = next
}

export async function runLegacyLocalAppCleaner(): Promise<{
  ok: boolean
  failedRefs: string[]
  available: boolean
}> {
  if (!cleaner) {
    // Nothing registered means no local-app runtime exists in this process —
    // the installation/runtime caches are vacuously invalid.
    return { ok: true, failedRefs: [], available: false }
  }
  try {
    const result = await cleaner()
    return { ...result, available: true }
  } catch {
    return { ok: false, failedRefs: ['legacy-local-app-cleaner'], available: true }
  }
}
