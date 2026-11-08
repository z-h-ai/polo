import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MessageSquarePlus, Settings, UserPlus, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  clientWorkbenchButtonClassName,
  clientWorkbenchPrimaryClassName,
} from '@/components/ui/client-workbench'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { navigate, routes } from '@/lib/navigate'
import { getActiveProjectFor } from './projects-bus'
import type { ProjectSummary } from '@polo-ai/shared/protocol'
import { ProjectMembersPanel, ProjectMembersEntryLabel } from '../project-context/ProjectMembersPanel'
import { useCollaborationRoster } from '../project-context/useCollaborationRoster'

/**
 * POO-205 项目首页 view (detail视图) — the entered project's home: the
 * authoritative facts the wire knows (name / purpose / instructions presence,
 * caller role, member count), the conversation actions (新建会话 with THIS
 * project attached through the active-project bus) and the member surfaces:
 * the「成员 N」entry plus the SAME members panel ChatPage hosts, in its
 * drawer form (the panel component is the one members surface — the home
 * simply adds a host, never a second implementation).
 *
 * The settings entry is role-gated: only owner/manager sees it (the server
 * still enforces authority — this hides a surface that could only 403).
 */
export function ProjectDetailView({ project, onOpenSettings }: {
  project: ProjectSummary
  onOpenSettings: (projectId: string) => void
}) {
  const { t } = useTranslation()
  const space = useProductSpaceContext()
  const committed = space.activeProductSpace
  const orgScope = committed?.kind === 'enterprise'
    ? {
      accountId: space.accountId,
      productSpaceId: committed.id,
      organizationEnterpriseId: committed.enterpriseId,
    }
    : null

  const projectScope = orgScope
    ? { ...orgScope, projectId: project.id }
    : null
  const roster = useCollaborationRoster(projectScope)
  const canManage = roster.viewerRole === 'owner' || roster.viewerRole === 'manager'
  const [membersOpen, setMembersOpen] = useState(false)

  const activeRef = useMemo(
    () => (committed?.kind === 'enterprise'
      ? getActiveProjectFor(space.accountId, committed.id)
      : null),
    [committed, space.accountId],
  )
  const isEntered = activeRef?.projectId === project.id

  const startProjectSession = () => {
    // The active project is what App.handleCreateSession attaches; entering
    // publishes it, so a直接新建 from the home carries THIS project even when
    // the action route funnels through the shell's trusted creation path.
    navigate(routes.action.newSession())
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[12px] px-[16px] pb-[16px]" data-testid="project-detail-view">
      <div className="shrink-0">
        <h3 className="m-0 text-[16px] font-bold leading-[1.4]" data-testid="project-detail-name">
          {project.name}
        </h3>
        <p className="m-0 mt-[4px] flex flex-wrap items-center gap-[8px] text-[12px] leading-[1.5] text-muted-foreground">
          <span className="inline-flex items-center whitespace-nowrap rounded-full bg-foreground-5 px-[7px] py-[1px] leading-[1.6]">
            {t(`productSpace.role.${project.myRole}`)}
          </span>
          <span>{t('home.projects.memberCount', { count: project.memberCount })}</span>
          {project.instructions ? (
            <span
              className="inline-flex items-center whitespace-nowrap rounded-full bg-foreground-5 px-[7px] py-[1px] leading-[1.6]"
              data-testid="project-detail-instructions-badge"
            >
              {t('poo205.settings.instructionsBadge')}
            </span>
          ) : null}
        </p>
        {project.purpose ? (
          <p className="m-0 mt-[8px] whitespace-pre-wrap text-[13px] leading-[1.6] text-foreground-70" data-testid="project-detail-purpose">
            {project.purpose}
          </p>
        ) : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-[8px]">
        <Button
          type="button"
          className={clientWorkbenchPrimaryClassName}
          data-testid="project-detail-new-session"
          onClick={startProjectSession}
        >
          <MessageSquarePlus className="size-3.5" aria-hidden="true" />
          {t('poo205.detail.newSession')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className={clientWorkbenchButtonClassName}
          data-testid="project-detail-members"
          aria-haspopup="dialog"
          aria-expanded={membersOpen}
          onClick={() => setMembersOpen(true)}
        >
          {membersOpen
            ? <UserPlus className="size-3.5" aria-hidden="true" />
            : <Users className="size-3.5" aria-hidden="true" />}
          <ProjectMembersEntryLabel roster={roster} showInviteAffordance={canManage} />
        </Button>
        {canManage ? (
          <Button
            type="button"
            variant="ghost"
            className={clientWorkbenchButtonClassName + ' ml-auto'}
            data-testid="project-detail-settings"
            onClick={() => onOpenSettings(project.id)}
          >
            <Settings className="size-3.5" aria-hidden="true" />
            {t('poo205.settings.open')}
          </Button>
        ) : null}
      </div>

      {!isEntered ? (
        <p className="m-0 shrink-0 text-[11px] leading-[1.45] text-foreground-50" data-testid="project-detail-not-entered">
          {t('poo205.detail.notEntered')}
        </p>
      ) : null}

      {projectScope ? (
        <ProjectMembersPanel
          open={membersOpen}
          mode="drawer"
          scope={projectScope}
          projectName={project.name}
          roster={roster}
          onClose={() => setMembersOpen(false)}
        />
      ) : null}
    </div>
  )
}
