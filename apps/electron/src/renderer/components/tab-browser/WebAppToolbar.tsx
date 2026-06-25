import * as Icons from 'lucide-react'
import { Button } from '@/components/ui/button'

interface WebAppToolbarProps {
  url: string
  favicon?: string
  canGoBack: boolean
  canGoForward: boolean
  isLoading: boolean
  onBack: () => void
  onForward: () => void
  onReload: () => void
}

function hostFromUrl(url: string) {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

export function WebAppToolbar({
  url,
  favicon,
  canGoBack,
  canGoForward,
  isLoading,
  onBack,
  onForward,
  onReload,
}: WebAppToolbarProps) {
  return (
    <div className="fixed left-0 right-0 z-panel flex h-9 items-center gap-1 border-b border-foreground/10 bg-background/95 px-2 titlebar-drag-region" style={{ top: 'var(--tabbar-height)' }}>
      <div className="flex items-center gap-1 titlebar-no-drag">
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canGoBack} onClick={onBack} aria-label="Back">
          <Icons.ChevronLeft className="h-4 w-4" strokeWidth={1.5} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={!canGoForward} onClick={onForward} aria-label="Forward">
          <Icons.ChevronRight className="h-4 w-4" strokeWidth={1.5} />
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onReload} aria-label={isLoading ? 'Stop loading' : 'Reload'}>
          {isLoading ? <Icons.X className="h-4 w-4" strokeWidth={1.5} /> : <Icons.RefreshCw className="h-4 w-4" strokeWidth={1.5} />}
        </Button>
      </div>
      <div className="titlebar-no-drag flex min-w-0 flex-1 items-center gap-2 rounded-md border border-foreground/10 bg-foreground/4 px-2 py-1 text-xs text-foreground/70">
        {favicon ? <img src={favicon} alt="" className="h-4 w-4 shrink-0" /> : <Icons.Globe2 className="h-4 w-4 shrink-0" strokeWidth={1.5} />}
        <span className="truncate">{hostFromUrl(url)}</span>
      </div>
    </div>
  )
}
