import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
/**
 * Frozen POO-41 narrow-window guard (source-derived `.guard`): a fullscreen
 * fallback shown instead of the workbench when the window is too narrow to
 * safely render the ProductSpace shell. Geometry matches the frozen source:
 * centered column (max 320px), 11px uppercase eyebrow, 24px bold title,
 * 14px/1.55 muted copy.
 */
export function WindowWidthGuard() {
  const { t } = useTranslation()

  return (
    <div
      data-testid="window-width-guard"
      className="fixed inset-0 z-[100] grid place-items-center bg-background p-[24px] text-center"
    >
      <div className="max-w-[320px]">
        <p className="mb-[7px] text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
          {t('productSpace.windowGuard.eyebrow')}
        </p>
        <h1 className="m-0 text-[24px] font-bold leading-[1.08] tracking-[-0.05em] text-foreground">
          {t('productSpace.windowGuard.title')}
        </h1>
        <p className="mt-0 text-[14px] leading-[1.55] text-muted-foreground">
          {t('productSpace.windowGuard.description')}
        </p>
      </div>
    </div>
  )
}
