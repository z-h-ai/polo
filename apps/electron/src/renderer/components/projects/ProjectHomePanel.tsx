import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { ChevronLeft, X } from 'lucide-react'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { cn } from '@/lib/utils'
import {
  clearActiveProjectIfStale,
  consumeProjectsView,
  getProjectsViewSnapshot,
  subscribeProjectsView,
  type ProjectsViewRequest,
} from './projects-bus'
import { useProjects } from './useProjects'
import { ProjectNavView } from './ProjectNavView'
import { ProjectDetailView } from './ProjectDetailView'
import { ProjectSettingsView } from './ProjectSettingsView'

/**
 * POO-205 项目页 — the App-hosted project surface (项目导航 / 项目首页 /
 * 项目设置, three views one drawer). ONE instance mounts next to the
 * CreateProjectDialog; every lightweight project entry publishes a view
 * request through the bus (openProjectsView) and this panel consumes it —
 * "项目切换是轻量导航" never routes a space switch and never remounts the
 * shell.
 *
 * The panel also owns the active-project hygiene: the committed scope effect
 * clears the bus's active project the moment the committed account/org space
 * stops matching its stamp, so a later「新建会话」can never attach a project
 * of a space the user has left.
 */
export function ProjectHomePanel() {
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
  const { projects, loading, reload } = useProjects(orgScope)

  const [open, setOpen] = useState(false)
  const [view, setView] = useState<ProjectsViewRequest>({ view: 'nav' })
  const consumedSeqRef = useRef(0)
  const snapshot = useSyncExternalStore(subscribeProjectsView, getProjectsViewSnapshot)

  // Consume ONE bus request per sequence: open the drawer on the requested
  // view. A request published before this panel's effect ran is still
  // addressable (the bus holds it) — no lost navigation between dispatch and
  // subscription.
  useEffect(() => {
    if (!snapshot.request || snapshot.seq <= consumedSeqRef.current) return
    consumedSeqRef.current = snapshot.seq
    setView(snapshot.request)
    setOpen(true)
    consumeProjectsView(snapshot.seq)
  }, [snapshot])

  // Active-project hygiene: the committed scope is the live truth. Leaving
  // the organization (or the account) retires the active project at once.
  useEffect(() => {
    clearActiveProjectIfStale(space.accountId, committed?.kind === 'enterprise' ? committed.id : null)
  }, [committed, space.accountId])

  const viewProjectId = view.view === 'nav' ? null : view.projectId
  const project = useMemo(
    () => (viewProjectId ? projects.find(item => item.id === viewProjectId) ?? null : null),
    [projects, viewProjectId],
  )

  // A detail/settings request for a project the mounted list has not seen
  // yet (fresh create, fast entry) re-reads the directory once.
  const reloadedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !viewProjectId || project || loading) return
    if (reloadedForRef.current === viewProjectId) return
    reloadedForRef.current = viewProjectId
    void reload()
  }, [loading, open, project, reload, viewProjectId])

  if (!open) return null

  const headerTitle = view.view === 'nav'
    ? t('poo205.projects.title')
    : view.view === 'detail'
      ? (project?.name ?? t('poo205.projects.title'))
      : (project?.name ? t('poo205.settings.titleNamed', { name: project.name }) : t('poo205.settings.title'))

  return createPortal(
    <div
      data-testid="project-home-panel"
      role="dialog"
      aria-modal="true"
      aria-label={headerTitle}
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setOpen(false)
        }
      }}
      className="fixed inset-0 z-modal flex justify-end outline-none"
    >
      <div
        aria-hidden="true"
        data-testid="project-home-backdrop"
        className="absolute inset-0 bg-[var(--overlay,rgba(0,0,0,0.5))]"
        onClick={() => setOpen(false)}
      />
      <div
        className="relative flex min-h-0 flex-col border-l border-border bg-background shadow-modal-small"
        style={{ width: 'min(480px, calc(100vw - 48px))' }}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-[14px] py-[10px]">
          {view.view !== 'nav' ? (
            <button
              type="button"
              data-testid="project-home-back"
              aria-label={t('projectMembers.invite.backToRoster')}
              onClick={() => setView({ view: 'nav' })}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground-5 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
          ) : null}
          <h2
            data-testid="project-home-title"
            className={cn('min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground')}
          >
            {headerTitle}
          </h2>
          <button
            type="button"
            data-testid="project-home-close"
            aria-label={t('common.close')}
            onClick={() => setOpen(false)}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground-5 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {view.view === 'nav' ? (
          <ProjectNavView />
        ) : !orgScope ? (
          <div className="flex flex-1 items-center justify-center px-[16px] text-[13px] text-muted-foreground">
            {t('projectMembers.error.spaceRequired')}
          </div>
        ) : loading && !project ? (
          <div className="flex flex-1 items-center justify-center px-[16px] text-[13px] text-muted-foreground" data-testid="project-home-loading">
            {t('home.projects.loading')}
          </div>
        ) : !project ? (
          <div className="flex flex-1 items-center justify-center px-[16px] text-[13px] text-muted-foreground" data-testid="project-home-missing">
            {t('projectMembers.error.notFound')}
          </div>
        ) : view.view === 'detail' ? (
          <ProjectDetailView project={project} onOpenSettings={projectId => setView({ view: 'settings', projectId })} />
        ) : (
          <ProjectSettingsView
            project={project}
            onSaved={fresh => {
              void reload()
              setView({ view: 'detail', projectId: fresh.id })
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
