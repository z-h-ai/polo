import { useEffect, useMemo, useState } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { useCompactViewport } from '@/lib/use-compact-viewport'
import { catalogStateMessage } from '@/lib/home-app-errors'
import {
  AppArtwork,
  canViewOrganizationAppLogs,
  primaryActionFor,
  statusText,
  type CatalogPrimaryAction,
} from './OrganizationAppCard'

export const ALL_APPS_PAGE_SIZE = 60

export interface AllAppsSourceGroup {
  /** Stable group identity (source label or fallback key). */
  key: string
  /** Display label; empty for the enterprise flat group. */
  label: string
  apps: CatalogApp[]
}

/**
 * POO-43 source grouping. Personal spaces group lightly by the App's
 * CreatorCircle/creator source so same-named artifacts from different
 * sources stay visually separated. Enterprise spaces render one flat
 * group of the enterprise-distributed Apps. Order inside groups and the
 * order of the groups themselves follow the Catalog sortOrder.
 */
export function groupAllAppsForDisplay(
  apps: readonly CatalogApp[],
  spaceKind: 'personal' | 'enterprise' | null,
): AllAppsSourceGroup[] {
  if (spaceKind !== 'personal') {
    return [{ key: 'all', label: '', apps: [...apps] }]
  }
  const groups = new Map<string, { order: number; apps: CatalogApp[] }>()
  apps.forEach((app, index) => {
    const label = app.sourceNames?.[0]?.trim() || app.creatorName?.trim() || ''
    const key = label || '__unknown__'
    const group = groups.get(key)
    if (group) {
      group.apps.push(app)
    } else {
      groups.set(key, { order: index, apps: [app] })
    }
  })
  return [...groups.entries()]
    .sort((left, right) => left[1].order - right[1].order)
    .map(([key, group]) => ({ key, label: key === '__unknown__' ? '' : key, apps: group.apps }))
}

interface AllAppsViewProps {
  spaceName: string
  spaceKind: 'personal' | 'enterprise' | null
  apps: CatalogApp[]
  loading: boolean
  refreshing: boolean
  warningCode: string | null
  errorCode: string | null
  offline: boolean
  statusErrorCode: 'status_read_failed' | null
  statusLoadingScopeKeys: Readonly<Record<string, true>>
  statusErrorScopeKeys: Readonly<Record<string, true>>
  scopeKeyForApp: (app: CatalogApp) => string
  getStatus: (app: CatalogApp) => LocalAppRuntimeStatus | undefined
  compatibleWithHost: (app: CatalogApp) => boolean
  onRefresh: () => void
  onRetryStatuses: () => void
  onPrimaryAction: (app: CatalogApp, action: CatalogPrimaryAction) => void
  onStop: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onViewLogs: (app: CatalogApp) => void
  onBack: () => void
}

function actionLabel(t: ReturnType<typeof useTranslation>['t'], action: CatalogPrimaryAction): string {
  switch (action) {
    case 'cancel':
      return t('common.cancel')
    case 'open':
      return t('common.open')
    case 'retry':
      return t('common.retry')
    case 'unavailable':
      return t('common.unavailable')
    case 'install':
      return t('homeApps.actions.install')
    case 'update':
      return t('homeApps.actions.update')
  }
}

interface RowActions {
  primary: CatalogPrimaryAction
  busy: boolean
  installed: boolean
  stopAvailable: boolean
  logsAvailable: boolean
  uninstallAvailable: boolean
  progress: number | undefined
}

function computeRowActions(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  statusLoading: boolean,
  statusUnavailable: boolean,
  compatible: boolean,
  offline: boolean,
): RowActions {
  const primary = statusUnavailable
    ? 'unavailable'
    : primaryActionFor(app, status, compatible, offline, statusLoading)
  const busy = statusLoading || status?.status === 'starting'
  const installed = app.deliveryMode === 'local_bundle'
    && Boolean(status && status.status !== 'not_installed'
      && status.status !== 'downloading'
      && status.status !== 'installing')
  const localManagementAvailable = installed || (
    app.deliveryMode === 'local_bundle'
    && app.availability === 'withdrawn'
    && statusUnavailable
  )
  const stopAvailable = localManagementAvailable
    && (statusUnavailable
      || status?.status === 'running'
      || status?.status === 'starting')
  return {
    primary,
    busy,
    installed,
    stopAvailable,
    logsAvailable: localManagementAvailable
      && canViewOrganizationAppLogs(app, status),
    uninstallAvailable: localManagementAvailable,
    progress: status?.progress?.percent,
  }
}

function useRowActions(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  statusLoading: boolean,
  statusUnavailable: boolean,
  compatible: boolean,
  offline: boolean,
): RowActions {
  return useMemo(
    () => computeRowActions(app, status, statusLoading, statusUnavailable, compatible, offline),
    [app, status, statusLoading, statusUnavailable, compatible, offline],
  )
}

interface AppInspectorDetailProps {
  app: CatalogApp
  status: LocalAppRuntimeStatus | undefined
  actions: RowActions
  statusLoading: boolean
  statusUnavailable: boolean
  compatible: boolean
  offline: boolean
  onPrimaryAction: (app: CatalogApp, action: CatalogPrimaryAction) => void
  onStop: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onViewLogs: (app: CatalogApp) => void
}

/**
 * Shared detail body for the desktop inspector panel and the inline
 * expanded row on compact viewports. Read-only context (source, version,
 * permissions) plus the same authorized actions as the list row.
 */
export function AppInspectorDetail({
  app,
  status,
  actions,
  statusLoading,
  statusUnavailable,
  compatible,
  offline,
  onPrimaryAction,
  onStop,
  onUninstall,
  onViewLogs,
}: AppInspectorDetailProps) {
  const { t } = useTranslation()
  const sourceLabel = app.creatorName?.trim() || t('homeApps.allApps.unknownSource')
  const version = status?.currentVersion
    || app.catalogVersion?.version
    || app.currentRelease?.version
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="all-apps-inspector-body">
      <div className="flex min-w-0 items-start gap-3">
        <AppArtwork app={app} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{app.name}</h3>
          <p
            className="mt-0.5 truncate text-xs text-muted-foreground"
            data-testid="all-apps-inspector-source"
          >
            {sourceLabel}
          </p>
        </div>
      </div>
      <p className="text-xs leading-[18px] text-foreground/65">
        {app.description || t('homeApps.noDescription')}
      </p>
      <dl className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3 text-xs">
        <div>
          <dt className="text-muted-foreground">{t('homeApps.allApps.sourceLabel')}</dt>
          <dd
            className="mt-1 truncate font-medium"
            data-testid="all-apps-inspector-source-value"
          >
            {sourceLabel}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('homeApps.install.version')}</dt>
          <dd className="mt-1 truncate font-medium">
            {version || t('homeApps.status.notInstalled')}
          </dd>
        </div>
      </dl>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('homeApps.install.permissions')}
        </p>
        {app.permissions?.length ? (
          <ul className="mt-2 space-y-1.5">
            {app.permissions.map(permission => (
              <li key={permission} className="flex items-start gap-2 text-xs">
                <Icons.ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                <span>{permission}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            {t('homeApps.install.noPermissions')}
          </p>
        )}
      </div>
      <p className={cn(
        'truncate text-[11px] text-muted-foreground',
        (status?.status === 'broken' || status?.versionError) && 'text-destructive',
      )}>
        {statusLoading
          ? t('homeApps.status.loading')
          : statusUnavailable
          ? t('homeApps.status.statusUnavailable')
          : statusText(t, app, status, compatible)}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant={actions.primary === 'unavailable' ? 'secondary' : 'default'}
          disabled={actions.primary === 'unavailable' || actions.busy}
          onClick={() => onPrimaryAction(app, actions.primary)}
          data-testid="all-apps-inspector-primary"
        >
          {actions.busy && <Icons.LoaderCircle className="animate-spin" />}
          {statusLoading
            ? t('homeApps.status.loading')
            : actions.busy
            ? t('homeApps.status.starting')
            : actionLabel(t, actions.primary)}
        </Button>
        {actions.stopAvailable && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onStop(app)}
            data-testid="all-apps-inspector-stop"
          >
            <Icons.Square />
            {t('homeApps.actions.stop')}
          </Button>
        )}
        {actions.logsAvailable && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onViewLogs(app)}
            data-testid="all-apps-inspector-logs"
          >
            <Icons.FileText />
            {t('homeApps.actions.viewLogs')}
          </Button>
        )}
        {actions.uninstallAvailable && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onUninstall(app)}
            data-testid="all-apps-inspector-uninstall"
          >
            <Icons.Trash2 />
            {t('homeApps.actions.uninstall')}
          </Button>
        )}
      </div>
    </div>
  )
}

interface AllAppsRowProps {
  app: CatalogApp
  scopeKey: string
  selected: boolean
  compact: boolean
  status: LocalAppRuntimeStatus | undefined
  statusLoading: boolean
  statusUnavailable: boolean
  compatible: boolean
  offline: boolean
  onSelect: (scopeKey: string) => void
  onPrimaryAction: (app: CatalogApp, action: CatalogPrimaryAction) => void
  onStop: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onViewLogs: (app: CatalogApp) => void
}

function AllAppsRow({
  app,
  scopeKey,
  selected,
  compact,
  status,
  statusLoading,
  statusUnavailable,
  compatible,
  offline,
  onSelect,
  onPrimaryAction,
  onStop,
  onUninstall,
  onViewLogs,
}: AllAppsRowProps) {
  const { t } = useTranslation()
  const actions = useRowActions(
    app,
    status,
    statusLoading,
    statusUnavailable,
    compatible,
    offline,
  )
  const sourceLabel = app.creatorName?.trim() || t('homeApps.allApps.unknownSource')

  return (
    <article
      className={cn(
        'relative flex min-w-0 flex-col rounded-[17px] border bg-[var(--background-elevated)] px-[16px] py-[12px] shadow-xs transition-shadow hover:shadow-minimal',
        selected ? 'border-accent/45' : 'border-foreground/10',
        app.availability !== 'available' && 'opacity-65',
      )}
      data-testid="all-apps-row"
      data-app-id={app.id}
      data-scope-key={scopeKey}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onSelect(scopeKey)}
          aria-expanded={compact ? selected : undefined}
        >
          <AppArtwork app={app} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-foreground">
              {app.name}
            </span>
            <span
              className="mt-0.5 block truncate text-xs text-muted-foreground"
              data-testid="all-apps-row-source"
            >
              {sourceLabel}
            </span>
          </span>
          <span className={cn(
            'hidden shrink-0 truncate text-[11px] text-muted-foreground sm:block sm:max-w-[180px]',
            (status?.status === 'broken' || status?.versionError) && 'text-destructive',
          )}>
            {statusLoading
              ? t('homeApps.status.loading')
              : statusUnavailable
              ? t('homeApps.status.statusUnavailable')
              : statusText(t, app, status, compatible)}
          </span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant={actions.primary === 'unavailable' ? 'secondary' : 'default'}
            disabled={actions.primary === 'unavailable' || actions.busy}
            onClick={() => onPrimaryAction(app, actions.primary)}
            data-testid={`all-apps-action-${app.id}`}
          >
            {actions.busy && <Icons.LoaderCircle className="animate-spin" />}
            {statusLoading
              ? t('homeApps.status.loading')
              : actions.busy
              ? t('homeApps.status.starting')
              : actionLabel(t, actions.primary)}
          </Button>
          {actions.uninstallAvailable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  aria-label={t('homeApps.moreActions', { name: app.name })}
                  data-testid={`all-apps-more-${app.id}`}
                >
                  <Icons.MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {actions.stopAvailable && (
                  <DropdownMenuItem onSelect={() => onStop(app)}>
                    <Icons.Square />
                    {t('homeApps.actions.stop')}
                  </DropdownMenuItem>
                )}
                {actions.logsAvailable && (
                  <DropdownMenuItem onSelect={() => onViewLogs(app)}>
                    <Icons.FileText />
                    {t('homeApps.actions.viewLogs')}
                  </DropdownMenuItem>
                )}
                {actions.stopAvailable && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => onUninstall(app)}
                >
                  <Icons.Trash2 />
                  {t('homeApps.actions.uninstall')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>
      {typeof actions.progress === 'number' && (
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-foreground/10">
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.max(0, Math.min(100, actions.progress))}%` }}
          />
        </div>
      )}
      {compact && selected && (
        <div
          className="mt-3 border-t border-foreground/10 pt-3"
          data-testid="all-apps-row-detail"
        >
          <AppInspectorDetail
            app={app}
            status={status}
            actions={actions}
            statusLoading={statusLoading}
            statusUnavailable={statusUnavailable}
            compatible={compatible}
            offline={offline}
            onPrimaryAction={onPrimaryAction}
            onStop={onStop}
            onUninstall={onUninstall}
            onViewLogs={onViewLogs}
          />
        </div>
      )}
    </article>
  )
}

export function AllAppsView({
  spaceName,
  spaceKind,
  apps,
  loading,
  refreshing,
  warningCode,
  errorCode,
  offline,
  statusErrorCode,
  statusLoadingScopeKeys,
  statusErrorScopeKeys,
  scopeKeyForApp,
  getStatus,
  compatibleWithHost,
  onRefresh,
  onRetryStatuses,
  onPrimaryAction,
  onStop,
  onUninstall,
  onViewLogs,
  onBack,
}: AllAppsViewProps) {
  const { t } = useTranslation()
  const compact = useCompactViewport()
  const [selectedScopeKey, setSelectedScopeKey] = useState<string | null>(null)
  const [pageLimit, setPageLimit] = useState(ALL_APPS_PAGE_SIZE)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredApps = useMemo(() => {
    if (!normalizedQuery) return apps
    return apps.filter(app => [
      app.name,
      app.description,
      app.creatorName,
      ...(app.sourceNames ?? []),
    ].some(value => value?.toLocaleLowerCase().includes(normalizedQuery)))
  }, [apps, normalizedQuery])

  useEffect(() => {
    setPageLimit(ALL_APPS_PAGE_SIZE)
  }, [filteredApps])

  // Fail-closed selection: when the selected entry leaves the current
  // Catalog view (space switch, withdrawal, prune), the inspector closes.
  useEffect(() => {
    if (
      selectedScopeKey
      && !filteredApps.some(app => {
        try {
          return scopeKeyForApp(app) === selectedScopeKey
        } catch {
          return false
        }
      })
    ) {
      setSelectedScopeKey(null)
    }
  }, [filteredApps, scopeKeyForApp, selectedScopeKey])

  const groups = useMemo(
    () => groupAllAppsForDisplay(filteredApps, spaceKind),
    [filteredApps, spaceKind],
  )
  const displayedGroups = useMemo(() => {
    let budget = pageLimit
    const next: AllAppsSourceGroup[] = []
    for (const group of groups) {
      if (budget <= 0) break
      const slice = group.apps.slice(0, budget)
      budget -= slice.length
      next.push({ ...group, apps: slice })
    }
    return next
  }, [groups, pageLimit])
  const displayedCount = displayedGroups.reduce(
    (total, group) => total + group.apps.length,
    0,
  )
  const selectedApp = selectedScopeKey
    ? filteredApps.find(app => {
        try {
          return scopeKeyForApp(app) === selectedScopeKey
        } catch {
          return false
        }
      }) ?? null
    : null

  return (
    <section
      aria-labelledby="all-apps-heading"
      data-testid="all-apps-view"
    >
      <div className="mb-[18px] flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <button
            type="button"
            className="mb-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-muted-foreground outline-none hover:bg-foreground/4 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onBack}
            data-testid="all-apps-back"
          >
            <Icons.ArrowLeft className="size-4" />
            {t('homeApps.allApps.back')}
          </button>
          <h2
            id="all-apps-heading"
            className="truncate text-[20px] font-[720] leading-[1.2] tracking-[-0.03em]"
          >
            {t('homeApps.allApps.title', { name: spaceName })}
          </h2>
          <p className="mt-[6px] text-[13px] text-muted-foreground">
            {spaceKind === 'enterprise'
              ? t('homeApps.allApps.enterpriseDescription')
              : t('homeApps.allApps.personalDescription')}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={refreshing}
          onClick={onRefresh}
        >
          <Icons.RefreshCw className={refreshing ? 'animate-spin' : ''} />
          {t('homeApps.actions.refresh')}
        </Button>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="relative min-w-[220px] flex-1">
          <Icons.Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('homeApps.allApps.searchPlaceholder')}
            aria-label={t('homeApps.allApps.searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-foreground/10 bg-[var(--background-elevated)] pl-9 pr-3 text-sm outline-none placeholder:text-muted-foreground focus:border-accent/45 focus:ring-2 focus:ring-ring/30"
            data-testid="all-apps-search"
          />
        </label>
        <span className="text-xs text-muted-foreground" data-testid="all-apps-count">
          {t('homeApps.allApps.count', { count: filteredApps.length })}
        </span>
      </div>

      {warningCode && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <Icons.WifiOff className="size-4 shrink-0" />
          {catalogStateMessage(t, warningCode, 'warning')}
        </div>
      )}

      {statusErrorCode && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <span className="flex items-center gap-2">
            <Icons.CircleAlert className="size-4 shrink-0" />
            {t('homeApps.errors.statusReadFailed')}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onRetryStatuses}
          >
            {t('homeApps.actions.tryAgain')}
          </Button>
        </div>
      )}

      {loading ? (
        <div
          className="flex min-h-32 items-center justify-center rounded-xl border border-foreground/10"
          data-testid="all-apps-loading"
        >
          <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : errorCode && apps.length === 0 ? (
        <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-foreground/10 px-6 text-center">
          <Icons.CloudOff className="mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">
            {t('homeApps.allApps.loadFailed')}
          </p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            {catalogStateMessage(t, errorCode, 'error')}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="mt-4"
            onClick={onRefresh}
          >
            {t('homeApps.actions.tryAgain')}
          </Button>
        </div>
      ) : apps.length === 0 ? (
        <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-foreground/15 px-6 text-center">
          <Icons.LayoutGrid className="mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">
            {t('homeApps.allApps.empty')}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {spaceKind === 'enterprise'
              ? t('homeApps.allApps.emptyEnterprise')
              : t('homeApps.allApps.emptyPersonal')}
          </p>
        </div>
      ) : filteredApps.length === 0 ? (
        <div className="flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-foreground/15 px-6 text-center" data-testid="all-apps-no-results">
          <Icons.SearchX className="mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{t('homeApps.allApps.noResults')}</p>
        </div>
      ) : (
        <div
          className={cn(
            'flex gap-4',
            compact ? 'flex-col' : 'items-start',
          )}
        >
          <div className={cn(
            'flex min-w-0 flex-col gap-[10px]',
            !compact && 'flex-1',
          )}>
            {displayedGroups.map(group => (
              <div key={group.key} className="flex flex-col gap-[10px]">
                {group.label && (
                  <h3
                    className="mt-2 truncate text-[13px] font-semibold text-foreground/70"
                    data-testid="all-apps-group-label"
                  >
                    {group.label}
                  </h3>
                )}
                {group.apps.map(app => {
                  const scopeKey = scopeKeyForApp(app)
                  const status = getStatus(app)
                  return (
                    <AllAppsRow
                      key={scopeKey}
                      app={app}
                      scopeKey={scopeKey}
                      selected={selectedScopeKey === scopeKey}
                      compact={compact}
                      status={status}
                      statusLoading={Boolean(statusLoadingScopeKeys[scopeKey])}
                      statusUnavailable={Boolean(
                        !status
                        && !statusLoadingScopeKeys[scopeKey]
                        && statusErrorScopeKeys[scopeKey],
                      )}
                      compatible={compatibleWithHost(app)}
                      offline={offline}
                      onSelect={setSelectedScopeKey}
                      onPrimaryAction={onPrimaryAction}
                      onStop={onStop}
                      onUninstall={onUninstall}
                      onViewLogs={onViewLogs}
                    />
                  )
                })}
              </div>
            ))}
            {displayedCount < filteredApps.length && (
              <div className="mt-3 flex justify-center">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setPageLimit(current => current + ALL_APPS_PAGE_SIZE)}
                >
                  {t('homeApps.actions.loadMore')}
                </Button>
              </div>
            )}
          </div>
          {!compact && selectedApp && (
            <aside
              className="sticky top-0 w-[320px] shrink-0 rounded-[17px] border border-foreground/10 bg-[var(--background-elevated)] p-[20px] shadow-xs"
              data-testid="all-apps-inspector"
            >
              <AppInspectorDetail
                app={selectedApp}
                status={getStatus(selectedApp)}
                actions={computeRowActions(
                  selectedApp,
                  getStatus(selectedApp),
                  Boolean(statusLoadingScopeKeys[selectedScopeKey!]),
                  Boolean(
                    !getStatus(selectedApp)
                    && !statusLoadingScopeKeys[selectedScopeKey!]
                    && statusErrorScopeKeys[selectedScopeKey!],
                  ),
                  compatibleWithHost(selectedApp),
                  offline,
                )}
                statusLoading={Boolean(statusLoadingScopeKeys[selectedScopeKey!])}
                statusUnavailable={Boolean(
                  !getStatus(selectedApp)
                  && !statusLoadingScopeKeys[selectedScopeKey!]
                  && statusErrorScopeKeys[selectedScopeKey!],
                )}
                compatible={compatibleWithHost(selectedApp)}
                offline={offline}
                onPrimaryAction={onPrimaryAction}
                onStop={onStop}
                onUninstall={onUninstall}
                onViewLogs={onViewLogs}
              />
            </aside>
          )}
        </div>
      )}
    </section>
  )
}
