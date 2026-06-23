import * as Icons from 'lucide-react'
import { AppIcon } from './AppIcon'
import { useTabShell } from '@/context/TabShellContext'

interface HomePageProps {
  onAddApp: () => void
}

export function HomePage({ onAddApp }: HomePageProps) {
  const { installedApps, openApp, removeApp } = useTabShell()
  const apps = [...installedApps].sort((a, b) => a.order - b.order)

  return (
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-6 py-8 text-foreground">
      <div className="grid w-full max-w-[480px] grid-cols-3 gap-6">
        {apps.map((app) => (
          <AppIcon
            key={app.id}
            app={app}
            onOpen={openApp}
            onRemove={(target) => { void removeApp(target.id) }}
          />
        ))}
        <button
          type="button"
          className="titlebar-no-drag group flex min-w-0 flex-col items-center gap-2 rounded-lg p-2 text-center outline-none transition-colors hover:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onAddApp}
        >
          <span className="flex h-[72px] w-[72px] items-center justify-center rounded-lg border border-dashed border-foreground/25 bg-foreground/3">
            <Icons.Plus className="h-8 w-8 text-foreground/50" strokeWidth={1.5} />
          </span>
          <span className="min-h-9 max-w-[96px] text-sm leading-[18px] text-foreground/70">
            Add app
          </span>
        </button>
      </div>
    </div>
  )
}
