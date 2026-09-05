import type { TFunction } from 'i18next'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'
import { homeAppOperationErrorText } from '@/lib/home-app-errors'

export type CatalogPrimaryAction =
  | 'open'
  | 'install'
  | 'update'
  | 'retry'
  | 'cancel'
  | 'unavailable'

export function primaryActionFor(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  compatible: boolean,
  offline: boolean,
  statusLoading = false,
): CatalogPrimaryAction {
  if (statusLoading) return 'unavailable'
  if (app.availability !== 'available') return 'unavailable'
  if (app.deliveryMode === 'local_bundle' && status?.installationStatus) return 'cancel'
  if (
    app.deliveryMode === 'local_bundle'
    && (status?.status === 'downloading' || status?.status === 'installing')
  ) return 'cancel'
  // The ProductSpace contract requires a fresh resolve-launch grant for every
  // new open. Cached Catalog/install state remains visible offline, but cannot
  // authorize a new launch.
  if (offline) return 'unavailable'
  if (app.deliveryMode === 'remote_url') return 'open'
  if (!status || status.status === 'not_installed') {
    return offline || !compatible || status?.versionError === 'invalid_semver'
      ? 'unavailable'
      : 'install'
  }
  // Platform/architecture describe the new Catalog Release, not the already
  // installed version. Keep the last usable version launchable, but never
  // offer an incompatible update.
  if (!compatible) return status.status === 'broken' ? 'retry' : 'open'
  if (status.versionError === 'invalid_semver') return 'open'
  if (status.availableRelease) return 'update'
  if (status.status === 'update_available') return 'update'
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

export function canViewOrganizationAppLogs(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
): boolean {
  if (!status || app.deliveryMode !== 'local_bundle') return false
  const retained = app.availability === 'withdrawn'
    || app.availability === 'unavailable'
  if (status.status === 'broken') {
    return !retained || Boolean(status.currentVersion)
  }
  if (!retained || !status.currentVersion) return false
  // Healthy runtime logs remain hidden for ordinary authorized Apps. Once an
  // App is withdrawn or denied, retained local-data management intentionally
  // includes a bounded log tail alongside STOP and UNINSTALL.
  return [
    'installed',
    'running',
    'stopped',
    'update_available',
  ].includes(status.status)
}

function actionLabel(t: TFunction, action: CatalogPrimaryAction): string {
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

export function AppArtwork({ app }: { app: CatalogApp }) {
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
