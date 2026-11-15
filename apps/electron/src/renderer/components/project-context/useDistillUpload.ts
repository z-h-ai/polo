import * as React from 'react'
import { useTranslation } from 'react-i18next'
import {
  PC_CONTROLLED_TAG_ID,
  PC_PRESET_TAG_IDS,
  normalizeTagId,
} from '@polo-ai/shared/protocol'
import type { DistillEntryResult, DistillSuggestion } from '@polo-ai/ui'
import { prepareAssetUploadFile } from './asset-upload-prep'
import { projectContextUploadErrorKey } from './AssetUploadDialog'

/**
 * POO-215 U2/U4 — the deposit round-trip behind the distillation checklist
 * card. One confirmed suggestion becomes ONE project asset through the
 * EXISTING upload contract (no new RPC, no admin change):
 *
 *   storeAttachment(text) — the body becomes a real file in the session's
 *                           private attachments folder (the same channel the
 *                           message-level 「沉淀到项目」 dialog uses)
 *   → prepareAssetUploadFile — size/mime/sha256 the upload RPC requires
 *   → pcUploadFile(source.kind='session')
 *   → pcSetConfirmed(true) — U2: distilled entries land as confirmed
 *                            conclusions by default
 *
 * Per-row failures CONTINUE the queue (the POO-210 batch semantics), and each
 * outcome is reported back so the card can render per-entry state — a failed
 * row never silently drops, and a successful one is never re-sent by a retry.
 */

interface DistillScope {
  workspaceId: string
  productSpaceId: string
  projectId: string
}

/** The upload name is derived from the entry title; filesystem-hostile
 * characters collapse to spaces and the .md suffix is appended here. */
function distillAssetName(title: string): string {
  const safe = title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()
  const name = safe.length > 0 ? safe : 'distilled-note'
  return `${name.slice(0, 120)}.md`
}

/** Model-proposed tags are advisory: only preset ids survive, the controlled
 * `confirmed` id can never ride the tag list (the deposit sets it explicitly
 * via pcSetConfirmed), duplicates collapse. */
function distillTags(suggestedTags: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const raw of suggestedTags) {
    const id = normalizeTagId(raw)
    if (!id) continue
    if (id === PC_CONTROLLED_TAG_ID) continue
    if (!(PC_PRESET_TAG_IDS as readonly string[]).includes(id)) continue
    seen.add(id)
  }
  return [...seen].slice(0, 4)
}

export interface DistillUploadController {
  /** Deposits the given entries serially; resolves with one result per entry,
   * in input order. */
  confirm: (entries: DistillSuggestion[]) => Promise<DistillEntryResult[]>
  /** False while the one-time upload ceiling is still unknown. */
  ready: boolean
}

export function useDistillUpload(input: {
  sessionId: string
  scope: DistillScope | null
  sessionTitle?: string | null
}): DistillUploadController {
  const { sessionId, scope, sessionTitle } = input
  const { t } = useTranslation()
  const [maxUploadBytes, setMaxUploadBytes] = React.useState<number | null>(null)
  const scopeRef = React.useRef(scope)
  scopeRef.current = scope
  const sessionTitleRef = React.useRef(sessionTitle)
  sessionTitleRef.current = sessionTitle

  // The upload ceiling is a capability of the target project — fetch it once
  // per scope, exactly like the share dialog's gate (ShareToProjectDialog).
  React.useEffect(() => {
    if (!scope) return
    let cancelled = false
    window.electronAPI.pcListCapabilities({
      workspaceId: scope.workspaceId,
      productSpaceId: scope.productSpaceId,
      projectId: scope.projectId,
    }).then((capabilities) => {
      if (!cancelled) setMaxUploadBytes(capabilities.limits.maxUploadBytes)
    }).catch(() => {
      // Unknown ceiling → confirm() reports the failure per entry; no
      // capability copy swap here (the card's confirm button stays disabled
      // through `ready`).
    })
    return () => { cancelled = true }
  }, [scope, setMaxUploadBytes])

  const confirm = React.useCallback(async (entries: DistillSuggestion[]): Promise<DistillEntryResult[]> => {
    const activeScope = scopeRef.current
    const maxBytes = maxUploadBytes
    const results: DistillEntryResult[] = []
    if (!activeScope || !maxBytes || maxBytes <= 0) {
      // Fail closed: without scope or ceiling nothing can deposit. Every
      // entry reports the same honest outcome — none is silently dropped.
      const errorKey = 'projectContext.errors.libraryNotReady'
      return entries.map(entry => ({ id: entry.id, status: 'failed' as const, errorKey }))
    }
    const title = sessionTitleRef.current
    const source = title
      ? { kind: 'session' as const, note: t('projectContext.distill.sourceNote', { title }).slice(0, 512) }
      : { kind: 'session' as const }

    for (const entry of entries) {
      try {
        // The upload RPC takes a PATH. The distilled body has none, so it is
        // written through the existing attachment store (the session's
        // private folder) and uploaded from there — bytes never transit the
        // RPC payload.
        const stored = await window.electronAPI.storeAttachment(sessionId, {
          type: 'text',
          path: '',
          name: distillAssetName(entry.title),
          mimeType: 'text/markdown',
          text: entry.body,
          size: new TextEncoder().encode(entry.body).length,
        })
        const prepared = await prepareAssetUploadFile(stored.storedPath, maxBytes)
        const uploaded = await window.electronAPI.pcUploadFile({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
          projectId: activeScope.projectId,
          mode: 'create',
          filePath: prepared.filePath,
          name: distillAssetName(entry.title),
          tags: distillTags(entry.suggestedTags),
          source,
          sizeBytes: prepared.sizeBytes,
          mime: prepared.mime,
          checksumSha256: prepared.digestSha256,
        })
        // U2: a distilled entry is a confirmed conclusion by default.
        await window.electronAPI.pcSetConfirmed({
          workspaceId: activeScope.workspaceId,
          productSpaceId: activeScope.productSpaceId,
          projectId: activeScope.projectId,
          assetId: uploaded.asset.id,
          input: { expectedVersion: uploaded.asset.current.version, confirmed: true },
        })
        results.push({ id: entry.id, status: 'success' })
      } catch (error) {
        results.push({
          id: entry.id,
          status: 'failed',
          errorKey: projectContextUploadErrorKey(error),
          errorDetail: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return results
  }, [sessionId, maxUploadBytes, t])

  return { confirm, ready: !!scope && !!maxUploadBytes && maxUploadBytes > 0 }
}
