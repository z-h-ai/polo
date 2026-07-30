import * as Icons from 'lucide-react'
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
  compatible: boolean
  onPrimaryAction: (
    app: CatalogApp,
    action: CatalogPrimaryAction,
  ) => void
  onStop: (app: CatalogApp) => void
  onUninstall: (app: CatalogApp) => void
  onViewLogs: (app: CatalogApp) => void
}

function primaryActionFor(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  compatible: boolean,
): CatalogPrimaryAction {
  if (app.availability === 'withdrawn' || !compatible) return 'unavailable'
  if (app.deliveryMode === 'remote_url') return 'open'
  if (!status || status.status === 'not_installed') return 'install'
  if (status.installationStatus) return 'cancel'
  if (status.status === 'downloading' || status.status === 'installing') return 'cancel'
  if (status.status === 'update_available') return 'update'
  if (status.status === 'broken') return 'retry'
  return 'open'
}

function statusText(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  compatible: boolean,
): string {
  if (app.availability === 'withdrawn') return 'Removed by your organization'
  if (!compatible) return 'Not available for this device'
  if (app.deliveryMode === 'remote_url') return 'Opens securely in Polo'
  if (!status || status.status === 'not_installed') return 'Not installed'
  if (status.installationStatus) {
    return status.installationStatus === 'downloading' ? 'Downloading update' : 'Installing update'
  }
  switch (status.status) {
    case 'downloading':
      return status.progress?.phase === 'verifying' ? 'Verifying download' : 'Downloading'
    case 'installing':
      if (status.progress?.phase === 'extracting') return 'Installing'
      if (status.progress?.phase === 'preparing') return 'Preparing app'
      return 'Installing'
    case 'installed':
      return 'Installed'
    case 'starting':
      return 'Starting'
    case 'running':
      return 'Running'
    case 'stopped':
      return 'Ready to open'
    case 'broken':
      return status.error?.message || 'Could not start'
    case 'update_available':
      return `Update ${status.availableRelease?.version ?? ''} available`.trim()
    default:
      return 'Not installed'
  }
}

const ACTION_LABELS: Record<CatalogPrimaryAction, string> = {
  open: 'Open',
  install: 'Install',
  update: 'Update',
  retry: 'Retry',
  cancel: 'Cancel',
  unavailable: 'Unavailable',
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
  compatible,
  onPrimaryAction,
  onStop,
  onUninstall,
  onViewLogs,
}: OrganizationAppCardProps) {
  const action = primaryActionFor(app, status, compatible)
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
        app.availability === 'withdrawn' && 'opacity-65',
      )}
      data-testid={`organization-app-${app.id}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <AppArtwork app={app} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold text-foreground">{app.name}</h3>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {app.creatorName || 'Your organization'}
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
                aria-label={`More actions for ${app.name}`}
              >
                <Icons.MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(status?.status === 'running' || status?.status === 'starting') && (
                <DropdownMenuItem onSelect={() => onStop(app)}>
                  <Icons.Square />
                  Stop
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={() => onViewLogs(app)}>
                <Icons.FileText />
                View logs
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => onUninstall(app)}
              >
                <Icons.Trash2 />
                Uninstall
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <p className="mt-3 line-clamp-2 min-h-9 text-xs leading-[18px] text-foreground/65">
        {app.description || 'No description provided.'}
      </p>

      <div className="mt-auto flex items-end justify-between gap-3 pt-3">
        <div className="min-w-0 flex-1">
          <p className={cn(
            'truncate text-[11px] text-muted-foreground',
            status?.status === 'broken' && 'text-destructive',
          )}>
            {statusText(app, status, compatible)}
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
        <Button
          type="button"
          size="sm"
          variant={action === 'unavailable' ? 'secondary' : 'default'}
          disabled={action === 'unavailable' || busy}
          onClick={() => onPrimaryAction(app, action)}
          data-testid={`organization-app-action-${app.id}`}
        >
          {busy && <Icons.LoaderCircle className="animate-spin" />}
          {busy ? 'Starting' : ACTION_LABELS[action]}
        </Button>
      </div>
    </article>
  )
}
