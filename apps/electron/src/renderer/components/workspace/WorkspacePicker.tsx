/**
 * WorkspacePicker — shown when a thin client connects without a workspace ID.
 * Lists remote server workspaces and allows selection or creation.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, RefreshCw } from 'lucide-react'
import { Spinner } from '@polo-ai/ui'
import type { WorkspaceInfo } from '../../../shared/types'
import {
  AddWorkspaceContainer,
  AddWorkspaceStepHeader,
  AddWorkspacePrimaryButton,
} from './primitives'

interface WorkspacePickerProps {
  onSelectWorkspace: (workspaceId: string) => void
}

export function WorkspacePicker({ onSelectWorkspace }: WorkspacePickerProps) {
  const { t } = useTranslation()
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  // U9 (product-closure 2026-10-27): the load is a retryable callback, not a
  // run-once effect — a failed load used to leave one red line and an empty
  // list with no way forward short of restarting the app. The in-flight ref
  // (not state — the callback closes over stale values) is the busy guard:
  // a retry click while a load is in flight is a no-op.
  const loadInFlightRef = useRef(false)
  const loadWorkspaces = useCallback(() => {
    if (loadInFlightRef.current) return
    loadInFlightRef.current = true
    setLoading(true)
    setError(null)
    window.electronAPI.getServerWorkspaces()
      .then(ws => {
        setWorkspaces(ws)
        setLoading(false)
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : 'Failed to load workspaces')
        setLoading(false)
      })
      .finally(() => {
        loadInFlightRef.current = false
      })
  }, [])

  useEffect(() => {
    loadWorkspaces()
  }, [loadWorkspaces])

  const handleCreate = useCallback(async () => {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const ws = await window.electronAPI.createServerWorkspace(newName.trim())
      onSelectWorkspace(ws.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create workspace')
      setCreating(false)
    }
  }, [newName, onSelectWorkspace])

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-sidebar px-4">
        <AddWorkspaceContainer>
          <Spinner className="h-6 w-6" />
          <p className="mt-3 text-sm text-muted-foreground">{t("workspace.loadingWorkspaces")}</p>
        </AddWorkspaceContainer>
      </div>
    )
  }

  return (
    <div className="flex h-screen items-center justify-center bg-sidebar px-4">
      <AddWorkspaceContainer>
        <AddWorkspaceStepHeader
          title={t("workspace.selectWorkspace")}
          description={t("workspace.selectWorkspaceDesc")}
        />

        {error && (
          <div className="mt-3 w-full flex flex-col items-center gap-1.5">
            <p className="text-center text-sm text-destructive">{error}</p>
            <button
              type="button"
              data-testid="workspace-picker-retry"
              onClick={loadWorkspaces}
              disabled={loading}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-50 disabled:pointer-events-none"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              {t("pickerRetry.retry")}
            </button>
          </div>
        )}

        {/* Workspace list */}
        {workspaces.length > 0 && (
          <div className="mt-5 w-full space-y-1.5">
            {workspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => onSelectWorkspace(ws.id)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-foreground/5"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent text-xs font-semibold uppercase">
                  {ws.name.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{ws.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{ws.slug}</div>
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Divider */}
        <div className="mt-5 mb-4 w-full border-t" />

        {/* Create new */}
        <div className="w-full space-y-2">
          <input
            type="text"
            value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            placeholder={t("workspace.newWorkspaceName")}
            className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <AddWorkspacePrimaryButton
            onClick={handleCreate}
            disabled={!newName.trim()}
            loading={creating}
            loadingText={t("workspace.creating")}
            className="bg-accent hover:bg-accent/90 text-white"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {t("workspace.createWorkspace")}
          </AddWorkspacePrimaryButton>
        </div>
      </AddWorkspaceContainer>
    </div>
  )
}
