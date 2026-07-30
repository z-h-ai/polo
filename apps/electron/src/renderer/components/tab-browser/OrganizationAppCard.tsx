import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
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
import { homeAppOperationErrorText } from '@/lib/home-app-errors'

export type CatalogPrimaryAction =
  | 'open'
  | 'install'
  | 'update'
  | 'retry'
  | 'cancel'
  | 'unavailable'

interface OrganizationAppCardProps {
  app: CatalogApp
  status?: LocalAppRuntimeStatus
  statusUnavailable?: boolean
  compatible: boolean
  offline: boolean
  onPrimaryAction: (
    app: CatalogApp,
    action: CatalogPrimaryAction,
  ) => void
  onStop: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onViewLogs: (app: CatalogApp) => void
}

export function primaryActionFor(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  compatible: boolean,
  offline: boolean,
): CatalogPrimaryAction {
  if (app.availability !== 'available' || !compatible) return 'unavailable'
  if (app.deliveryMode === 'remote_url') return 'open'
  if (!status || status.status === 'not_installed') {
    return offline || status?.versionError === 'invalid_semver'
      ? 'unavailable'
      : 'install'
  }
  if (status.installationStatus) return 'cancel'
  if (status.status === 'downloading' || status.status === 'installing') return 'cancel'
  if (status.versionError === 'invalid_semver') return 'open'
  if (status.availableRelease) return offline ? 'open' : 'update'
  if (status.status === 'update_available') return offline ? 'open' : 'update'
  if (status.status === 'broken') return 'retry'
  return 'open'
}

export function statusText(
  t: TFunction,
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  compatible: boolean,
): string {
  if (app.availability === 'withdrawn') return t('homeApps.status.withdrawn')
  if (app.availability === 'unavailable') return t('homeApps.status.unauthorized')
  if (!compatible) return t('homeApps.status.incompatible')
  if (app.deliveryMode === 'remote_url') return t('homeApps.status.remote')
  if (!status) return t('homeApps.status.notInstalled')
  if (status.progress) {
    switch (status.progress.phase) {
      case 'downloading':
        return t('homeApps.status.downloading')
      case 'verifying':
        return t('homeApps.status.verifying')
      case 'extracting':
        return t('homeApps.status.extracting')
      case 'preparing':
        return t('homeApps.status.preparing')
    }
  }
  if (status.installationStatus) {
    return status.installationStatus === 'downloading'
      ? t('homeApps.status.downloadingUpdate')
      : t('homeApps.status.installingUpdate')
  }
  if (status.status === 'downloading') return t('homeApps.status.downloading')
  if (status.status === 'installing') return t('homeApps.status.installing')
  if (status.status === 'starting') return t('homeApps.status.starting')
  if (status.versionError === 'invalid_semver') {
    return t('homeApps.status.invalidVersion')
  }
  if (status.status === 'not_installed') return t('homeApps.status.notInstalled')
  if (status.availableRelease) {
    return t('homeApps.status.updateAvailable', {
      version: status.availableRelease.version,
    })
  }
  switch (status.status) {
    case 'installed':
      return t('homeApps.status.installed')
    case 'running':
      return t('homeApps.status.running')
    case 'stopped':
      return t('homeApps.status.ready')
    case 'broken':
      return status.error
        ? homeAppOperationErrorText(t, status.error, 'open')
        : t('homeApps.status.startFailed')
    case 'update_available':
      return t('homeApps.status.updateAvailable', {
        version: '',
      })
    default:
      return t('homeApps.status.notInstalled')
  }
}

function actionLabel(t: TFunction, action: CatalogPrimaryAction): string {
  return t(`homeApps.actions.${action}`)
}

function AppArtwork({ app }: { app: CatalogApp }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-foreground/10 bg-[var(--background-elevated)] shadow-xs">
      {app.iconUrl ? (
        <img src={app.iconUrl} alt="" className="size-full object-cover" />
      ) : (
        <span className="flex size-full items-center justify-center bg-gradient-to-br from-sky-500 to-indigo-600 text-lg font-semibold text-white">
          {app.name.trim().slice(0, 1).toUpperCase() || '?'}
        </span>
      )}
    </div>
  )
}

export function OrganizationAppCard({
  app,
  status,
  statusUnavailable = false,
  compatible,
  offline,
  onPrimaryAction,
  onStop,
  onUninstall,
  onViewLogs,
}: OrganizationAppCardProps) {
  const { t } = useTranslation()
  const action = statusUnavailable
    ? 'unavailable'
    : primaryActionFor(app, status, compatible, offline)
  const busy = status?.status === 'starting'
  const installed = app.deliveryMode === 'local_bundle'
    && Boolean(status && status.status !== 'not_installed'
      && status.status !== 'downloading'
      && status.status !== 'installing')
  const progress = status?.progress?.percent

  return (
    <article
      className={cn(
        'relative flex min-h-[176px] flex-col rounded-xl border border-foreground/10 bg-[var(--background-elevated)] p-4 shadow-xs transition-shadow hover:shadow-minimal',
        app.availability !== 'available' && 'opacity-65',
      )}
      data-testid={`organization-app-${app.id}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <AppArtwork app={app} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{app.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {app.creatorName || t('homeApps.organizationSource')}
          </p>
        </div>
        {installed && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="-mr-2 -mt-2 size-8"
                aria-label={t('homeApps.moreActions', { name: app.name })}
              >
                <Icons.MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(status?.status === 'running' || status?.status === 'starting') && (
                <DropdownMenuItem onSelect={() => onStop(app)}>
                  <Icons.Square />
                  {t('homeApps.actions.stop')}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => onViewLogs(app)}>
                <Icons.FileText />
                {t('homeApps.actions.viewLogs')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
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

      <p className="mt-3 line-clamp-2 min-h-9 text-xs leading-[18px] text-foreground/65">
        {app.description || t('homeApps.noDescription')}
      </p>

      <div className="mt-auto flex items-end justify-between gap-3 pt-3">
        <div className="min-w-0 flex-1">
          <p className={cn(
            'truncate text-[11px] text-muted-foreground',
            (status?.status === 'broken' || status?.versionError) && 'text-destructive',
          )}>
            {statusUnavailable
              ? t('homeApps.status.statusUnavailable')
              : statusText(t, app, status, compatible)}
          </p>
          {typeof progress === 'number' && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-foreground/10">
              <div
                className="h-full rounded-full bg-accent transition-[width]"
                style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
              />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {action === 'update' && installed && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => onPrimaryAction(app, 'open')}
              data-testid={`organization-app-open-${app.id}`}
            >
              {t('homeApps.actions.open')}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={action === 'unavailable' ? 'secondary' : 'default'}
            disabled={action === 'unavailable' || busy}
            onClick={() => onPrimaryAction(app, action)}
            data-testid={`organization-app-action-${app.id}`}
          >
            {busy && <Icons.LoaderCircle className="animate-spin" />}
            {busy ? t('homeApps.status.starting') : actionLabel(t, action)}
          </Button>
        </div>
      </div>
    </article>
  )
}
