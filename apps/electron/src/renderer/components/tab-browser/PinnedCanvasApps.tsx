import * as Icons from 'lucide-react'
import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'
import { clientWorkbenchButtonClassName } from '@/components/ui/client-workbench'
import { useTabShell } from '@/context/TabShellContext'
import type { AppDefinition } from '../../../shared/tab-browser-types'

/**
 * POO-154 — the Home surface for pinned canvas apps (固定到标签页).
 *
 * A pinned canvas app is a session-local generate_app artifact the user
 * pinned into the tab-browser launcher. Its tab is closable like any web
 * tab, and closing it must never orphan the app: this section is the
 * device-local re-open entry, independent of the catalog directory's
 * loading/denied/offline phases (the pinned list is a local fact, always
 * authoritative when non-empty). The unpin action here removes the launcher
 * entry and closes its tabs through the same TabShell path the transcript
 * card's 取消固定 uses, so both surfaces and the cards' pinned-state mirror
 * stay one truth.
 */

/** The launcher ids this section owns (mirror of the pin bridge's prefix). */
export function isPinnedCanvasApp(app: AppDefinition): boolean {
  return app.id.startsWith('gen-ui-app-')
}

/** Pure row model so the empty/closed state stays testable without Jotai. */
export function selectPinnedCanvasApps(apps: AppDefinition[]): AppDefinition[] {
  return apps.filter(isPinnedCanvasApp)
}

/** Display name: the pinned title the bridge recorded at pin time. */
export function pinnedCanvasAppLabel(app: AppDefinition, t: TFunction): string {
  return app.name || t('homeApps.canvas.fallbackName')
}

export function PinnedCanvasApps() {
  const { t } = useTranslation()
  const { installedApps, openApp, removeApp } = useTabShell()
  const canvasApps = selectPinnedCanvasApps(installedApps)

  // No pinned canvas apps → no section: an empty local list is not a
  // directory vacuum worth a tile (the catalog grid below owns empty states).
  if (canvasApps.length === 0) return null

  return (
    <section className="mb-[24px]" data-testid="home-canvas-apps-section">
      <div className="mb-[12px] flex items-center gap-[8px]">
        <Icons.AppWindowMac className="size-[15px] text-accent" aria-hidden="true" />
        <h2 className="m-0 text-[14px] font-semibold tracking-[-0.01em]" data-testid="home-canvas-apps-title">
          {t('homeApps.canvas.title')}
        </h2>
        <span className="inline-flex min-h-[18px] items-center rounded-full bg-foreground/6 px-[7px] text-[10px] font-medium text-muted-foreground">
          {canvasApps.length}
        </span>
        <p className="m-0 ml-auto truncate text-[11px] text-muted-foreground">{t('homeApps.canvas.hint')}</p>
      </div>
      <ul className="m-0 grid list-none gap-[12px] p-0 grid-cols-1 min-[761px]:grid-cols-2 min-[1081px]:grid-cols-3">
        {canvasApps.map((app) => (
          <li key={app.id}>
            <article
              data-testid={`home-canvas-app-${app.id}`}
              className="flex h-full min-h-[96px] cursor-pointer flex-col rounded-[16px] border border-border bg-surface client-material-card p-[14px] transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[1px] hover:border-foreground-20 hover:shadow-xs"
              onClick={() => openApp(app)}
            >
              <div className="flex items-center gap-[10px]">
                <span className="grid size-[32px] shrink-0 place-items-center rounded-[9px] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-accent">
                  <Icons.Shapes className="size-[16px]" aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[13px] font-semibold" title={pinnedCanvasAppLabel(app, t)}>
                  {pinnedCanvasAppLabel(app, t)}
                </span>
              </div>
              <div className="mt-auto flex items-center justify-end gap-[7px] pt-[12px]">
                <button
                  type="button"
                  data-testid={`home-canvas-app-unpin-${app.id}`}
                  className={clientWorkbenchButtonClassName}
                  onClick={(event) => {
                    event.stopPropagation()
                    void removeApp(app.id)
                  }}
                >
                  {t('homeApps.canvas.unpin')}
                </button>
                <button
                  type="button"
                  data-testid={`home-canvas-app-open-${app.id}`}
                  className="inline-flex min-h-[32px] items-center justify-center whitespace-nowrap rounded-[8px] border border-accent bg-accent px-[12px] text-[12px] font-semibold text-white shadow-minimal transition-[box-shadow,transform] duration-200 hover:-translate-y-[1px] hover:shadow-middle"
                  onClick={(event) => {
                    event.stopPropagation()
                    openApp(app)
                  }}
                >
                  {t('homeApps.canvas.open')}
                </button>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </section>
  )
}
