/**
 * POO-196: per-session draft of @ project-asset mentions queued in the
 * composer. Process-local by design (same discipline as
 * atoms/sidebar-browser.ts `elementDraftRefsAtomFamily`): a picked file rides
 * the NEXT send as `SendMessageOptions.projectAssetRefs` — the server resolves
 * each mention and stamps the authoritative snapshot on the user message — and
 * an unsent draft dies with the session.
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'

/** One composer @ project-asset mention queued for the next send. */
export interface ProjectAssetMentionDraft {
  assetId: string
  version: number
  name: string
}

/** Per-session draft of picked project-asset mentions (point-in-time). */
export const projectAssetDraftRefsAtomFamily = atomFamily((_sessionId: string) =>
  atom<ProjectAssetMentionDraft[]>([]),
)
