import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'

/**
 * 终止失败 → 标签保留态（P-M04-TERM-FAILED，C-R03）。
 *
 * 停止失败时 App 标签保留并展示真实状态、可重试；不出现「看似关了、
 * 后台还在跑」。作为应用视图上的常驻提示条渲染（对话框关闭后仍在）。
 */

interface TermFailedToastProps {
  appName: string
  failedCount: number
  onRetry: () => void
  onBack: () => void
  className?: string
}

export function TermFailedToast({
  appName,
  failedCount,
  onRetry,
  onBack,
  className,
}: TermFailedToastProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid="term-failed-toast"
      className={className}
      role="status"
    >
      <div className="flex w-full items-start gap-3 rounded-hifi-lg border border-hifi-border bg-hifi-surface p-4 shadow-middle">
        <span className="grid size-9 shrink-0 place-items-center rounded-hifi-sm bg-hifi-destructive-soft text-hifi-destructive">
          <Icons.CircleAlert className="size-4" strokeWidth={1.5} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 text-hifi-md font-semibold text-hifi-foreground">
            {t('appContainer.termFailed.bannerTitle')}
          </p>
          <p className="mt-1 text-hifi-base text-hifi-fg-60">
            {t('appContainer.termFailed.bannerDescription', {
              name: appName,
              count: failedCount,
            })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onBack}>
            {t('appContainer.close.backToApp')}
          </Button>
          <Button type="button" variant="destructive" size="sm" onClick={onRetry}>
            {t('appContainer.close.retryFailed')}
          </Button>
        </div>
      </div>
    </div>
  )
}
