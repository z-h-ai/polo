import type { ReactNode } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  HOME_FREQUENT_APP_LIMIT,
  type PinnedHomeAppKind,
} from './home-surface-preferences'

/**
 * 管理常用应用（P-M03-MANAGE-HOME）。
 *
 * 上限 5 在这里生效；Polo 助手固定在首页、不占名额（D-PC-07 M03 收口）。
 * 纯展示组件：数据与回调由 HomePage 提供。
 */

export interface ManageHomeAppItem {
  id: string
  name: string
  iconUrl?: string
  kind: PinnedHomeAppKind
}

interface ManageHomeAppsProps {
  pinned: ManageHomeAppItem[]
  candidates: ManageHomeAppItem[]
  onRemove: (id: string) => void
  onAdd: (item: ManageHomeAppItem) => void
  onViewHidden: () => void
  onBack: () => void
}

function AppRow({
  item,
  trailing,
}: {
  item: ManageHomeAppItem
  trailing: ReactNode
}) {
  return (
    <li
      data-testid={`manage-app-${item.id}`}
      className="flex items-center gap-3 rounded-lg border border-foreground/10 bg-background px-3 py-2"
    >
      <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-foreground/10 bg-foreground/5">
        {item.iconUrl
          ? <img src={item.iconUrl} alt="" className="h-full w-full object-cover" />
          : (
            <span className="text-sm font-semibold text-foreground/70">
              {item.name.trim().slice(0, 1).toUpperCase() || '?'}
            </span>
          )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">
        {item.name}
      </span>
      {trailing}
    </li>
  )
}

export function ManageHomeApps({
  pinned,
  candidates,
  onRemove,
  onAdd,
  onViewHidden,
  onBack,
}: ManageHomeAppsProps) {
  const { t } = useTranslation()
  const full = pinned.length >= HOME_FREQUENT_APP_LIMIT

  return (
    <div data-testid="manage-home-apps" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">
            {t('homeApps.manage.title')}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('homeApps.manage.assistantNote')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onViewHidden}
          >
            <Icons.EyeOff className="size-4" strokeWidth={1.5} />
            {t('homeApps.manage.viewHidden')}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onBack}>
            <Icons.ArrowLeft className="size-4" strokeWidth={1.5} />
            {t('homeApps.manage.back')}
          </Button>
        </div>
      </div>

      <section aria-labelledby="manage-pinned-heading" className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 id="manage-pinned-heading" className="text-base font-semibold">
            {t('homeApps.manage.pinnedSection')}
          </h2>
          <span className="text-xs text-muted-foreground">
            {t('homeApps.manage.quota', {
              count: pinned.length,
              limit: HOME_FREQUENT_APP_LIMIT,
            })}
          </span>
        </div>
        {pinned.length === 0 ? (
          <p className="rounded-lg border border-dashed border-foreground/15 px-4 py-6 text-center text-sm text-muted-foreground">
            {t('homeApps.manage.emptyPinned')}
          </p>
        ) : (
          <ul className="space-y-2">
            {pinned.map(item => (
              <AppRow
                key={item.id}
                item={item}
                trailing={(
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => onRemove(item.id)}
                  >
                    {t('homeApps.manage.remove')}
                  </Button>
                )}
              />
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="manage-candidates-heading" className="space-y-3">
        <h2
          id="manage-candidates-heading"
          className="text-base font-semibold"
        >
          {t('homeApps.manage.candidates')}
        </h2>
        {full && (
          <p className="rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {t('homeApps.manage.full')}
          </p>
        )}
        {candidates.length === 0 ? (
          <p className="rounded-lg border border-dashed border-foreground/15 px-4 py-6 text-center text-sm text-muted-foreground">
            {t('homeApps.manage.emptyCandidates')}
          </p>
        ) : (
          <ul className="space-y-2">
            {candidates.map(item => (
              <AppRow
                key={item.id}
                item={item}
                trailing={(
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={full}
                    onClick={() => onAdd(item)}
                  >
                    {t('homeApps.manage.add')}
                  </Button>
                )}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
