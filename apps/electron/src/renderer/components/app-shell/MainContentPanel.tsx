/**
 * MainContentPanel - Right panel component for displaying content
 *
 * Renders content based on the unified NavigationState:
 * - Chats navigator: ChatPage for selected session, or empty state
 * - Sources navigator: SourceInfoPage for selected source, or empty state
 * - Settings navigator: Settings, Preferences, or Shortcuts page
 *
 * The NavigationState is the single source of truth for what to display.
 *
 * In focused mode (single window), wraps content with StoplightProvider
 * so PanelHeader components automatically compensate for macOS traffic lights.
 *
 * When multiple sessions are selected (multi-select mode), shows the
 * MultiSelectPanel with batch action buttons instead of a single chat.
 */

import * as React from 'react'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { AlertCircle, CloudOff } from 'lucide-react'
import { Panel } from './Panel'
import { MultiSelectPanel } from './MultiSelectPanel'
import { useAppShellContext } from '@/context/AppShellContext'
import { useManagedSkills } from '@/hooks/useManagedSkills'
import { sessionMetaMapAtom, type SessionMeta } from '@/atoms/sessions'
import { projectEntryAtom } from '@/atoms/project-entry'
import { useProjectEntry } from '@/hooks/useProjectEntry'
import { StoplightProvider } from '@/context/StoplightContext'
import {
  useNavigationState,
  isSessionsNavigation,
  isSourcesNavigation,
  isSettingsNavigation,
  isSkillsNavigation,
  isAutomationsNavigation,
} from '@/contexts/NavigationContext'
import { useSessionSelection, useIsMultiSelectActive, useSelectedIds, useSelectionCount } from '@/hooks/useSession'
import { sourceSelection, skillSelection, automationSelection } from '@/hooks/useEntitySelection'
import { extractLabelId } from '@polo-ai/shared/labels'
import type { SessionStatusId } from '@/config/session-status-config'
import { SourceInfoPage, ChatPage } from '@/pages'
import SkillInfoPage from '@/pages/SkillInfoPage'
import { getSettingsPageComponent } from '@/pages/settings/settings-pages'
import { resolveRenderableSettingsSubpage } from '../../../shared/menu-schema'
import { AutomationInfoPage } from '../automations/AutomationInfoPage'
import type { ExecutionEntry } from '../automations/types'
import { automationsAtom } from '@/atoms/automations'
import { SendResourceToWorkspaceDialog, type SendResourceType } from './SendResourceToWorkspaceDialog'
import { useOptionalProductSpaceContext } from '@/context/ProductSpaceContext'
import { subscribeActiveProject, getActiveProjectRaw } from '@/components/projects/projects-bus'
import { ProjectConversationEmptyState } from '@/components/project-context/ProjectConversationEmptyState'

export interface MainContentPanelProps {
  /** Whether both sidebar and navigator are hidden (focus mode / CMD+.) */
  isSidebarAndNavigatorHidden?: boolean
  /** Optional className for the container */
  className?: string
  /**
   * Override the navigation state for this panel.
   * When provided, this panel renders based on the override instead of the global NavigationState.
   * Used by PanelSlot to render panels in the panel stack.
   */
  navStateOverride?: import('../../../shared/types').NavigationState | null
}

/**
 * POO-196 R3 UB2 (adjudication U10) — the PERSISTENT landing face for a
 * committed entry whose fresh history read (getSessions) failed. It keeps the
 * project title, renders「无法读取项目对话，请重新加载」+「重新加载」, and NEVER
 * falls back to a sendable empty state or an old project's messages — the
 * unknown history must not be mistaken for an empty project (that would
 * invite a duplicate conversation). It shows ONLY while the failed target is
 * still this account's valid committed scope (the shared entry state clears
 * itself when the scope moves), and create-origin entries additionally carry
 *「项目已创建，暂时无法进入」— retry re-enters, it never re-creates.
 * Exported so the harness host can mirror the exact production surface rule.
 */
export function ProjectEntryHistoryErrorFace({ projectName, createOrigin, onRetry }: {
  projectName: string
  createOrigin: boolean
  onRetry: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="project-entry-history-error"
      className="flex flex-1 flex-col items-center justify-center gap-[10px] px-[24px] py-[30px] text-center"
    >
      <CloudOff className="size-[20px] text-muted-foreground" aria-hidden="true" />
      {/* U10: the face keeps the project title so the user knows WHICH
      conversation surface failed to load. */}
      <h2 className="m-0 text-[18px] font-bold tracking-[-0.02em]">{projectName}</h2>
      <p className="m-0 max-w-[460px] text-[13px] leading-[1.6] text-muted-foreground">
        {t('project.entry.historyFailed')}
      </p>
      {createOrigin && (
        <p
          data-testid="project-entry-history-error-created"
          className="m-0 flex items-center gap-[6px] text-[12px] leading-[1.5] text-foreground"
        >
          <AlertCircle className="size-[13px] shrink-0 text-muted-foreground" aria-hidden="true" />
          <span>{t('createProject.created.enterFailed')}</span>
        </p>
      )}
      <button
        type="button"
        data-testid="project-entry-retry"
        className="mt-[4px] inline-flex min-h-[30px] items-center justify-center whitespace-nowrap rounded-[8px] border border-border bg-transparent px-[12px] text-[12px] font-medium text-foreground hover:bg-foreground-5"
        onClick={onRetry}
      >
        {t('project.entry.reloadHistory')}
      </button>
    </div>
  )
}

export function MainContentPanel({
  isSidebarAndNavigatorHidden = false,
  className,
  navStateOverride,
}: MainContentPanelProps) {
  const { t } = useTranslation()
  const globalNavState = useNavigationState()
  const navState = navStateOverride ?? globalNavState
  const {
    activeWorkspaceId,
    workspaces,
    onSessionStatusChange,
    onArchiveSession,
    onSessionLabelsChange,
    sessionStatuses,
    labels,
    onTestAutomation,
    onToggleAutomation,
    onDuplicateAutomation,
    onDeleteAutomation,
    onReplayAutomation,
    automationTestResults,
    getAutomationHistory,
    activeSessionId,
    activeSessionWorkingDirectory,
  } = useAppShellContext()

  // Session multi-select state
  const isMultiSelectActive = useIsMultiSelectActive()
  const selectedIds = useSelectedIds()
  const selectionCount = useSelectionCount()
  const { clearMultiSelect } = useSessionSelection()
  const sessionMetaMap = useAtomValue(sessionMetaMapAtom)
  const automations = useAtomValue(automationsAtom)
  // POO-196 R3 (D14): the committed product-space scope drives the project
  // conversation empty state below — hooks stay top-level (rules of hooks).
  const productSpaceScope = useOptionalProductSpaceContext()
  const activeProjectSpace = productSpaceScope?.activeProductSpace
  // POO-205 C3: the empty state binds to the ENTERED project — keying it by
  // projectId remounts the whole surface on a project switch (drafts, roster
  // state and tabs reset with the project instead of leaking across).
  const activeProject = useSyncExternalStore(subscribeActiveProject, getActiveProjectRaw)
  // UB2 (U3/U10): the shared entry transaction state. A committed entry whose
  // fresh history read failed pins the persistent history-error face over
  // this scope's conversation area (no sendable empty state, no old project's
  // messages) until「重新加载」re-reads and re-routes.
  const entryState = useAtomValue(projectEntryAtom)
  const { retryEntry } = useProjectEntry()
  const historyErrorActive = entryState.phase === 'history-failed'
    && entryState.accountId !== null
    && entryState.accountId === productSpaceScope?.accountId
    && activeProjectSpace?.kind === 'enterprise'
    && activeProjectSpace.id === entryState.productSpaceId

  // Execution history for the selected automation
  const selectedAutomationId = isAutomationsNavigation(navState) ? navState.details?.automationId : undefined
  const [executions, setExecutions] = useState<ExecutionEntry[]>([])

  useEffect(() => {
    if (!selectedAutomationId || !getAutomationHistory) {
      setExecutions([])
      return
    }
    let stale = false

    // Initial fetch
    getAutomationHistory(selectedAutomationId).then(entries => {
      if (!stale) setExecutions(entries)
    })

    // Re-fetch on automation changes (live updates when automations fire)
    const cleanup = window.electronAPI.onAutomationsChanged(() => {
      if (!stale) {
        getAutomationHistory(selectedAutomationId).then(entries => {
          if (!stale) setExecutions(entries)
        })
      }
    })

    return () => { stale = true; cleanup() }
  }, [selectedAutomationId, getAutomationHistory])

  // Source multi-select state
  const isSourceMultiSelectActive = sourceSelection.useIsMultiSelectActive()
  const sourceSelectionCount = sourceSelection.useSelectionCount()
  const selectedSourceIds = sourceSelection.useSelectedIds()
  const { clearMultiSelect: clearSourceSelection } = sourceSelection.useSelection()

  // Skill multi-select state
  const isSkillMultiSelectActive = skillSelection.useIsMultiSelectActive()
  const skillSelectionCount = skillSelection.useSelectionCount()
  const selectedSkillIds = skillSelection.useSelectedIds()
  const { clearMultiSelect: clearSkillSelection } = skillSelection.useSelection()
  // POO-106 S1: batch enable/disable over the toggleable selected skills.
  const { statusBySlug, setSkillsEnabledBulk } = useManagedSkills(activeWorkspaceId || undefined)
  const [batchEnablementPending, setBatchEnablementPending] = useState(false)

  // Automation multi-select state
  const isAutomationMultiSelectActive = automationSelection.useIsMultiSelectActive()
  const automationSelectionCount = automationSelection.useSelectionCount()
  const selectedAutomationIds = automationSelection.useSelectedIds()
  const { clearMultiSelect: clearAutomationSelection } = automationSelection.useSelection()

  // Send to Workspace dialog state (shared across resource types)
  const [sendDialogOpen, setSendDialogOpen] = useState(false)
  const [sendResourceType, setSendResourceType] = useState<SendResourceType>('source')
  const [sendResourceIds, setSendResourceIds] = useState<string[]>([])
  const [sendResourceLabel, setSendResourceLabel] = useState('')
  const hasOtherWorkspaces = workspaces.length > 1

  const openSendDialog = useCallback((type: SendResourceType, ids: Set<string>) => {
    const count = ids.size
    setSendResourceType(type)
    setSendResourceIds([...ids])
    setSendResourceLabel(`${count} ${type}${count !== 1 ? 's' : ''}`)
    setSendDialogOpen(true)
  }, [])

  const selectedMetas = useMemo(() => {
    const metas: SessionMeta[] = []
    selectedIds.forEach((id) => {
      const meta = sessionMetaMap.get(id)
      if (meta) metas.push(meta)
    })
    return metas
  }, [selectedIds, sessionMetaMap])

  const activeStatusId = useMemo((): SessionStatusId | null => {
    if (selectedMetas.length === 0) return null
    const first = (selectedMetas[0].sessionStatus || 'todo') as SessionStatusId
    const allSame = selectedMetas.every(meta => (meta.sessionStatus || 'todo') === first)
    return allSame ? first : null
  }, [selectedMetas])

  const appliedLabelIds = useMemo(() => {
    if (selectedMetas.length === 0) return new Set<string>()
    const toLabelSet = (meta: SessionMeta) =>
      new Set((meta.labels || []).map(entry => extractLabelId(entry)))
    const [first, ...rest] = selectedMetas.map(toLabelSet)
    const intersection = new Set(first)
    for (const labelSet of rest) {
      for (const id of [...intersection]) {
        if (!labelSet.has(id)) intersection.delete(id)
      }
    }
    return intersection
  }, [selectedMetas])

  // Batch operations for multi-select
  const handleBatchSetStatus = useCallback((status: SessionStatusId) => {
    selectedIds.forEach(sessionId => {
      onSessionStatusChange(sessionId, status)
    })
  }, [selectedIds, onSessionStatusChange])

  const handleBatchArchive = useCallback(() => {
    selectedIds.forEach(sessionId => {
      onArchiveSession(sessionId)
    })
    clearMultiSelect()
  }, [selectedIds, onArchiveSession, clearMultiSelect])

  const handleBatchToggleLabel = useCallback((labelId: string) => {
    if (!onSessionLabelsChange) return
    const allHaveLabel = selectedMetas.every(meta =>
      (meta.labels || []).some(entry => extractLabelId(entry) === labelId)
    )

    selectedMetas.forEach(meta => {
      const labels = meta.labels || []
      const hasLabel = labels.some(entry => extractLabelId(entry) === labelId)
      const filtered = labels.filter(entry => extractLabelId(entry) !== labelId)
      const nextLabels = allHaveLabel
        ? filtered
        : (hasLabel ? labels : [...labels, labelId])
      onSessionLabelsChange(meta.id, nextLabels)
    })
  }, [selectedMetas, onSessionLabelsChange])

  // Batch enablement: only rows the list panel would let you toggle (SM-06r).
  // Failures keep their selection so the batch can be retried.
  const handleBatchSetSkillsEnabled = useCallback(async (enabled: boolean) => {
    const statuses = [...selectedSkillIds]
      .map(slug => statusBySlug[slug])
      .filter((status): status is NonNullable<typeof status> => Boolean(status?.toggleable))
    if (statuses.length === 0) return
    setBatchEnablementPending(true)
    try {
      const { failed } = await setSkillsEnabledBulk(statuses, enabled)
      if (failed.length === 0) clearSkillSelection()
      else toast.error(t('skillsList.enableFailed'), { description: t('skillsList.batchEnableFailed', { count: failed.length }) })
    } finally {
      setBatchEnablementPending(false)
    }
  }, [selectedSkillIds, statusBySlug, setSkillsEnabledBulk, clearSkillSelection, t])

  // Wrap content with StoplightProvider so PanelHeaders auto-compensate in focused mode.
  // Also renders the Send to Workspace dialog (portal-based, so it overlays regardless of position).
  const wrapWithStoplight = (content: React.ReactNode) => (
    <StoplightProvider value={isSidebarAndNavigatorHidden}>
      {content}
      <SendResourceToWorkspaceDialog
        open={sendDialogOpen}
        onOpenChange={setSendDialogOpen}
        resourceType={sendResourceType}
        resourceIds={sendResourceIds}
        resourceLabel={sendResourceLabel}
        workspaces={workspaces}
        activeWorkspaceId={activeWorkspaceId || ''}
      />
    </StoplightProvider>
  )

  // Settings navigator - uses component map from settings-pages.ts.
  // Bare `settings` route (subpage === null) means navigator-only view in compact mode;
  // PanelStackContainer hides the content panel entirely. On desktop the panel still
  // mounts, so fall back to the App page so it isn't empty.
  if (isSettingsNavigation(navState)) {
    const subpage = navState.subpage ?? 'app'
    // POO-121 fail-closed: pages hidden from the navigators (messaging is
    // still being iterated on; server is feature-flag gated) must not come
    // back through a direct deep link either — unlisted subpages render the
    // default App page (same single source as the navigator filters).
    const SettingsPageComponent = getSettingsPageComponent(resolveRenderableSettingsSubpage(subpage))
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <SettingsPageComponent />
      </Panel>
    )
  }

  // Sources navigator - show source info, multi-select panel, or empty state
  if (isSourcesNavigation(navState)) {
    if (isSourceMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={sourceSelectionCount}
            entityType="source"
            onSendToWorkspace={hasOtherWorkspaces ? () => openSendDialog('source', selectedSourceIds) : undefined}
            onClearSelection={clearSourceSelection}
          />
        </Panel>
      )
    }
    if (navState.details) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <SourceInfoPage
            sourceSlug={navState.details.sourceSlug}
            workspaceId={activeWorkspaceId || ''}
          />
        </Panel>
      )
    }
    // No source selected - empty state
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t("sourcesList.noSourcesConfigured")}</p>
        </div>
      </Panel>
    )
  }

  // Skills navigator - show skill info, multi-select panel, or empty state
  if (isSkillsNavigation(navState)) {
    if (isSkillMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={skillSelectionCount}
            entityType="skill"
            onSetSkillsEnabled={handleBatchSetSkillsEnabled}
            batchEnablementPending={batchEnablementPending}
            onSendToWorkspace={hasOtherWorkspaces ? () => openSendDialog('skill', selectedSkillIds) : undefined}
            onClearSelection={clearSkillSelection}
          />
        </Panel>
      )
    }
    if (navState.details?.type === 'skill') {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <SkillInfoPage
            skillSlug={navState.details.skillSlug}
            workspaceId={activeWorkspaceId || ''}
            sessionId={activeSessionId}
            workingDirectory={activeSessionWorkingDirectory}
          />
        </Panel>
      )
    }
    // No skill selected - empty state
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t("skillsList.noSkillsConfigured")}</p>
        </div>
      </Panel>
    )
  }

  // Automations navigator - show automation info, multi-select panel, or empty state
  if (isAutomationsNavigation(navState)) {
    if (isAutomationMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={automationSelectionCount}
            entityType="automation"
            onSendToWorkspace={hasOtherWorkspaces ? () => openSendDialog('automation', selectedAutomationIds) : undefined}
            onClearSelection={clearAutomationSelection}
          />
        </Panel>
      )
    }
    if (navState.details) {
      const automation = automations.find(h => h.id === navState.details!.automationId)
      if (automation) {
        return wrapWithStoplight(
          <Panel variant="grow" className={className}>
            <AutomationInfoPage
              automation={automation}
              executions={executions}
              testResult={automationTestResults?.[automation.id]}
              onTest={onTestAutomation ? () => onTestAutomation(automation.id) : undefined}
              onToggleEnabled={onToggleAutomation ? () => onToggleAutomation(automation.id) : undefined}
              onDuplicate={onDuplicateAutomation ? () => onDuplicateAutomation(automation.id) : undefined}
              onDelete={onDeleteAutomation ? () => onDeleteAutomation(automation.id) : undefined}
              onReplay={onReplayAutomation}
            />
          </Panel>
        )
      }
    }
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t("automations.noAutomationsConfigured")}</p>
        </div>
      </Panel>
    )
  }

  // Chats navigator - show chat, multi-select panel, or empty state
  if (isSessionsNavigation(navState)) {
    // Multi-select mode: show batch actions panel
    if (isMultiSelectActive) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className}>
          <MultiSelectPanel
            count={selectionCount}
            sessionStatuses={sessionStatuses}
            activeStatusId={activeStatusId}
            onSetStatus={handleBatchSetStatus}
            labels={labels}
            appliedLabelIds={appliedLabelIds}
            onToggleLabel={handleBatchToggleLabel}
            onArchive={handleBatchArchive}
            onClearSelection={clearMultiSelect}
          />
        </Panel>
      )
    }

    // UB2 (U10): the history-error face wins over BOTH the stale session view
    // and the empty state — a committed scope whose fresh history read failed
    // must not display the previous project's messages and must never render
    // as a sendable「暂无对话」. It stays until「重新加载」re-reads and
    // re-routes, and only while the failed target is still this account's
    // valid committed scope (the shared entry state clears on scope change).
    if (historyErrorActive && activeProjectSpace) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className} testId="main-content-panel">
          <ProjectEntryHistoryErrorFace
            projectName={activeProjectSpace.name}
            createOrigin={entryState.origin === 'create'}
            onRetry={() => retryEntry(entryState.productSpaceId)}
          />
        </Panel>
      )
    }
    if (navState.details) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className} testId="main-content-panel">
          <ChatPage sessionId={navState.details.sessionId} />
        </Panel>
      )
    }
    // POO-196 R3 (D14): a committed enterprise PROJECT scope with no selected
    // session shows the editable project conversation empty state (zero-write
    // entry — the session is created only by the first explicit send), not
    // the generic "no session selected" placeholder.
    if (
      productSpaceScope?.accountId
      && activeWorkspaceId
      && activeProjectSpace
      && activeProjectSpace.kind === 'enterprise'
    ) {
      return wrapWithStoplight(
        <Panel variant="grow" className={className} testId="main-content-panel">
          <ProjectConversationEmptyState
            key={activeProject?.projectId ?? 'org-scope'}
            accountId={productSpaceScope.accountId}
            workspaceId={activeWorkspaceId}
            productSpaceId={activeProjectSpace.id}
            projectName={activeProjectSpace.name}
            viewerRole={activeProjectSpace.role}
            enterpriseId={activeProjectSpace.enterpriseId}
          />
        </Panel>
      )
    }
    // No session selected - empty state
    return wrapWithStoplight(
      <Panel variant="grow" className={className}>
        <div className="flex items-center justify-center h-full text-muted-foreground">
          <p className="text-sm">{t("session.noSessionSelected")}</p>
        </div>
      </Panel>
    )
  }

  // Fallback (should not happen with proper NavigationState)
  return wrapWithStoplight(
    <Panel variant="grow" className={className}>
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <p className="text-sm">{t("session.selectConversation")}</p>
      </div>
    </Panel>
  )
}
