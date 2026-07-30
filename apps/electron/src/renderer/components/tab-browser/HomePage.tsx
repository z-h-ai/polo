import { useMemo, useState } from 'react'
import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { CatalogApp } from '@polo-ai/shared/admin'
import { AppIcon } from './AppIcon'
import {
  OrganizationAppCard,
  type CatalogPrimaryAction,
} from './OrganizationAppCard'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useAppCatalog } from '@/hooks/useAppCatalog'
import { useTabShell } from '@/context/TabShellContext'
import {
  get as getLocalStorage,
  KEYS,
  set as setLocalStorage,
} from '@/lib/local-storage'
import {
  BUILTIN_APP_IDS,
  type AppDefinition,
} from '../../../shared/tab-browser-types'
import {
  catalogStateMessage,
  getHomeAppErrorCode,
  homeAppOperationErrorText,
} from '@/lib/home-app-errors'

interface HomePageProps {
  onAddApp: () => void
}

interface RecentApp {
  id: string
  kind: 'builtin' | 'external' | 'organization'
  openedAt: number
}

const MAX_RECENT_APPS = 6

function readRecentApps(): RecentApp[] {
  const raw = getLocalStorage<unknown>(KEYS.homeRecentApps, [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is RecentApp => (
      item
      && typeof item === 'object'
      && typeof item.id === 'string'
      && ['builtin', 'external', 'organization'].includes(item.kind)
      && typeof item.openedAt === 'number'
    ))
    .slice(0, MAX_RECENT_APPS)
}

function writeRecentApps(apps: RecentApp[]): void {
  setLocalStorage(KEYS.homeRecentApps, apps.slice(0, MAX_RECENT_APPS))
}

function formatBytes(t: TFunction, sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return t('homeApps.install.unknownSize')
  }
  const units = ['B', 'KB', 'MB', 'GB']
  let size = sizeBytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function catalogTabDefinition(
  scopeKey: string,
  app: CatalogApp,
  url: string,
): AppDefinition {
  return {
    id: `organization:${scopeKey}`,
    name: app.name,
    url,
    iconUrl: app.iconUrl,
    type: 'webapp',
    createdAt: 0,
    order: app.sortOrder,
  }
}

function catalogRecentId(scopeKey: string): string {
  return scopeKey
}

function AddExternalAppTile({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      className="titlebar-no-drag group flex min-w-0 flex-col items-center gap-3 rounded-lg border border-transparent p-3 text-center outline-none transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/10 hover:bg-foreground/4 hover:shadow-minimal focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onClick}
      data-testid="add-external-app"
    >
      <span className="flex h-[76px] w-[76px] items-center justify-center rounded-lg border border-dashed border-foreground/20 bg-foreground/3 shadow-xs transition-all duration-200 ease-out group-hover:scale-[1.04] group-hover:border-accent/45 group-hover:bg-accent/8">
        <Icons.Plus className="h-8 w-8 text-foreground/55 group-hover:text-accent" strokeWidth={1.5} />
      </span>
      <span className="min-h-9 max-w-[112px] text-sm font-medium leading-[18px] text-foreground/70 group-hover:text-foreground">
        {t('homeApps.addExternal.title')}
      </span>
    </button>
  )
}

export function HomePage({ onAddApp }: HomePageProps) {
  const { t } = useTranslation()
  const { installedApps, openApp, removeApp } = useTabShell()
  const catalog = useAppCatalog()
  const [recentApps, setRecentApps] = useState(readRecentApps)
  const [installTarget, setInstallTarget] = useState<CatalogApp | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)
  const [preserveData, setPreserveData] = useState(true)
  const [logsTarget, setLogsTarget] = useState<CatalogApp | null>(null)
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)

  const externalApps = useMemo(
    () => installedApps
      .filter(app => app.type === 'webapp' && !BUILTIN_APP_IDS.has(app.id))
      .sort((left, right) => left.order - right.order),
    [installedApps],
  )
  const builtinApps = useMemo(
    () => installedApps
      .filter(app => BUILTIN_APP_IDS.has(app.id))
      .sort((left, right) => left.order - right.order),
    [installedApps],
  )
  const organizationApps = useMemo(
    () => [...(catalog.state.catalog?.apps ?? [])]
      .sort((left, right) => left.sortOrder - right.sortOrder),
    [catalog.state.catalog?.apps],
  )
  const activeOrganization = catalog.organization?.organizationSummaries.find(
    item => item.id === catalog.organization?.activeOrganizationId,
  )

  const recordRecent = (
    id: string,
    kind: RecentApp['kind'],
  ) => {
    setRecentApps(current => {
      const next = [
        { id, kind, openedAt: Date.now() },
        ...current.filter(item => !(item.id === id && item.kind === kind)),
      ].slice(0, MAX_RECENT_APPS)
      writeRecentApps(next)
      return next
    })
  }

  const openPersonalApp = (app: AppDefinition) => {
    openApp(app)
    recordRecent(app.id, BUILTIN_APP_IDS.has(app.id) ? 'builtin' : 'external')
  }

  const openCatalogApp = async (app: CatalogApp) => {
    if (app.availability !== 'available') {
      toast.error(t('homeApps.errors.unavailable'))
      return
    }
    try {
      const scopeKey = catalog.scopeKeyForApp(app)
      if (app.deliveryMode === 'remote_url') {
        if (!app.remoteUrl) {
          toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
            description: t('homeApps.errors.missingUrl'),
          })
          return
        }
        openApp(catalogTabDefinition(scopeKey, app, app.remoteUrl))
      } else {
        const result = await catalog.start(app)
        openApp(catalogTabDefinition(scopeKey, app, result.url))
      }
      recordRecent(catalogRecentId(scopeKey), 'organization')
    } catch (error) {
      toast.error(t('homeApps.errors.openTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'open'),
      })
    }
  }

  const handlePrimaryAction = async (
    app: CatalogApp,
    action: CatalogPrimaryAction,
  ) => {
    if (action === 'install' || action === 'update') {
      setInstallTarget(app)
      return
    }
    if (action === 'cancel') {
      try {
        await catalog.cancelInstall(app)
        toast.success(t('homeApps.toast.installCancelled', { name: app.name }))
      } catch (error) {
        toast.error(t('homeApps.errors.cancelInstall'), {
          description: homeAppOperationErrorText(t, error, 'cancel'),
        })
      }
      return
    }
    if (action === 'retry') {
      const status = catalog.getStatus(app)
      if (!status?.currentVersion) {
        setInstallTarget(app)
        return
      }
    }
    if (action === 'open' || action === 'retry') {
      await openCatalogApp(app)
    }
  }

  const confirmInstall = async () => {
    const app = installTarget
    if (!app) return
    setInstallTarget(null)
    try {
      await catalog.install(app)
      toast.success(t('homeApps.toast.installed', { name: app.name }))
    } catch (error) {
      if (getHomeAppErrorCode(error) !== 'INSTALL_CANCELLED') {
        toast.error(t('homeApps.errors.installTitle', { name: app.name }), {
          description: homeAppOperationErrorText(t, error, 'install'),
        })
      }
    }
  }

  const handleStop = async (app: CatalogApp) => {
    try {
      await catalog.stop(app)
      toast.success(t('homeApps.toast.stopped', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.stopTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'stop'),
      })
    }
  }

  const confirmUninstall = async () => {
    const app = uninstallTarget
    if (!app) return
    setUninstallTarget(null)
    try {
      await catalog.uninstall(app, preserveData)
      toast.success(t('homeApps.toast.uninstalled', { name: app.name }))
    } catch (error) {
      toast.error(t('homeApps.errors.uninstallTitle', { name: app.name }), {
        description: homeAppOperationErrorText(t, error, 'uninstall'),
      })
    } finally {
      setPreserveData(true)
    }
  }

  const showLogs = async (app: CatalogApp) => {
    setLogsTarget(app)
    setLogs('')
    setLogsLoading(true)
    try {
      setLogs(await catalog.getLogs(app))
    } catch (error) {
      setLogs(homeAppOperationErrorText(t, error, 'logs'))
    } finally {
      setLogsLoading(false)
    }
  }

  const compatibleWithHost = (app: CatalogApp): boolean => {
    if (app.deliveryMode !== 'local_bundle') return true
    const release = app.currentRelease
    const host = catalog.state.host
    if (!release || !host) return true
    return (!release.platform || release.platform === host.platform)
      && (!release.arch || release.arch === host.arch)
  }

  const resolvedRecent = (() => {
    const entries: Array<{
      key: string
      definition: AppDefinition
      onOpen: () => void
    }> = []
    const seen = new Set<string>()

    for (const item of recentApps) {
      if (item.kind === 'organization') {
        const app = organizationApps.find(candidate => {
          try {
            return catalogRecentId(catalog.scopeKeyForApp(candidate)) === item.id
          } catch {
            return false
          }
        })
        if (!app || app.availability !== 'available') continue
        const status = catalog.getStatus(app)
        const url = app.remoteUrl || status?.url || 'http://127.0.0.1'
        const scopeKey = catalog.scopeKeyForApp(app)
        const key = `organization:${scopeKey}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({
          key,
          definition: catalogTabDefinition(scopeKey, app, url),
          onOpen: () => { void openCatalogApp(app) },
        })
        continue
      }
      const app = installedApps.find(candidate => candidate.id === item.id)
      if (!app) continue
      const key = `${item.kind}:${app.id}`
      if (seen.has(key)) continue
      seen.add(key)
      entries.push({
        key,
        definition: app,
        onOpen: () => openPersonalApp(app),
      })
    }

    return entries.slice(0, MAX_RECENT_APPS)
  })()

  return (
    <main
      className="h-full min-h-0 overflow-y-auto bg-background px-6 py-8 text-foreground sm:px-8"
      data-testid="home-app-hub"
    >
      <div className="mx-auto w-full max-w-[1120px] space-y-10">
        <section aria-labelledby="recent-apps-heading">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <h1 id="recent-apps-heading" className="text-lg font-semibold">
                {t('homeApps.recent.title')}
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('homeApps.recent.description')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
            {resolvedRecent.map(item => (
              <AppIcon
                key={item.key}
                app={item.definition}
                onOpen={item.onOpen}
              />
            ))}
          </div>
          {resolvedRecent.length === 0 && (
            <div
              className="rounded-xl border border-foreground/10 bg-foreground/2 p-4"
              data-testid="builtin-app-launcher"
            >
              <h2 className="text-sm font-medium">{t('homeApps.builtin.title')}</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {t('homeApps.builtin.description')}
              </p>
              <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
                {builtinApps.map(app => (
                  <AppIcon
                    key={app.id}
                    app={app}
                    onOpen={openPersonalApp}
                  />
                ))}
              </div>
            </div>
          )}
        </section>

        {catalog.organization && (
          <section aria-labelledby="organization-apps-heading" data-testid="organization-apps-section">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h2 id="organization-apps-heading" className="text-base font-semibold">
                  {t('homeApps.organization.title', {
                    name: activeOrganization?.name || t('homeApps.organization.current'),
                  })}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {activeOrganization?.type === 'creator_space'
                    ? t('homeApps.organization.creatorDescription')
                    : t('homeApps.organization.enterpriseDescription')}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={catalog.state.refreshing}
                onClick={() => { void catalog.sync(true) }}
              >
                <Icons.RefreshCw className={catalog.state.refreshing ? 'animate-spin' : ''} />
                {t('homeApps.actions.refresh')}
              </Button>
            </div>

            {catalog.state.warningCode && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <Icons.WifiOff className="size-4 shrink-0" />
                {catalogStateMessage(t, catalog.state.warningCode, 'warning')}
              </div>
            )}

            {catalog.state.loading ? (
              <div className="flex min-h-32 items-center justify-center rounded-xl border border-foreground/10">
                <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : catalog.state.errorCode && !catalog.state.catalog ? (
              <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-foreground/10 px-6 text-center">
                <Icons.CloudOff className="mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">
                  {t('homeApps.organization.loadFailed')}
                </p>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">
                  {catalogStateMessage(t, catalog.state.errorCode, 'error')}
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  onClick={() => { void catalog.sync(true) }}
                >
                  {t('homeApps.actions.tryAgain')}
                </Button>
              </div>
            ) : organizationApps.length === 0 ? (
              <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-foreground/15 px-6 text-center">
                <Icons.LayoutGrid className="mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">
                  {t('homeApps.organization.empty')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {activeOrganization?.type === 'creator_space'
                    ? t('homeApps.organization.emptyCreator')
                    : t('homeApps.organization.emptyEnterprise')}
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {organizationApps.map(app => (
                  <OrganizationAppCard
                    key={catalog.scopeKeyForApp(app)}
                    app={app}
                    status={catalog.getStatus(app)}
                    compatible={compatibleWithHost(app)}
                    offline={catalog.state.accessMode === 'offline'}
                    onPrimaryAction={(target, action) => {
                      void handlePrimaryAction(target, action)
                    }}
                    onStop={(target) => { void handleStop(target) }}
                    onUninstall={setUninstallTarget}
                    onViewLogs={(target) => { void showLogs(target) }}
                  />
                ))}
              </div>
            )}
          </section>
        )}

        <section aria-labelledby="external-apps-heading">
          <div className="mb-4">
            <h2 id="external-apps-heading" className="text-base font-semibold">
              {t('homeApps.external.title')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('homeApps.external.description')}
            </p>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 md:grid-cols-6">
            {externalApps.map(app => (
              <AppIcon
                key={app.id}
                app={app}
                onOpen={openPersonalApp}
                onRemove={(target) => { void removeApp(target.id) }}
              />
            ))}
            <AddExternalAppTile onClick={onAddApp} />
          </div>
        </section>
      </div>

      <Dialog open={Boolean(installTarget)} onOpenChange={(open) => {
        if (!open) setInstallTarget(null)
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {installTarget && catalog.getStatus(installTarget)?.availableRelease
                ? t('homeApps.install.updateTitle', {
                    name: installTarget?.name ?? t('homeApps.appFallback'),
                  })
                : t('homeApps.install.installTitle', {
                    name: installTarget?.name ?? t('homeApps.appFallback'),
                  })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.install.description')}
            </DialogDescription>
          </DialogHeader>
          {installTarget?.currentRelease && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.version')}
                  </p>
                  <p className="mt-1 font-medium">{installTarget.currentRelease.version}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {t('homeApps.install.downloadSize')}
                  </p>
                  <p className="mt-1 font-medium">
                    {formatBytes(t, installTarget.currentRelease.sizeBytes)}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t('homeApps.install.permissions')}
                </p>
                {installTarget.permissions?.length ? (
                  <ul className="mt-2 space-y-1.5">
                    {installTarget.permissions.map(permission => (
                      <li key={permission} className="flex items-start gap-2">
                        <Icons.ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                        <span>{permission}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-muted-foreground">
                    {t('homeApps.install.noPermissions')}
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setInstallTarget(null)}>
              {t('homeApps.actions.cancel')}
            </Button>
            <Button type="button" onClick={() => { void confirmInstall() }}>
              {installTarget && catalog.getStatus(installTarget)?.availableRelease
                ? t('homeApps.actions.update')
                : t('homeApps.actions.install')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(uninstallTarget)} onOpenChange={(open) => {
        if (!open) {
          setUninstallTarget(null)
          setPreserveData(true)
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('homeApps.uninstall.title', {
                name: uninstallTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.uninstall.description')}
            </DialogDescription>
          </DialogHeader>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-foreground/10 p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={preserveData}
              onChange={event => setPreserveData(event.target.checked)}
            />
            <span>
              <span className="block font-medium">
                {t('homeApps.uninstall.keepData')}
              </span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {t('homeApps.uninstall.keepDataDescription')}
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setUninstallTarget(null)}>
              {t('homeApps.actions.cancel')}
            </Button>
            <Button type="button" variant="destructive" onClick={() => { void confirmUninstall() }}>
              {t('homeApps.actions.uninstall')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(logsTarget)} onOpenChange={(open) => {
        if (!open) setLogsTarget(null)
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {t('homeApps.logs.title', {
                name: logsTarget?.name ?? t('homeApps.appFallback'),
              })}
            </DialogTitle>
            <DialogDescription>
              {t('homeApps.logs.description')}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[420px] min-h-40 overflow-auto rounded-lg bg-foreground/5 p-3 text-xs leading-relaxed">
            {logsLoading
              ? t('homeApps.logs.loading')
              : logs || t('homeApps.logs.empty')}
          </pre>
        </DialogContent>
      </Dialog>
    </main>
  )
}
