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
  /** Number of creator circles visible in the active space's Catalog. */
  circleCount: number
  /** Authoritative identity keys currently pinned to the home quick access. */
  pinnedIds: ReadonlySet<string>
  /** Pins an App to the home quick access; persistence is owned by HomePage. */
  onPin: (app: CatalogApp) => void
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
  installState,
  offline,
  spaceKind,
  pinned,
  onOpen,
  onPin,
  onUninstall,
}: {
  app: CatalogApp
  identityKey: string
  installState?: ProductSpaceAppInstallState
  offline: boolean
  spaceKind: 'personal' | 'enterprise' | null
  pinned: boolean
  onOpen: (app: CatalogApp) => void
  onPin: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
}) {
  const { t } = useTranslation()
  const unavailable = isCatalogAppUnavailable(app, offline)
  const blocked = (app.availability as string) === 'blocked'
  const uninstallable = isCatalogAppUninstallable(installState)
  return (
    <article
      className={cn(
        'flex min-h-[222px] max-[1080px]:min-h-[210px] flex-col rounded-[17px] border bg-surface p-5 shadow-xs transition-shadow hover:shadow-minimal max-[1080px]:p-[18px]',
        unavailable ? 'border-foreground/10 opacity-65' : 'border-foreground/10',
      )}
      data-testid="all-apps-row"
      data-app-id={app.id}
      data-identity-key={identityKey}
    >
      <AppArtwork app={app} />
      <h3 className="m-0 mt-[26px] text-base font-semibold">{app.name}</h3>
      {app.sourceNames?.length ? (
        <div className="mt-[6px] flex flex-wrap items-center gap-[6px]">
          {app.sourceNames.map(sourceName => (
            <span
              key={sourceName}
              className="inline-flex items-center rounded-md bg-accent/12 px-[7px] py-[2px] text-[10px] text-accent"
              data-testid="all-apps-row-source"
            >
              {t('homeApps.allApps.fromSource', { source: sourceName })}
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-[6px] text-xs text-muted-foreground">
          {app.creatorName?.trim() || t('homeApps.allApps.unknownSource')}
        </p>
      )}
      <p className="mt-[17px] text-[13px] leading-[1.6] text-muted-foreground">
        {app.description || t('homeApps.noDescription')}
      </p>
      {(app.creatorName?.trim() || app.catalogVersion?.version) && (
        <p className="mt-[4px] text-xs text-muted-foreground">
          {[
            app.creatorName?.trim(),
            app.catalogVersion?.version ? `v${app.catalogVersion.version}` : null,
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      <AppAvailability app={app} installState={installState} offline={offline} spaceKind={spaceKind} />
      <div className="mt-auto flex flex-wrap items-center justify-end gap-[7px] pt-[14px]">
        {blocked && (
          <span className="inline-flex min-h-[20px] items-center gap-[5px] rounded-md bg-danger/12 px-[7px] py-[2px] text-[10px] text-danger before:block before:size-[5px] before:rounded-full before:bg-current">
            {t('homeApps.status.blocked')}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="min-h-[32px] rounded-lg border-0 px-3 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => onPin(app)}
          data-testid={`all-apps-pin-${identityKey}`}
        >
          {pinned
            ? t('homeApps.actions.pinnedToHome')
            : t('homeApps.actions.pinToHome')}
        </Button>
        {blocked ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[32px] rounded-lg border-0 px-3 text-xs text-muted-foreground hover:text-foreground"
            data-testid={`all-apps-reason-${identityKey}`}
          >
            {t('homeApps.allApps.viewReason')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            className="min-h-[32px] rounded-lg border border-accent bg-accent px-3 text-xs font-semibold text-primary-foreground hover:bg-accent/90"
            disabled={unavailable || installState?.state === 'installing'}
            onClick={() => onOpen(app)}
            data-testid={`all-apps-action-${identityKey}`}
          >
            {installState?.state === 'installing' && <Icons.LoaderCircle className="animate-spin" />}
            {t('common.open')}
          </Button>
        )}
        {uninstallable && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-h-[32px] rounded-lg border-0 px-3 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => onUninstall(app)}
            data-testid={`all-apps-uninstall-${identityKey}`}
          >
            {t('homeApps.actions.uninstall')}
          </Button>
        )}
      </div>
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
  circleCount,
  pinnedIds,
  onPin,
  getInstallState,
  identityKeyForApp,
  onRefresh,
  onOpen,
  onUninstall,
  onBack,
}: AllAppsViewProps) {
  const { t } = useTranslation()
  const compact = useCompactViewport()
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
  return (
    <section aria-labelledby="all-apps-heading" data-testid="all-apps-view">
      <div className="mb-[26px] flex items-end justify-between gap-5">
        <div className="min-w-0">
          <p className="m-0 text-xs text-muted-foreground">{spaceName}</p>
          <h1
            id="all-apps-heading"
            className="m-0 mt-[6px] text-[28px] font-semibold leading-[1.15] tracking-[-0.04em]"
          >
            {t('homeApps.allApps.title')}
          </h1>
          <p className="mt-[10px] text-[13px] text-muted-foreground">
            {t('homeApps.allApps.subtitle')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={refreshing} onClick={onRefresh}>
            <Icons.RefreshCw className={cn(refreshing && 'animate-spin')} />
            {t('homeApps.actions.refresh')}
          </Button>
          <button
            type="button"
            data-testid="all-apps-back"
            onClick={onBack}
            className="inline-flex min-h-[32px] items-center rounded-lg px-[10px] text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            {t('homeApps.allApps.back')}
          </button>
        </div>
      </div>

      <div className="mb-[24px] flex items-end justify-between gap-[18px]">
        <label className="grid w-[min(480px,100%)] gap-[7px]">
          <span className="text-xs text-muted-foreground">{t('homeApps.allApps.searchLabel')}</span>
          <span className="relative block">
            <Icons.Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('homeApps.allApps.searchPlaceholder')}
              className="h-[42px] w-full rounded-lg border border-foreground/10 bg-background pl-[13px] pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              data-testid="all-apps-search"
            />
          </span>
        </label>
        <span className="shrink-0 pb-1 text-xs text-muted-foreground" data-testid="all-apps-count">
          {t('homeApps.allApps.countVisible', { visible: filteredApps.length, total: apps.length })}
        </span>
      </div>

      <div className="mb-[18px]">
        <h2 className="m-0 text-[20px] tracking-[-0.03em]">{t('homeApps.allApps.sectionTitle')}</h2>
        <p className="mt-[6px] text-sm text-muted-foreground">
          {t('homeApps.allApps.circlesDescription', { count: circleCount })}
        </p>
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
        <div className="grid grid-cols-1 gap-[16px] min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
          {displayedGroups.flatMap(group => group.apps.map(app => {
            const identityKey = identityKeyForApp(app)
            const installState = getInstallState(app)
            const pinned = pinnedIds.has(identityKey)
            return (
              <AllAppsRow
                key={identityKey}
                app={app}
                identityKey={identityKey}
                installState={installState}
                offline={offline}
                spaceKind={spaceKind}
                pinned={pinnedIds.has(identityKey)}
                onOpen={onOpen}
                onPin={onPin}
                onUninstall={onUninstall}
              />
            )
          }))}
          {displayedCount < filteredApps.length && (
            <Button type="button" variant="secondary" onClick={() => setPageLimit(limit => limit + ALL_APPS_PAGE_SIZE)}>
              {t('homeApps.actions.loadMore')}
            </Button>
          )}
        </div>
      )}
    </section>
  )
}
