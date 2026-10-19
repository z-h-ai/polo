/**
 * useManagedSkills — renderer access to the local managed-skill enablement
 * store (POO-106 S1).
 *
 * Holds the `skills.listManaged` inventory for the active workspace in a
 * shared Jotai atom, refreshes on `skills.CHANGED`, and performs optimistic
 * single/batch enablement writes that roll back on failure (SM-04r/R4).
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { atom } from 'jotai'
import type { ManagedSkillSource, ManagedSkillStatus } from '@polo-ai/shared/skills'

interface ManagedSkillsState {
  workspaceId: string | null
  revision: number
  bySlug: Record<string, ManagedSkillStatus>
}

const emptyState: ManagedSkillsState = { workspaceId: null, revision: 0, bySlug: {} }

const managedSkillsAtom = atom<ManagedSkillsState>(emptyState)

export interface BulkEnablementOutcome {
  succeeded: string[]
  /** Slugs whose write failed; callers keep them selected for retry (SM-06r). */
  failed: string[]
}

export function useManagedSkills(workspaceId: string | undefined) {
  const [state, setState] = useAtom(managedSkillsAtom)

  const refresh = React.useCallback(async () => {
    if (!workspaceId) {
      setState(emptyState)
      return
    }
    try {
      const response = await window.electronAPI.listManagedSkills({ workspaceId })
      if (!response.ok) return
      setState({
        workspaceId,
        revision: response.revision,
        bySlug: Object.fromEntries(response.items.map(item => [item.slug, item])),
      })
    } catch {
      // Keep the last known inventory; the next CHANGED broadcast refreshes it.
    }
  }, [workspaceId, setState])

  React.useEffect(() => { void refresh() }, [refresh])

  React.useEffect(() => window.electronAPI.onSkillsChanged((changedWorkspaceId) => {
    if (changedWorkspaceId === workspaceId) void refresh()
  }), [refresh, workspaceId])

  const applyOptimistic = React.useCallback((slug: string, enabled: boolean | null) => {
    setState(prev => {
      const current = prev.bySlug[slug]
      if (!current) return prev
      return enabled === null
        ? prev
        : { ...prev, bySlug: { ...prev.bySlug, [slug]: { ...current, enabled } } }
    })
  }, [setState])

  /**
   * Optimistically flip one toggle, then confirm over RPC. Throws the server
   * error code (or transport error) after rolling the row back (SM-04r).
   */
  const setSkillEnabled = React.useCallback(async (status: ManagedSkillStatus, enabled: boolean): Promise<void> => {
    if (!workspaceId) throw new Error('workspace_context_mismatch')
    applyOptimistic(status.slug, enabled)
    try {
      const response = await window.electronAPI.setManagedSkillEnablement({
        workspaceId,
        slug: status.slug,
        source: status.source as ManagedSkillSource,
        enabled,
        expectedRevision: state.revision,
      })
      if (!response.ok) {
        applyOptimistic(status.slug, null)
        void refresh()
        throw new Error(response.errorCode)
      }
      setState(prev => ({ ...prev, revision: response.revision }))
    } catch (error) {
      applyOptimistic(status.slug, null)
      throw error instanceof Error ? error : new Error(String(error))
    }
  }, [workspaceId, state.revision, applyOptimistic, setState, refresh])

  /**
   * Batch enablement over the given toggleable statuses, serialized so each
   * write carries the revision the previous one produced. Partial failure is
   * reported, never silently dropped (SM-06r).
   */
  const setSkillsEnabledBulk = React.useCallback(async (statuses: readonly ManagedSkillStatus[], enabled: boolean): Promise<BulkEnablementOutcome> => {
    const succeeded: string[] = []
    const failed: string[] = []
    let revision = state.revision
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
          expectedRevision: revision,
        })
        if (!response.ok) {
          applyOptimistic(status.slug, null)
          failed.push(status.slug)
          continue
        }
        revision = response.revision
        succeeded.push(status.slug)
      } catch {
        applyOptimistic(status.slug, null)
        failed.push(status.slug)
      }
    }
    if (succeeded.length > 0) void refresh()
    return { succeeded, failed }
  }, [workspaceId, state.revision, applyOptimistic, refresh])

  const statusBySlug = state.workspaceId === workspaceId ? state.bySlug : {}

  return { statusBySlug, revision: state.revision, refresh, setSkillEnabled, setSkillsEnabledBulk }
}
