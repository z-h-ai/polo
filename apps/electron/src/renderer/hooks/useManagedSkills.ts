/**
 * useManagedSkills — renderer access to the local managed-skill enablement
 * store (POO-106 S1).
 *
 * Holds the `skills.listManaged` inventory plus the unfiltered workspace rows
 * (`skills.getUnfiltered`) for the active workspace in a shared Jotai atom,
 * refreshes on `skills.CHANGED`, and performs optimistic single/batch
 * enablement writes that roll back on failure (SM-04r/R4). The unfiltered rows
 * back the management list only — a disabled skill must stay visible there to
 * be re-enabled (B1); the composer keeps consuming the filtered `skills.GET`.
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { atom } from 'jotai'
import type { LoadedSkill, ManagedSkillSource, ManagedSkillStatus } from '@polo-ai/shared/skills'

interface ManagedSkillsState {
  workspaceId: string | null
  revision: number
  bySlug: Record<string, ManagedSkillStatus>
  /** Unfiltered `LoadedSkill` rows for the management list (B1). */
  inventoryRows: LoadedSkill[]
}

const emptyState: ManagedSkillsState = { workspaceId: null, revision: 0, bySlug: {}, inventoryRows: [] }

const managedSkillsAtom = atom<ManagedSkillsState>(emptyState)

export interface BulkEnablementOutcome {
  succeeded: string[]
  /** Slugs whose write failed; callers keep them selected for retry (SM-06r). */
  failed: string[]
}

export function useManagedSkills(workspaceId: string | undefined) {
  const [state, setState] = useAtom(managedSkillsAtom)

  // Latest revision the server acknowledged, kept outside the render closure so
  // a write issued within the same render window as its predecessor still
  // echoes the freshest revision instead of a stale snapshot (M1).
  const revisionRef = React.useRef(0)
  // All enablement writes serialize through this queue, so each RPC observes
  // the revision the previous write produced — the single-toggle path gets the
  // same revision threading the batch path already had (M1).
  const writeQueueRef = React.useRef<Promise<unknown>>(Promise.resolve())
  const enqueueWrite = React.useCallback(<T>(task: () => Promise<T>): Promise<T> => {
    const result = writeQueueRef.current.then(task, task)
    writeQueueRef.current = result.then(() => undefined, () => undefined)
    return result
  }, [])

  const refresh = React.useCallback(async () => {
    if (!workspaceId) {
      setState(emptyState)
      return
    }
    try {
      const [response, rows] = await Promise.all([
        window.electronAPI.listManagedSkills({ workspaceId }),
        // Deferred so a missing (or failing) unfiltered channel degrades to
        // `null` instead of taking the whole inventory down with it.
        Promise.resolve()
          .then(() => window.electronAPI.getSkillsUnfiltered(workspaceId))
          .catch(() => null),
      ])
      if (!response.ok) return
      revisionRef.current = response.revision
      setState(prev => ({
        workspaceId,
        revision: response.revision,
        bySlug: Object.fromEntries(response.items.map(item => [item.slug, item])),
        inventoryRows: Array.isArray(rows)
          ? rows
          : prev.workspaceId === workspaceId ? prev.inventoryRows : [],
      }))
    } catch {
      // Keep the last known inventory; the next CHANGED broadcast refreshes it.
    }
  }, [workspaceId, setState])

  React.useEffect(() => { void refresh() }, [refresh])

  React.useEffect(() => window.electronAPI.onSkillsChanged((changedWorkspaceId) => {
    if (changedWorkspaceId === workspaceId) void refresh()
  }), [refresh, workspaceId])

  const applyOptimistic = React.useCallback((slug: string, enabled: boolean) => {
    setState(prev => {
      const current = prev.bySlug[slug]
      if (!current) return prev
      return { ...prev, bySlug: { ...prev.bySlug, [slug]: { ...current, enabled } } }
    })
  }, [setState])

  /** Restore the row to its pre-toggle value — the actual rollback (SM-04r). */
  const rollBack = React.useCallback((status: ManagedSkillStatus) => {
    applyOptimistic(status.slug, status.enabled)
  }, [applyOptimistic])

  /**
   * Optimistically flip one toggle, then confirm over RPC. Throws the server
   * error code (or transport error) after rolling the row back (SM-04r).
   */
  const setSkillEnabled = React.useCallback(async (status: ManagedSkillStatus, enabled: boolean): Promise<void> => {
    if (!workspaceId) throw new Error('workspace_context_mismatch')
    applyOptimistic(status.slug, enabled)
    return enqueueWrite(async () => {
      try {
        const response = await window.electronAPI.setManagedSkillEnablement({
          workspaceId,
          slug: status.slug,
          source: status.source as ManagedSkillSource,
          enabled,
          expectedRevision: revisionRef.current,
        })
        if (!response.ok) {
          rollBack(status)
          // A conflict response carries the document's current revision;
          // adopting it lets the immediate retry succeed (M1).
          if (typeof response.revision === 'number') revisionRef.current = response.revision
          void refresh()
          throw new Error(response.errorCode)
        }
        revisionRef.current = response.revision
        setState(prev => ({ ...prev, revision: response.revision }))
      } catch (error) {
        rollBack(status)
        throw error instanceof Error ? error : new Error(String(error))
      }
    })
  }, [workspaceId, applyOptimistic, enqueueWrite, rollBack, setState, refresh])

  /**
   * Batch enablement over the given toggleable statuses, serialized so each
   * write carries the revision the previous one produced. Partial failure is
   * reported, never silently dropped (SM-06r).
   */
  const setSkillsEnabledBulk = React.useCallback(async (statuses: readonly ManagedSkillStatus[], enabled: boolean): Promise<BulkEnablementOutcome> => {
    return enqueueWrite(async () => {
      const succeeded: string[] = []
      const failed: string[] = []
      for (const status of statuses) {
        if (!workspaceId) {
          failed.push(status.slug)
          continue
        }
        applyOptimistic(status.slug, enabled)
        try {
          const response = await window.electronAPI.setManagedSkillEnablement({
            workspaceId,
            slug: status.slug,
            source: status.source as ManagedSkillSource,
            enabled,
            expectedRevision: revisionRef.current,
          })
          if (!response.ok) {
            if (typeof response.revision === 'number') revisionRef.current = response.revision
            rollBack(status)
            failed.push(status.slug)
            continue
          }
          revisionRef.current = response.revision
          succeeded.push(status.slug)
        } catch {
          rollBack(status)
          failed.push(status.slug)
        }
      }
      if (succeeded.length > 0) void refresh()
      return { succeeded, failed }
    })
  }, [workspaceId, applyOptimistic, enqueueWrite, rollBack, refresh])

  const scoped = state.workspaceId === workspaceId

  return {
    statusBySlug: scoped ? state.bySlug : {},
    inventoryRows: scoped ? state.inventoryRows : [],
    revision: state.revision,
    refresh,
    setSkillEnabled,
    setSkillsEnabledBulk,
  }
}
