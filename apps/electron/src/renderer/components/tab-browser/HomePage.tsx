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
    <div className="flex h-full min-h-0 items-center justify-center bg-background px-8 py-10 text-foreground">
      <div className="grid w-full max-w-[520px] grid-cols-3 gap-x-7 gap-y-8">
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
          className="titlebar-no-drag group flex min-w-0 flex-col items-center gap-3 rounded-lg border border-transparent p-3 text-center outline-none transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-foreground/10 hover:bg-foreground/4 hover:shadow-minimal focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onAddApp}
        >
          <span className="flex h-[76px] w-[76px] items-center justify-center rounded-lg border border-foreground/12 bg-foreground/4 shadow-xs transition-all duration-200 ease-out group-hover:scale-[1.04] group-hover:border-accent/35 group-hover:bg-accent/8 group-hover:shadow-minimal">
            <Icons.Plus className="h-8 w-8 text-foreground/55 transition-colors group-hover:text-accent" strokeWidth={1.5} />
          </span>
          <span className="min-h-9 max-w-[104px] text-sm font-medium leading-[18px] text-foreground/70 transition-colors group-hover:text-foreground">
            Add app
          </span>
        </button>
      </div>
    </div>
  )
}
