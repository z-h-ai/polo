import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Building2, MessageSquare, Plus, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  clientWorkbenchPrimaryClassName,
} from '@/components/ui/client-workbench'
import { useProductSpaceContext } from '@/context/ProductSpaceContext'
import { navigate, routes } from '@/lib/navigate'
import { projectMatchesQuery, useProjects } from './useProjects'
import { enterProjectLightweight } from './enter-project'
import { getActiveProjectFor } from './projects-bus'
import type { ProjectSummary } from '@polo-ai/shared/protocol'

/**
 * POO-205 项目导航 view — the organization's project directory inside the
 * project home panel (列表视图). The same pm:listProjects data the home
 * 「项目」区域 reads, presented as selectable rows; a row click IS the
 * lightweight project entry (active project published, conversation layout
 * landed, and the panel flips to the detail view through the view bus). The
 * create entry opens the existing shared CreateProjectDialog through the
 * space context — the home section stays the sole OPENER surface and this
 * view never duplicates the form.
 */
export function ProjectNavView() {
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
  const { projects, loading, errorKey, reload } = useProjects(orgScope)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visible = useMemo(
    () => projects.filter(project => projectMatchesQuery(project, normalizedQuery)),
    [normalizedQuery, projects],
  )

  if (!orgScope) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-[10px] px-[20px] py-[30px] text-center" data-testid="projects-nav-org-required">
        <span className="grid size-[44px] place-items-center rounded-[12px] bg-[var(--info-soft)] text-info" aria-hidden="true">
          <Building2 className="size-[22px]" />
        </span>
        <p className="m-0 max-w-[320px] text-[13px] leading-[1.6] text-muted-foreground">
          {t('poo205.projects.orgRequired')}
        </p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[10px] px-[16px] pb-[16px]">
      <div className="flex shrink-0 items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('home.projects.searchPlaceholder')}
            aria-label={t('home.projects.searchPlaceholder')}
            data-testid="projects-nav-search"
            className="h-8 w-full appearance-none rounded-[8px] border border-border bg-surface px-[10px] pl-7 text-[12px] text-foreground outline-none focus-visible:border-accent [&::-webkit-search-cancel-button]:appearance-none"
          />
        </div>
        {typeof space.onOpenCreateProject === 'function' ? (
          <Button
            type="button"
            className={clientWorkbenchPrimaryClassName + ' shrink-0'}
            data-testid="projects-nav-create"
            onClick={() => space.onOpenCreateProject?.()}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('home.projects.create')}
          </Button>
        ) : null}
      </div>

      {loading ? (
        <p className="flex items-center gap-[6px] px-[2px] text-[12px] text-muted-foreground" data-testid="projects-nav-loading">
          <span className="size-[13px] animate-pulse rounded-full bg-foreground-10 motion-reduce:animate-none" aria-hidden="true" />
          {t('home.projects.loading')}
        </p>
      ) : errorKey ? (
        <div className="flex items-center gap-[10px]" data-testid="projects-nav-error">
          <p className="text-[12px] text-destructive">{t(errorKey)}</p>
          <Button type="button" variant="ghost" className={clientWorkbenchPrimaryClassName} data-testid="projects-nav-retry" onClick={() => void reload()}>
            {t('projectMembers.retry')}
          </Button>
        </div>
      ) : visible.length === 0 ? (
        <p className="px-[2px] text-[12px] text-muted-foreground" data-testid="projects-nav-empty">
          {normalizedQuery ? t('home.projects.noMatches') : t('home.projects.empty')}
        </p>
      ) : (
        <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-[10px] border border-border" data-testid="projects-nav-list">
          {visible.map(project => {
            const isCurrent = committed.kind === 'enterprise'
              && getActiveProjectFor(space.accountId, committed.id)?.projectId === project.id
            return (
              <li key={project.id}>
                <button
                  type="button"
                  data-testid="projects-nav-row"
                  data-project-id={project.id}
                  onClick={() => {
                    void enterProjectLightweight(space.accountId, project)
                  }}
                  className="flex w-full items-center gap-[10px] border-b border-border px-[12px] py-[10px] text-left transition-colors last:border-b-0 hover:bg-foreground-5 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                >
                  <span
                    aria-hidden="true"
                    className="flex size-[26px] shrink-0 items-center justify-center rounded-[6px] bg-[var(--accent-soft)] text-accent"
                  >
                    <MessageSquare className="size-[14px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-[8px]">
                      <span className="min-w-0 truncate text-[13px] font-semibold text-foreground">{project.name}</span>
                      {isCurrent ? (
                        <span
                          className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-[var(--accent-soft)] px-[7px] py-[1px] text-[10px] font-semibold leading-[1.6] text-accent"
                          data-testid="projects-nav-current"
                        >
                          {t('home.projects.current')}
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-[2px] flex items-center gap-[8px] text-[11px] leading-[1.5] text-muted-foreground">
                      <span className="shrink-0">{t(`productSpace.role.${project.myRole}`)}</span>
                      <span className="shrink-0">{t('home.projects.memberCount', { count: project.memberCount })}</span>
                      {project.purpose ? <span className="min-w-0 truncate">{project.purpose}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {/* The conversation layout stays reachable from the nav view — entering
          a project IS landing it, so a plain「返回会话」keeps the escape hatch
          honest without a second navigation concept. */}
      <button
        type="button"
        data-testid="projects-nav-back-to-chat"
        className="shrink-0 self-start rounded-[8px] px-[8px] py-[6px] text-[12px] text-muted-foreground hover:bg-foreground-5"
        onClick={() => navigate(routes.view.allSessions())}
      >
        {t('poo205.projects.backToChat')}
      </button>
    </div>
  )
}
