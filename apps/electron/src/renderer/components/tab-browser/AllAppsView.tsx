import { useEffect, useMemo, useState } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { ProductSpaceAppInstallState } from '@polo-ai/shared/protocol'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useCompactViewport } from '@/lib/use-compact-viewport'
import { catalogStateMessage } from '@/lib/home-app-errors'
import { AppArtwork } from './OrganizationAppCard'

export const ALL_APPS_PAGE_SIZE = 60

export interface AllAppsSourceGroup {
  key: string
  label: string
  apps: CatalogApp[]
}

export function groupAllAppsForDisplay(
  apps: readonly CatalogApp[],
  spaceKind: 'personal' | 'enterprise' | null,
): AllAppsSourceGroup[] {
  if (spaceKind !== 'personal') return [{ key: 'all', label: '', apps: [...apps] }]
  const groups = new Map<string, { order: number; apps: CatalogApp[] }>()
  apps.forEach((app, index) => {
    const label = app.sourceNames?.[0]?.trim() || app.creatorName?.trim() || ''
    const key = label || '__unknown__'
    const group = groups.get(key)
    if (group) group.apps.push(app)
    else groups.set(key, { order: index, apps: [app] })
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
  getInstallState: (app: CatalogApp) => ProductSpaceAppInstallState | undefined
  scopeKeyForApp: (app: CatalogApp) => string
  onRefresh: () => void
  onOpen: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onBack: () => void
}

function AppAvailability({
  app,
  installState,
  offline,
}: {
  app: CatalogApp
  installState?: ProductSpaceAppInstallState
  offline: boolean
}) {
  const { t } = useTranslation()
  let label = t('homeApps.status.available')
  if (app.availability !== 'available') label = t('homeApps.status.unauthorized')
  else if (offline) label = t('homeApps.status.offline')
  else if (installState?.state === 'installing') label = t('homeApps.status.installing')
  else if (installState?.state === 'installed') label = t('homeApps.status.installed')
  return <span className="text-[11px] text-muted-foreground">{label}</span>
}

function AppDetail({
  app,
  installState,
  offline,
  onOpen,
  onUninstall,
}: {
  app: CatalogApp
  installState?: ProductSpaceAppInstallState
  offline: boolean
  onOpen: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
}) {
  const { t } = useTranslation()
  const source = app.creatorName?.trim() || t('homeApps.allApps.unknownSource')
  const unavailable = app.availability !== 'available' || offline
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="all-apps-inspector-body">
      <div className="flex items-start gap-3">
        <AppArtwork app={app} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{app.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground" data-testid="all-apps-inspector-source">
            {source}
          </p>
        </div>
      </div>
      <p className="text-xs leading-[18px] text-foreground/65">
        {app.description || t('homeApps.noDescription')}
      </p>
      <dl className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3 text-xs">
        <div>
          <dt className="text-muted-foreground">{t('homeApps.allApps.sourceLabel')}</dt>
          <dd className="mt-1 truncate font-medium" data-testid="all-apps-inspector-source-value">{source}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('homeApps.install.version')}</dt>
          <dd className="mt-1 truncate font-medium">{app.catalogVersion?.version || '—'}</dd>
        </div>
      </dl>
      <div>
        <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t('homeApps.install.permissions')}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {app.permissions?.length
            ? app.permissions.join(' · ')
            : t('homeApps.install.noPermissions')}
        </p>
      </div>
      <AppAvailability app={app} installState={installState} offline={offline} />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={unavailable || installState?.state === 'installing'}
          onClick={() => onOpen(app)}
          data-testid="all-apps-inspector-primary"
        >
          {installState?.state === 'installing' && <Icons.LoaderCircle className="animate-spin" />}
          {t('common.open')}
        </Button>
        {installState?.state === 'installed' && (
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

function AllAppsRow({
  app,
  scopeKey,
  selected,
  compact,
  installState,
  offline,
  onSelect,
  onOpen,
  onUninstall,
}: {
  app: CatalogApp
  scopeKey: string
  selected: boolean
  compact: boolean
  installState?: ProductSpaceAppInstallState
  offline: boolean
  onSelect: (scopeKey: string) => void
  onOpen: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
}) {
  const { t } = useTranslation()
  const source = app.creatorName?.trim() || t('homeApps.allApps.unknownSource')
  const unavailable = app.availability !== 'available' || offline
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
            <span className="block truncate text-sm font-semibold">{app.name}</span>
            <span className="mt-0.5 block truncate text-xs text-muted-foreground" data-testid="all-apps-row-source">
              {source}
            </span>
          </span>
          <span className="hidden shrink-0 sm:block">
            <AppAvailability app={app} installState={installState} offline={offline} />
          </span>
        </button>
        <Button
          type="button"
          size="sm"
          disabled={unavailable || installState?.state === 'installing'}
          onClick={() => onOpen(app)}
          data-testid={`all-apps-action-${app.id}`}
        >
          {installState?.state === 'installing' && <Icons.LoaderCircle className="animate-spin" />}
          {t('common.open')}
        </Button>
      </div>
      {compact && selected && (
        <div className="mt-3 border-t border-foreground/10 pt-3" data-testid="all-apps-row-detail">
          <AppDetail
            app={app}
            installState={installState}
            offline={offline}
            onOpen={onOpen}
            onUninstall={onUninstall}
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
  getInstallState,
  scopeKeyForApp,
  onRefresh,
  onOpen,
  onUninstall,
  onBack,
}: AllAppsViewProps) {
  const { t } = useTranslation()
  const compact = useCompactViewport()
  const [selectedScopeKey, setSelectedScopeKey] = useState<string | null>(null)
  const [pageLimit, setPageLimit] = useState(ALL_APPS_PAGE_SIZE)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredApps = useMemo(() => !normalizedQuery ? apps : apps.filter(app => [
    app.name,
    app.description,
    app.creatorName,
    ...(app.sourceNames ?? []),
  ].some(value => value?.toLocaleLowerCase().includes(normalizedQuery))), [apps, normalizedQuery])

  useEffect(() => setPageLimit(ALL_APPS_PAGE_SIZE), [filteredApps])
  useEffect(() => {
    if (selectedScopeKey && !filteredApps.some(app => {
      try { return scopeKeyForApp(app) === selectedScopeKey } catch { return false }
    })) setSelectedScopeKey(null)
  }, [filteredApps, scopeKeyForApp, selectedScopeKey])

  const groups = useMemo(
    () => groupAllAppsForDisplay(filteredApps, spaceKind),
    [filteredApps, spaceKind],
  )
  const displayedGroups = useMemo(() => {
    let budget = pageLimit
    return groups.flatMap(group => {
      if (budget <= 0) return []
      const visible = group.apps.slice(0, budget)
      budget -= visible.length
      return [{ ...group, apps: visible }]
    })
  }, [groups, pageLimit])
  const displayedCount = displayedGroups.reduce((sum, group) => sum + group.apps.length, 0)
  const selectedApp = selectedScopeKey
    ? filteredApps.find(app => {
        try { return scopeKeyForApp(app) === selectedScopeKey } catch { return false }
      }) ?? null
    : null

  return (
    <section aria-labelledby="all-apps-heading" data-testid="all-apps-view">
      <div className="mb-[18px] flex flex-col items-start justify-between gap-4 sm:flex-row">
        <div className="min-w-0">
          <button
            type="button"
            className="mb-2 inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[13px] text-muted-foreground hover:bg-foreground/4"
            onClick={onBack}
            data-testid="all-apps-back"
          >
            <Icons.ArrowLeft className="size-4" />
            {t('homeApps.allApps.back')}
          </button>
          <h2 id="all-apps-heading" className="truncate text-[20px] font-[720] tracking-[-0.03em]">
            {t('homeApps.allApps.title', { name: spaceName })}
          </h2>
          <p className="mt-[6px] text-[13px] text-muted-foreground">
            {spaceKind === 'enterprise'
              ? t('homeApps.allApps.enterpriseDescription')
              : t('homeApps.allApps.personalDescription')}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
          <Icons.RefreshCw className={cn(refreshing && 'animate-spin')} />
          {t('homeApps.actions.refresh')}
        </Button>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <label className="relative min-w-0 flex-1">
          <Icons.Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('homeApps.allApps.searchPlaceholder')}
            className="h-9 w-full rounded-lg border border-foreground/10 bg-background pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            data-testid="all-apps-search"
          />
        </label>
        <span className="shrink-0 text-xs text-muted-foreground" data-testid="all-apps-count">
          {t('homeApps.allApps.count', { count: filteredApps.length })}
        </span>
      </div>

      {(warningCode || offline) && (
        <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
          {offline
            ? t('homeApps.organization.offlineWarning')
            : catalogStateMessage(t, warningCode, 'warning')}
        </div>
      )}

      {loading && apps.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center"><Icons.LoaderCircle className="animate-spin" /></div>
      ) : errorCode && apps.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center text-center">
          <Icons.CloudOff className="mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{catalogStateMessage(t, errorCode, 'error')}</p>
          <Button type="button" size="sm" variant="secondary" className="mt-4" onClick={onRefresh}>
            {t('homeApps.actions.tryAgain')}
          </Button>
        </div>
      ) : filteredApps.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center text-sm text-muted-foreground" data-testid="all-apps-empty">
          {normalizedQuery ? t('homeApps.allApps.noResults') : t('homeApps.organization.empty')}
        </div>
      ) : (
        <div className={cn('grid gap-4', !compact && selectedApp && 'lg:grid-cols-[minmax(0,1fr)_320px]')}>
          <div className="space-y-5">
            {displayedGroups.map(group => (
              <div key={group.key}>
                {group.label && <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{group.label}</h3>}
                <div className="space-y-2">
                  {group.apps.map(app => {
                    const scopeKey = scopeKeyForApp(app)
                    return (
                      <AllAppsRow
                        key={scopeKey}
                        app={app}
                        scopeKey={scopeKey}
                        selected={selectedScopeKey === scopeKey}
                        compact={compact}
                        installState={getInstallState(app)}
                        offline={offline}
                        onSelect={setSelectedScopeKey}
                        onOpen={onOpen}
                        onUninstall={onUninstall}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
            {displayedCount < filteredApps.length && (
              <Button type="button" variant="secondary" onClick={() => setPageLimit(limit => limit + ALL_APPS_PAGE_SIZE)}>
                {t('homeApps.actions.loadMore')}
              </Button>
            )}
          </div>
          {!compact && selectedApp && (
            <aside className="sticky top-0 h-fit rounded-[17px] border border-foreground/10 bg-[var(--background-elevated)] p-4" data-testid="all-apps-inspector">
              <AppDetail
                app={selectedApp}
                installState={getInstallState(selectedApp)}
                offline={offline}
                onOpen={onOpen}
                onUninstall={onUninstall}
              />
            </aside>
          )}
        </div>
      )}
    </section>
  )
}
