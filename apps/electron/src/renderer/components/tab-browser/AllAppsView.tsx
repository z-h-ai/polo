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
  /** Authorization was lost for the current snapshot (denied view). */
  restricted: boolean
  getInstallState: (app: CatalogApp) => ProductSpaceAppInstallState | undefined
  identityKeyForApp: (app: CatalogApp) => string
  onRefresh: () => void
  onOpen: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onBack: () => void
}

/**
 * Frozen blocked-state copy per authoritative Catalog unavailability reason.
 * Governance/version blocks must never be misreported as an authorization
 * loss, so every reason maps to its own status key and an unknown shape
 * falls back to a neutral "unavailable" instead of the revocation copy.
 * Authorization-ending and withdrawal copy is space-aware: personal circles
 * must not be told their "organization" removed access.
 */
export function catalogAppBlockedStatusKey(
  app: Pick<CatalogApp, 'availability' | 'unavailableReason'>,
  spaceKind: 'personal' | 'enterprise' | null = null,
): string {
  switch (app.unavailableReason) {
    case 'authorization_ended':
      return spaceKind === 'enterprise'
        ? 'homeApps.status.unauthorized'
        : 'homeApps.status.unauthorizedPersonal'
    case 'space_restricted':
      return 'homeApps.status.spaceRestricted'
    case 'version_unavailable':
      return 'homeApps.status.versionUnavailable'
    case 'version_blocked':
      return 'homeApps.status.versionBlocked'
    default:
      return 'homeApps.status.unavailableGeneric'
  }
}

export function catalogAppWithdrawnStatusKey(
  spaceKind: 'personal' | 'enterprise' | null = null,
): string {
  return spaceKind === 'enterprise'
    ? 'homeApps.status.withdrawn'
    : 'homeApps.status.withdrawnPersonal'
}

function AppAvailability({
  app,
  installState,
  offline,
  spaceKind,
}: {
  app: CatalogApp
  installState?: ProductSpaceAppInstallState
  offline: boolean
  spaceKind: 'personal' | 'enterprise' | null
}) {
  const { t } = useTranslation()
  let label = t('homeApps.status.available')
  if (app.availability === 'withdrawn') {
    label = t(catalogAppWithdrawnStatusKey(spaceKind))
  } else if (app.availability !== 'available') {
    label = t(catalogAppBlockedStatusKey(app, spaceKind))
  } else if (offline) label = t('homeApps.status.offline')
  else if (installState?.state === 'installing') label = t('homeApps.status.installing')
  else if (installState?.state === 'installed') label = t('homeApps.status.installed')
  return <span className="text-[11px] text-muted-foreground">{label}</span>
}

/**
 * Shared row/inspector policy: a row is unavailable when the Catalog does
 * not offer it as available (or the session is offline), and the uninstall
 * entry exists exactly while the member retains an installation on this
 * device (including installed withdrawn tombstones — their install state is
 * projected through the restricted withdrawn-management identity).
 */
export function isCatalogAppUnavailable(
  app: Pick<CatalogApp, 'availability'>,
  offline: boolean,
): boolean {
  return app.availability !== 'available' || offline
}

export function isCatalogAppUninstallable(
  installState?: ProductSpaceAppInstallState,
): boolean {
  return installState?.state === 'installed'
}

function AppDetail({
  app,
  installState,
  offline,
  spaceKind,
  onOpen,
  onUninstall,
}: {
  app: CatalogApp
  installState?: ProductSpaceAppInstallState
  offline: boolean
  spaceKind: 'personal' | 'enterprise' | null
  onOpen: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
}) {
  const { t } = useTranslation()
  const source = app.creatorName?.trim() || t('homeApps.allApps.unknownSource')
  const unavailable = isCatalogAppUnavailable(app, offline)
  const uninstallable = isCatalogAppUninstallable(installState)
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
      <AppAvailability app={app} installState={installState} offline={offline} spaceKind={spaceKind} />
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
        {uninstallable && (
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
  identityKey,
  selected,
  compact,
  installState,
  offline,
  spaceKind,
  onSelect,
  onOpen,
  onUninstall,
}: {
  app: CatalogApp
  identityKey: string
  selected: boolean
  compact: boolean
  installState?: ProductSpaceAppInstallState
  offline: boolean
  spaceKind: 'personal' | 'enterprise' | null
  onSelect: (identityKey: string) => void
  onOpen: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
}) {
  const { t } = useTranslation()
  const source = app.creatorName?.trim() || t('homeApps.allApps.unknownSource')
  const unavailable = isCatalogAppUnavailable(app, offline)
  const uninstallable = isCatalogAppUninstallable(installState)
  return (
    <article
      className={cn(
        'relative flex min-w-0 flex-col rounded-[17px] border bg-[var(--background-elevated)] px-[16px] py-[12px] shadow-xs transition-shadow hover:shadow-minimal',
        selected ? 'border-accent/45' : 'border-foreground/10',
        app.availability !== 'available' && 'opacity-65',
      )}
      data-testid="all-apps-row"
      data-app-id={app.id}
      data-identity-key={identityKey}
    >
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onSelect(identityKey)}
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
            <AppAvailability app={app} installState={installState} offline={offline} spaceKind={spaceKind} />
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
            spaceKind={spaceKind}
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
  restricted,
  getInstallState,
  identityKeyForApp,
  onRefresh,
  onOpen,
  onUninstall,
  onBack,
}: AllAppsViewProps) {
  const { t } = useTranslation()
  const compact = useCompactViewport()
  const [selectedIdentityKey, setSelectedIdentityKey] = useState<string | null>(null)
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
    if (selectedIdentityKey && !filteredApps.some(app => {
      try { return identityKeyForApp(app) === selectedIdentityKey } catch { return false }
    })) setSelectedIdentityKey(null)
  }, [filteredApps, identityKeyForApp, selectedIdentityKey])

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
  const selectedApp = selectedIdentityKey
    ? filteredApps.find(app => {
        try { return identityKeyForApp(app) === selectedIdentityKey } catch { return false }
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

      {(() => {
        // Frozen failure/restricted states: a refresh failure with cached
        // rows shows the stale-catalog banner; a denied snapshot shows the
        // space-aware restricted copy. Both are informational only — the
        // install/open fail-closed gates below are never relaxed.
        const cachedFailure = Boolean(errorCode) && apps.length > 0
        if (restricted) {
          return (
            <div
              className="mb-4 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-900 dark:text-red-100"
              data-testid="all-apps-restricted-banner"
            >
              {catalogStateMessage(t, errorCode ?? 'FORBIDDEN', 'error', spaceKind)}
            </div>
          )
        }
        if (cachedFailure) {
          return (
            <div
              className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-900 dark:text-amber-100"
              data-testid="all-apps-stale-catalog-banner"
            >
              {t('homeApps.organization.refreshWarning')}
            </div>
          )
        }
        if (warningCode || offline) {
          return (
            <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/8 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
              {offline
                ? t('homeApps.organization.offlineWarning')
                : catalogStateMessage(t, warningCode, 'warning', spaceKind)}
            </div>
          )
        }
        return null
      })()}

      {loading && apps.length === 0 ? (
        <div className="flex min-h-40 items-center justify-center"><Icons.LoaderCircle className="animate-spin" /></div>
      ) : errorCode && apps.length === 0 ? (
        <div className="flex min-h-40 flex-col items-center justify-center text-center">
          <Icons.CloudOff className="mb-3 size-6 text-muted-foreground" />
          <p className="text-sm font-medium" data-testid="all-apps-load-failed">
            {t('homeApps.allApps.loadFailed')}
          </p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">
            {catalogStateMessage(t, errorCode, 'error', spaceKind)}
          </p>
          <Button type="button" size="sm" variant="secondary" className="mt-4" onClick={onRefresh}>
            {t('homeApps.actions.tryAgain')}
          </Button>
        </div>
      ) : filteredApps.length === 0 ? (
        <div
          className="flex min-h-40 flex-col items-center justify-center gap-1 text-center"
          data-testid="all-apps-empty"
        >
          <p className="text-sm text-muted-foreground">
            {normalizedQuery ? t('homeApps.allApps.noResults') : t('homeApps.allApps.empty')}
          </p>
          {!normalizedQuery && (
            <p className="max-w-md text-xs text-muted-foreground">
              {spaceKind === 'enterprise'
                ? t('homeApps.allApps.emptyEnterprise')
                : t('homeApps.allApps.emptyPersonal')}
            </p>
          )}
        </div>
      ) : (
        <div className={cn('grid gap-4', !compact && selectedApp && 'lg:grid-cols-[minmax(0,1fr)_320px]')}>
          <div className="space-y-5">
            {displayedGroups.map(group => (
              <div key={group.key}>
                {group.label && <h3 className="mb-2 text-xs font-semibold text-muted-foreground">{group.label}</h3>}
                <div className="space-y-2">
                  {group.apps.map(app => {
                    const identityKey = identityKeyForApp(app)
                    return (
                      <AllAppsRow
                        key={identityKey}
                        app={app}
                        identityKey={identityKey}
                        selected={selectedIdentityKey === identityKey}
                        compact={compact}
                        installState={getInstallState(app)}
                        offline={offline}
                        spaceKind={spaceKind}
                        onSelect={setSelectedIdentityKey}
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
                spaceKind={spaceKind}
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
