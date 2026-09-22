import type { ReactNode } from 'react'
import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

/**
 * 个人隐藏 / 恢复显示（P-M03-CONTROLS）。
 *
 * 隐藏只影响本设备上的显示；与来源侧（圈子/空间）撤下应用是两件事，
 * 页面文案把两者分开说明。恢复显示后应用回到目录与可固定列表。
 */

export interface HiddenAppItem {
  id: string
  name: string
  iconUrl?: string
  /** 来源说明（如圈子名 / 空间名）。 */
  sourceLabel?: string
  hiddenAt?: number
}

interface HiddenAppsProps {
  hidden: HiddenAppItem[]
  onRestore: (id: string) => void
  onBack: () => void
  /** 附加说明区（demo / 主页可选），渲染在列表之后。 */
  children?: ReactNode
}

export function HiddenApps({
  hidden,
  onRestore,
  onBack,
  children,
}: HiddenAppsProps) {
  const { t } = useTranslation()

  return (
    <div data-testid="hidden-apps" className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold">
            {t('homeApps.hidden.title')}
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('homeApps.hidden.description')}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onBack}>
          <Icons.ArrowLeft className="size-4" strokeWidth={1.5} />
          {t('homeApps.hidden.back')}
        </Button>
      </div>

      {hidden.length === 0 ? (
        <p className="rounded-lg border border-dashed border-foreground/15 px-4 py-8 text-center text-sm text-muted-foreground">
          {t('homeApps.hidden.empty')}
        </p>
      ) : (
        <ul className="space-y-2" data-testid="hidden-apps-list">
          {hidden.map(item => (
            <li
              key={item.id}
              data-testid={`hidden-app-${item.id}`}
              className="flex items-center gap-3 rounded-lg border border-foreground/10 bg-background px-3 py-2"
            >
              <span className="flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-md border border-foreground/10 bg-foreground/5">
                {item.iconUrl
                  ? (
                    <img
                      src={item.iconUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  )
                  : (
                    <span className="text-sm font-semibold text-foreground/70">
                      {item.name.trim().slice(0, 1).toUpperCase() || '?'}
                    </span>
                  )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {item.name}
                </span>
                {item.sourceLabel && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {item.sourceLabel}
                  </span>
                )}
              </span>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onRestore(item.id)}
              >
                <Icons.Eye className="size-4" strokeWidth={1.5} />
                {t('homeApps.hidden.restore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {children}
    </div>
  )
}
