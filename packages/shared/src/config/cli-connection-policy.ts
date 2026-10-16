import type { LlmConnection } from './llm-connections'

/** Non-secret original route provenance survives synthetic connections/resume. */
export interface CliConnectionProvenance {
  kind: 'owned' | 'managed'
  originalSlug?: string
  managedBy?: LlmConnection['managedBy']
}

export function hasManagedCliMarkers(
  connection: { slug?: string; managedBy?: LlmConnection['managedBy']; provenance?: CliConnectionProvenance } | null | undefined,
  provenance = connection?.provenance,
): boolean {
  return !!(connection?.managedBy || connection?.slug?.startsWith('polo-space-')
    || provenance?.kind === 'managed' || provenance?.managedBy
    || provenance?.originalSlug?.startsWith('polo-space-'))
}

export function assertOwnedCliConnection(
  connection: { slug?: string; managedBy?: LlmConnection['managedBy'] } | null | undefined,
  provenance?: CliConnectionProvenance,
): void {
  if (hasManagedCliMarkers(connection, provenance)) {
    throw new Error('CLI_MANAGED_CONTEXT_REQUIRED: managed compute requires a trusted ProductSpace broker')
  }
}
