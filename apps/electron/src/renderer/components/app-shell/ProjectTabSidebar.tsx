import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'jotai'
import { Settings2 } from 'lucide-react'

import { rightPaneNativeSuspendAtom } from '@/atoms/right-pane-suspension'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  clientWorkbenchDialogClassName,
  clientWorkbenchOverlayClassName,
  useClientWorkbenchStyle,
} from '@/components/ui/client-workbench'
import { ProjectMembersEntryLabel, ProjectMembersPanel } from '@/components/project-context/ProjectMembersPanel'
import { useCollaborationRoster } from '@/components/project-context/useCollaborationRoster'
import { ProjectSettingsView } from '@/components/projects/ProjectSettingsView'
import type { ActiveProjectRef } from '@/components/projects/projects-bus'
import { isSeparatorItem, type SidebarItem } from './LeftSidebar'

/**
 * POO-205 C8 (R7): the ENTERPRISE PROJECT tab's sidebar identity block and
 * its two hosted surfaces.
 *
 * The project tab's left column is the PROJECT, not the workspace: the
 * workspace-global entries (sources / skills / automations / settings) are
 * workspace data (Q13/J-5) and their create flows need a workspace session,
 * which an enterprise project tab can never provide. What stays is the
 * conversation filter list (AppShell keeps `nav:allSessions` + `nav:labels`,
 * already filtered to the active project) under this header:
 *
 * - identity: project name + one-line purpose;
 * - members: the roster avatars + count, opening the shared members PANEL
 *   (drawer form — the sidebar has no conversation lane to push into);
 * - settings: the gear opening the project settings dialog (the ONLY entry
 *   now that the home card lost its button, R8);
 * - conversations: the filter list AppShell keeps (`nav:allSessions` +
 *   `nav:labels`), already filtered to the active project.
 *
 * POO-207: no 「新建会话」 here — the navigator (session list) header has
 * owned new-session since POO-202, and the duplicate button only taught two
 * homes for the same action.
 *
 * The identity reads the projects-bus `ActiveProjectRef`, so a settings save
 * that refreshes the active tab's project payload re-publishes through the
 * tab bridge and this header re-renders with the fresh name/purpose.
 */

/** The conversation-filter rows an enterprise project tab keeps. Everything
 * else in the unified sidebar is workspace-global and must not appear. */
const PROJECT_TAB_SIDEBAR_IDS = new Set(['nav:allSessions', 'nav:labels'])

/** C8 R7 gate — the project layout exists ONLY for an ENTERPRISE committed
 * space whose ACTIVE tab hosts a project. The personal space (and every
 * other tab) fails every branch: the unified sidebar passes through
 * untouched. Kept pure so the反例 stays testable without an AppShell mount. */
export function isEnterpriseProjectTabLayout(
  spaceKind: 'personal' | 'enterprise' | null,
  activeTab: { type: string } | null | undefined,
): boolean {
  return spaceKind === 'enterprise' && activeTab?.type === 'project'
}

/** C8 R7 sidebar trim — the whitelist form, so a future workspace-global row
 * can never leak into a project tab by omission. Non-enterprise callers pass
 * the array through untouched (the personal sidebar is unchanged). */
export function projectTabSidebarItems(items: SidebarItem[]): SidebarItem[] {
  const kept: SidebarItem[] = []
  for (const item of items) {
    if (isSeparatorItem(item)) continue
    if (PROJECT_TAB_SIDEBAR_IDS.has(item.id)) kept.push(item)
  }
  return kept
}

/** The live role for authority decisions — the MEMBER PANEL's source first
 * (the roster row of the acting account), the tab-carried snapshot only as
 * the fill-in before the list has spoken. */
export function projectTabViewerRole(project: ActiveProjectRef, rosterViewerRole: ActiveProjectRef['myRole'] | null): ActiveProjectRef['myRole'] | null {
  return rosterViewerRole ?? project.myRole
}

export interface ProjectTabSidebarProps {
  /** The ACTIVE tab's project (the projects-bus ref — scope-stamped). */
  project: ActiveProjectRef
  /** A settings save landed: the caller refreshes the active tab's project
   * payload (which re-publishes the bus and re-renders this header). */
  onProjectSaved?: (fresh: { name: string; purpose?: string; instructions?: string; myRole: ActiveProjectRef['myRole'] }) => void
}

export function ProjectTabSidebar({ project, onProjectSaved }: ProjectTabSidebarProps) {
  const { t } = useTranslation()
  const store = useStore()
  const workbenchStyle = useClientWorkbenchStyle()

  const [membersOpen, setMembersOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const membersTriggerRef = useRef<HTMLButtonElement | null>(null)

  const membersScope = useMemo(() => ({
    accountId: project.accountId,
    productSpaceId: project.organizationProductSpaceId,
    organizationEnterpriseId: project.organizationEnterpriseId,
    projectId: project.projectId,
  }), [project.accountId, project.organizationEnterpriseId, project.organizationProductSpaceId, project.projectId])
  const roster = useCollaborationRoster(membersScope)

  // The drawer is a window modal: while it is up the native panes leave the
  // visible layer through the shared suspension flag (same contract as the
  // ChatPage host). Close returns focus to the members entry (P8).
  useEffect(() => {
    if (!membersOpen) return
    store.set(rightPaneNativeSuspendAtom, true)
    return () => { store.set(rightPaneNativeSuspendAtom, false) }
  }, [membersOpen, store])

  const closeMembers = useCallback(() => {
    setMembersOpen(false)
    window.setTimeout(() => membersTriggerRef.current?.focus(), 0)
  }, [])

  const viewerRole = projectTabViewerRole(project, roster.viewerRole)
  const canManage = viewerRole === 'owner' || viewerRole === 'manager'

  const handleSaved = useCallback((fresh: { name: string; purpose?: string; instructions?: string; myRole: ActiveProjectRef['myRole'] }) => {
    setSettingsOpen(false)
    onProjectSaved?.(fresh)
  }, [onProjectSaved])

  // The dialog edits a ProjectSummary; the bus ref carries the identity and
  // the display fields — the bookkeeping fields are stubs the view never
  // reads (same shape the home card passed).
  const settingsProject = useMemo(() => ({
    id: project.projectId,
    name: project.name,
    purpose: project.purpose,
    instructions: project.instructions,
    myRole: project.myRole,
    memberCount: roster.totalActiveMembers ?? 1,
    createdByAccountId: project.accountId,
    organizationEnterpriseId: project.organizationEnterpriseId,
    organizationProductSpaceId: project.organizationProductSpaceId,
    createdAt: '',
    updatedAt: '',
  }), [project, roster.totalActiveMembers])

  return (
    <>
      <div className="shrink-0 px-2 pt-2 pb-1" data-testid="project-tab-sidebar-header">
        <div className="flex items-start gap-1">
          <h2
            data-testid="project-tab-name"
            className="min-w-0 flex-1 truncate pt-[3px] text-[14px] font-semibold leading-[1.4] text-foreground"
            title={project.name}
          >
            {project.name}
          </h2>
          <button
            type="button"
            data-testid="project-tab-settings"
            aria-label={t('projectTab.openSettings')}
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Settings2 className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        {project.purpose ? (
          <p
            data-testid="project-tab-purpose"
            className="m-0 mt-[2px] truncate text-[12px] leading-[1.5] text-muted-foreground"
            title={project.purpose}
          >
            {project.purpose}
          </p>
        ) : null}
        <button
          type="button"
          ref={membersTriggerRef}
          data-testid="project-tab-members-entry"
          aria-haspopup="dialog"
          aria-expanded={membersOpen}
          onClick={() => setMembersOpen(true)}
          className="mt-[6px] inline-flex h-7 w-full items-center gap-1.5 rounded-[6px] px-1.5 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ProjectMembersEntryLabel roster={roster} />
        </button>
      </div>

      <ProjectMembersPanel
        open={membersOpen}
        mode="drawer"
        scope={membersScope}
        projectName={project.name}
        roster={roster}
        onClose={closeMembers}
      />

      <Dialog open={settingsOpen} onOpenChange={(open) => { if (!open) setSettingsOpen(false) }}>
        <DialogContent
          data-testid="project-tab-settings-dialog"
          style={workbenchStyle}
          overlayStyle={workbenchStyle}
          overlayClassName={clientWorkbenchOverlayClassName}
          className={clientWorkbenchDialogClassName}
        >
          <DialogHeader>
            <DialogTitle>
              {t('poo205.settings.titleNamed', { name: project.name })}
            </DialogTitle>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto pr-[2px]">
            <ProjectSettingsView
              project={settingsProject}
              canManage={canManage}
              onSaved={handleSaved}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
