import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { CatalogApp } from '@polo-ai/shared/admin'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { AppArtwork } from './OrganizationAppCard'

interface ManageHomeAppsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Currently `available` Catalog Apps of the active ProductSpace. */
  apps: CatalogApp[]
  scopeKeyForApp: (app: CatalogApp) => string
  /** Scope keys currently pinned to the home quick access. */
  selectedIds: ReadonlySet<string>
  maxSlots: number
  /**
   * Toggles one App's quick-access membership. Returns false when the
   * addition was rejected (slot cap). Only home shortcuts change —
   * installation state is never touched here.
   */
  onToggle: (app: CatalogApp, scopeKey: string, enabled: boolean) => boolean
}

/**
 * POO-43 "管理首页 Apps" dialog: pick which of the current ProductSpace's
 * available Apps appear as home quick-access shortcuts (max 5, beside the
 * fixed Polo assistant). This NEVER installs, uninstalls, or sideloads an
 * App — uninstalled Apps simply open through their normal install flow.
 */
export function ManageHomeAppsDialog({
  open,
  onOpenChange,
  apps,
  scopeKeyForApp,
  selectedIds,
  maxSlots,
  onToggle,
}: ManageHomeAppsDialogProps) {
  const { t } = useTranslation()
  const atCapacity = selectedIds.size >= maxSlots

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="manage-home-apps-dialog">
        <DialogHeader>
          <DialogTitle>{t('homeApps.manage.title')}</DialogTitle>
          <DialogDescription>
            {t('homeApps.manage.description', { max: maxSlots })}
          </DialogDescription>
        </DialogHeader>
        {apps.length === 0 ? (
          <div className="flex min-h-24 flex-col items-center justify-center rounded-xl border border-dashed border-foreground/15 px-6 text-center">
            <Icons.LayoutGrid className="mb-2 size-5 text-muted-foreground" />
            <p className="text-sm font-medium">{t('homeApps.manage.empty')}</p>
          </div>
        ) : (
          <ul className="flex max-h-[320px] flex-col gap-2 overflow-y-auto pr-1">
            {apps.map(app => {
              let scopeKey = ''
              try {
                scopeKey = scopeKeyForApp(app)
              } catch {
                return null
              }
              const selected = selectedIds.has(scopeKey)
              const disabled = !selected && atCapacity
              return (
                <li key={scopeKey}>
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={selected}
                    disabled={disabled}
                    className={cn(
                      'grid w-full grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-3 rounded-lg border p-3 text-left outline-none transition-colors',
                      selected
                        ? 'border-accent/45 bg-accent/6'
                        : 'border-foreground/10 hover:bg-foreground/4',
                      disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                    )}
                    data-testid="manage-home-apps-item"
                    data-app-id={app.id}
                    data-selected={selected ? 'true' : 'false'}
                    onClick={() => { onToggle(app, scopeKey, !selected) }}
                  >
                    <span
                      className={cn(
                        'grid size-5 shrink-0 place-items-center rounded border',
                        selected
                          ? 'border-accent bg-accent text-accent-foreground'
                          : 'border-foreground/25',
                      )}
                    >
                      {selected && <Icons.Check className="size-3.5" strokeWidth={2.5} />}
                    </span>
                    <AppArtwork app={app} />
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-foreground">
                        {app.name}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {app.creatorName?.trim() || t('homeApps.allApps.unknownSource')}
                      </span>
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          {selectedIds.size}/{maxSlots} · {t('homeApps.manage.hint')}
        </p>
        <DialogFooter>
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            data-testid="manage-home-apps-done"
          >
            {t('homeApps.manage.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
