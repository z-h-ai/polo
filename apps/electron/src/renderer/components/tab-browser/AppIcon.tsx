import * as React from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import poloAppIcon from '../../../../resources/icon.png'
import { cn } from '@/lib/utils'
import { useConfirmDialog } from '@/components/ui/confirm-dialog'
import { POLO_APP_ID, type AppDefinition } from '../../../shared/tab-browser-types'

interface AppIconProps {
  app: Pick<AppDefinition, 'id' | 'name' | 'iconUrl' | 'type'>
  onOpen: (app: Pick<AppDefinition, 'id' | 'name' | 'iconUrl' | 'type'>) => void
  onRemove?: (app: Pick<AppDefinition, 'id' | 'name' | 'iconUrl' | 'type'>) => void
  className?: string
  testId?: string
}

const FALLBACK_COLORS = [
  'bg-emerald-500',
  'bg-sky-500',
  'bg-amber-500',
  'bg-rose-500',
  'bg-violet-500',
  'bg-cyan-600',
  'bg-lime-600',
  'bg-fuchsia-600',
]

function colorForName(name: string) {
  let hash = 0
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return FALLBACK_COLORS[hash % FALLBACK_COLORS.length]
}

export function AppIcon({ app, onOpen, onRemove, className, testId }: AppIconProps) {
  const { t } = useTranslation()
  const isBuiltin = app.type === 'builtin'
  // Journey #7: removing an app asks via the shared confirm dialog. Radix
  // portals the dialog to <body>, so it never nests interactive elements
  // inside this button despite the React-tree placement.
  const { requestConfirm, confirmElement } = useConfirmDialog()

  const handleContextMenu = (event: React.MouseEvent) => {
    if (isBuiltin || !onRemove) return
    event.preventDefault()
    void requestConfirm({
      testId: 'app-remove-confirm',
      title: t('homeApps.removeApp.title', { name: app.name }),
      description: t('homeApps.removeApp.description'),
      confirmLabel: t('homeApps.removeApp.confirm'),
      onConfirm: () => { onRemove(app) },
    })
  }

  return (
    <>
      <button
        type="button"
        className={cn(
          'group titlebar-no-drag flex min-w-0 flex-col items-center gap-3 rounded-lg border border-transparent p-3 text-center outline-none transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/10 hover:bg-foreground/4 hover:shadow-minimal focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
        onClick={() => onOpen(app)}
        data-app-id={app.id}
        data-testid={testId}
        onContextMenu={handleContextMenu}
      >
        <span className="flex h-[76px] w-[76px] items-center justify-center overflow-hidden rounded-lg border border-foreground/10 bg-[var(--background-elevated)] shadow-xs transition-all duration-200 ease-out group-hover:scale-[1.04] group-hover:border-foreground/16 group-hover:shadow-minimal">
          {app.iconUrl ? (
            <img src={app.iconUrl} alt="" className="h-full w-full object-cover" />
          ) : app.id === POLO_APP_ID ? (
            <img src={poloAppIcon} alt="" className="h-full w-full object-contain" />
          ) : (
            <span className={cn('flex h-full w-full items-center justify-center text-2xl font-semibold text-white', colorForName(app.name))}>
              {app.name.trim().slice(0, 1).toUpperCase() || '?'}
            </span>
          )}
        </span>
        <span className="line-clamp-2 min-h-9 max-w-[104px] text-sm font-medium leading-[18px] text-foreground/85 transition-colors group-hover:text-foreground">
          {app.name}
        </span>
      </button>
      {confirmElement}
    </>
  )
}
