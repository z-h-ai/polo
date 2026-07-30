import { useMemo, useState } from 'react'
import * as Icons from 'lucide-react'
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

function formatBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 'Unknown size'
  const units = ['B', 'KB', 'MB', 'GB']
  let size = sizeBytes
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 || unit === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

function catalogTabDefinition(app: CatalogApp, url: string): AppDefinition {
  return {
    id: `organization:${app.organizationId}:${app.id}`,
    name: app.name,
    url,
    iconUrl: app.iconUrl,
    type: 'webapp',
    createdAt: 0,
    order: app.sortOrder,
  }
}

function AddExternalAppTile({ onClick }: { onClick: () => void }) {
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
        Add external app
      </span>
    </button>
  )
}

export function HomePage({ onAddApp }: HomePageProps) {
  const { installedApps, openApp, removeApp } = useTabShell()
  const catalog = useAppCatalog()
  const [recentApps, setRecentApps] = useState(readRecentApps)
  const [installTarget, setInstallTarget] = useState<CatalogApp | null>(null)
  const [uninstallTarget, setUninstallTarget] = useState<CatalogApp | null>(null)
  const [preserveData, setPreserveData] = useState(true)
  const [logsTarget, setLogsTarget] = useState<CatalogApp | null>(null)
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)

  const builtins = useMemo(
    () => installedApps.filter(app => BUILTIN_APP_IDS.has(app.id)),
    [installedApps],
  )
  const externalApps = useMemo(
    () => installedApps
      .filter(app => app.type === 'webapp' && !BUILTIN_APP_IDS.has(app.id))
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
    if (app.availability === 'withdrawn') {
      toast.error('This app is no longer available from your organization.')
      return
    }
    try {
      if (app.deliveryMode === 'remote_url') {
        if (!app.remoteUrl) throw new Error('The organization did not provide an app URL.')
        openApp(catalogTabDefinition(app, app.remoteUrl))
      } else {
        const result = await catalog.start(app)
        openApp(catalogTabDefinition(app, result.url))
      }
      recordRecent(app.id, 'organization')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not open the app.'
      toast.error(`Could not open ${app.name}`, { description: message })
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
        await catalog.cancelInstall(app.id)
        toast.success(`Cancelled installation of ${app.name}`)
      } catch (error) {
        toast.error('Could not cancel installation', {
          description: error instanceof Error ? error.message : undefined,
        })
      }
      return
    }
    if (action === 'retry') {
      const status = catalog.state.statuses[app.id]
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
      toast.success(`${app.name} is ready to open`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Installation failed.'
      if (!/cancel/i.test(message)) {
        toast.error(`Could not install ${app.name}`, { description: message })
      }
    }
  }

  const handleStop = async (app: CatalogApp) => {
    try {
      await catalog.stop(app.id)
      toast.success(`${app.name} stopped`)
    } catch (error) {
      toast.error(`Could not stop ${app.name}`, {
        description: error instanceof Error ? error.message : undefined,
      })
    }
  }

  const confirmUninstall = async () => {
    const app = uninstallTarget
    if (!app) return
    setUninstallTarget(null)
    try {
      await catalog.uninstall(app.id, preserveData)
      toast.success(`${app.name} was uninstalled`)
    } catch (error) {
      toast.error(`Could not uninstall ${app.name}`, {
        description: error instanceof Error ? error.message : undefined,
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
      setLogs(await catalog.getLogs(app.id))
    } catch (error) {
      setLogs(error instanceof Error ? error.message : 'Could not load logs.')
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
        const app = organizationApps.find(candidate => candidate.id === item.id)
        if (!app || app.availability === 'withdrawn') continue
        const status = catalog.state.statuses[app.id]
        const url = app.remoteUrl || status?.url || 'http://127.0.0.1'
        const key = `organization:${app.id}`
        if (seen.has(key)) continue
        seen.add(key)
        entries.push({
          key,
          definition: catalogTabDefinition(app, url),
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

    for (const app of builtins) {
      const key = `builtin:${app.id}`
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
              <h1 id="recent-apps-heading" className="text-lg font-semibold">Recently used</h1>
              <p className="mt-1 text-xs text-muted-foreground">
                Jump back into your Polo apps and recent work.
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
        </section>

        {catalog.organization && (
          <section aria-labelledby="organization-apps-heading" data-testid="organization-apps-section">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h2 id="organization-apps-heading" className="text-base font-semibold">
                  {activeOrganization?.name || 'Current organization'} apps
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {activeOrganization?.type === 'creator_space'
                    ? 'Apps published for this creator space.'
                    : 'Apps assigned to this enterprise workspace.'}
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
                Refresh
              </Button>
            </div>

            {catalog.state.warning && (
              <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <Icons.WifiOff className="size-4 shrink-0" />
                Showing the last synced catalog. Refresh failed: {catalog.state.warning}
              </div>
            )}

            {catalog.state.loading ? (
              <div className="flex min-h-32 items-center justify-center rounded-xl border border-foreground/10">
                <Icons.LoaderCircle className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : catalog.state.error && !catalog.state.catalog ? (
              <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-foreground/10 px-6 text-center">
                <Icons.CloudOff className="mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">Could not load organization apps</p>
                <p className="mt-1 max-w-md text-xs text-muted-foreground">{catalog.state.error}</p>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="mt-4"
                  onClick={() => { void catalog.sync(true) }}
                >
                  Try again
                </Button>
              </div>
            ) : organizationApps.length === 0 ? (
              <div className="flex min-h-36 flex-col items-center justify-center rounded-xl border border-dashed border-foreground/15 px-6 text-center">
                <Icons.LayoutGrid className="mb-3 size-6 text-muted-foreground" />
                <p className="text-sm font-medium">No apps have been shared here yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {activeOrganization?.type === 'creator_space'
                    ? 'Published creator apps will appear in this space.'
                    : 'Apps assigned by your organization will appear here.'}
                </p>
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {organizationApps.map(app => (
                  <OrganizationAppCard
                    key={app.id}
                    app={app}
                    status={catalog.state.statuses[app.id]}
                    compatible={compatibleWithHost(app)}
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
            <h2 id="external-apps-heading" className="text-base font-semibold">External apps</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Personal website shortcuts stored only on this device.
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
              {catalog.state.statuses[installTarget?.id ?? '']?.status === 'update_available'
                ? `Update ${installTarget?.name ?? 'app'}`
                : `Install ${installTarget?.name ?? 'app'}`}
            </DialogTitle>
            <DialogDescription>
              Polo will download this app and prepare it to run locally on this device.
            </DialogDescription>
          </DialogHeader>
          {installTarget?.currentRelease && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3 rounded-lg bg-foreground/4 p-3">
                <div>
                  <p className="text-xs text-muted-foreground">Version</p>
                  <p className="mt-1 font-medium">{installTarget.currentRelease.version}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Download size</p>
                  <p className="mt-1 font-medium">{formatBytes(installTarget.currentRelease.sizeBytes)}</p>
                </div>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Required permissions
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
                  <p className="mt-2 text-muted-foreground">No additional permissions requested.</p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setInstallTarget(null)}>
              Cancel
            </Button>
            <Button type="button" onClick={() => { void confirmInstall() }}>
              {catalog.state.statuses[installTarget?.id ?? '']?.status === 'update_available'
                ? 'Update'
                : 'Install'}
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
            <DialogTitle>Uninstall {uninstallTarget?.name ?? 'app'}?</DialogTitle>
            <DialogDescription>
              The installed program will be removed from this device.
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
              <span className="block font-medium">Keep app data</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Your settings and documents will be available if you reinstall later.
              </span>
            </span>
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setUninstallTarget(null)}>
              Cancel
            </Button>
            <Button type="button" variant="destructive" onClick={() => { void confirmUninstall() }}>
              Uninstall
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(logsTarget)} onOpenChange={(open) => {
        if (!open) setLogsTarget(null)
      }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{logsTarget?.name ?? 'App'} logs</DialogTitle>
            <DialogDescription>
              Recent local runtime output. Share this with your administrator if the app cannot start.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[420px] min-h-40 overflow-auto rounded-lg bg-foreground/5 p-3 text-xs leading-relaxed">
            {logsLoading ? 'Loading logs…' : logs || 'No logs are available yet.'}
          </pre>
        </DialogContent>
      </Dialog>
    </main>
  )
}
