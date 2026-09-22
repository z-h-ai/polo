/**
 * SourcedWorksPanel — circle-side view of the deduped works data
 * (POO-70 M07, D-PC-09). One row per work regardless of how many circles
 * provide it; each source gets its own validity line. The catalog-side
 * rendering belongs to ws-home-apps — this panel makes the shared
 * `CircleSourcedApp` shape visible and is what feeds the home list.
 */

import { useTranslation } from 'react-i18next'
import { StatusPill } from '@/components/hifi'
import { cn } from '@/lib/utils'
import { isAppUsable } from './circlesState'
import type { CircleSourcedApp } from './types'

export interface SourcedWorksPanelProps {
  apps: CircleSourcedApp[]
  className?: string
}

export function SourcedWorksPanel({ apps, className }: SourcedWorksPanelProps) {
  const { t } = useTranslation()

  return (
    <div
      data-testid="sourced-works-panel"
      className={cn(
        'grid gap-2.5 rounded-hifi-inner border border-hifi-border bg-hifi-surface p-4 shadow-minimal',
        className,
      )}
    >
      <h2 className="m-0 text-hifi-lg font-semibold text-hifi-foreground">
        {t('circles.sourced.title')}
      </h2>
      {apps.map(app => {
        const usable = isAppUsable(app)
        return (
          <article
            key={app.appId}
            data-testid="sourced-work-row"
            className="rounded-hifi-md border border-hifi-border bg-hifi-surface p-3.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="m-0 text-hifi-md font-semibold text-hifi-foreground">
                {app.name}
              </h3>
              <StatusPill tone={usable ? 'success' : 'destructive'}>
                {usable
                  ? t('circles.sourced.usable')
                  : t('circles.sourced.unavailable')}
              </StatusPill>
            </div>
            <ul className="m-0 mt-2 grid list-none gap-1 p-0">
              {app.sources.map(source => (
                <li
                  key={`${app.appId}-${source.circleId}`}
                  className="flex items-center gap-2 text-hifi-base text-hifi-fg-60"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'size-[5px] shrink-0 rounded-full',
                      source.valid ? 'bg-hifi-success' : 'bg-hifi-fg-40',
                    )}
                  />
                  {source.valid
                    ? t('circles.sourced.sourceLine', {
                        circle: source.circleName,
                        creator: source.creator,
                      })
                    : t('circles.sourced.revokedLine', {
                        circle: source.circleName,
                      })}
                </li>
              ))}
            </ul>
          </article>
        )
      })}
    </div>
  )
}
