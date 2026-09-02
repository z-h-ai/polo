import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'

const NARROW_VIEWPORT_QUERY = '(max-width: 640px)'

/**
 * True when the window is narrower than the POO-41/G4 frozen minimum
 * (≤640px). Mirrors the frozen `app.js` resize logic that shows
 * `#window-guard` and hides `.app-shell` / `.system-screen`.
 */
export function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(NARROW_VIEWPORT_QUERY).matches,
  )

  useEffect(() => {
    const query = window.matchMedia(NARROW_VIEWPORT_QUERY)
    const update = () => { setNarrow(query.matches) }
    update()
    query.addEventListener('change', update)
    return () => { query.removeEventListener('change', update) }
  }, [])

  return narrow
}

/**
 * Frozen POO-41 narrow-window guard (product.css `.window-guard` /
 * `.guard-card`): a fullscreen fallback shown instead of the workbench when
 * the window is too narrow to safely render the ProductSpace shell.
 */
export function WindowWidthGuard() {
  const { t } = useTranslation()

  return (
    <div
      data-testid="window-width-guard"
      className="fixed inset-0 z-[100] grid place-items-center bg-background p-6"
    >
      <div className="max-w-[330px] text-center">
        <span className="mx-auto mb-[18px] grid size-[52px] place-items-center rounded-[12px] bg-info/10 text-info">
          <Icons.PanelLeft className="size-[26px]" />
        </span>
        <h1 className="mb-2 text-xl font-semibold text-foreground">
          {t('productSpace.windowGuard.title')}
        </h1>
        <p className="text-[13px] leading-[1.55] text-muted-foreground">
          {t('productSpace.windowGuard.description')}
        </p>
      </div>
    </div>
  )
}
