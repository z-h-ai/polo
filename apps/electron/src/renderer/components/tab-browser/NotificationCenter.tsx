import * as Icons from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type {
  AppNotification,
  AppNotificationKind,
} from './AppNotificationsContext'

/**
 * 通知中心（P-M04-NOTIFY-ENT / P-M04-NOTIFY-PERSONAL）。
 *
 * 顶栏铃铛弹层：通知行（图标 + 标题 + 描述/时间），整行点击执行主操作
 * （失权「查看原因」、后台完成进入运行中心、新版本进圈子详情等）。
 * 纯展示组件；数据与回调由 AppNotificationsProvider 提供。
 */

const KIND_STYLES: Record<
  AppNotificationKind,
  {
    Icon: typeof Icons.ShieldAlert
    tile: string
  }
> = {
  access: {
    Icon: Icons.ShieldAlert,
    tile: 'bg-hifi-destructive-soft text-hifi-destructive',
  },
  background: {
    Icon: Icons.LayoutGrid,
    tile: 'bg-hifi-info-soft text-hifi-info',
  },
  version: {
    Icon: Icons.Users,
    tile: 'bg-hifi-accent-soft text-hifi-accent',
  },
  assistant: {
    Icon: Icons.Sparkles,
    tile: 'bg-hifi-accent-soft text-hifi-accent',
  },
  app: {
    Icon: Icons.LayoutGrid,
    tile: 'bg-hifi-info-soft text-hifi-info',
  },
}

export interface NotificationCenterProps {
  notifications: AppNotification[]
  /** 尾部「全部停止并切换空间」（企业空间运行项场景）。 */
  onStopAllAndSwitchSpace?: () => void
  onClose?: () => void
  className?: string
}

export function NotificationCenter({
  notifications,
  onStopAllAndSwitchSpace,
  onClose,
  className,
}: NotificationCenterProps) {
  const { t } = useTranslation()

  return (
    <section
      data-testid="notification-center"
      className={cn(
        'w-[min(380px,100vw-24px)] rounded-hifi-lg border border-hifi-border bg-hifi-background p-3 shadow-middle',
        className,
      )}
      aria-labelledby="notification-center-heading"
    >
      <header className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2
          id="notification-center-heading"
          className="m-0 text-hifi-sm font-medium uppercase tracking-[0.75px] text-hifi-fg-50"
        >
          {t('appContainer.notify.title')}
        </h2>
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6 rounded-md"
            aria-label={t('homeApps.inspector.close')}
            onClick={onClose}
          >
            <Icons.X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        )}
      </header>
      {notifications.length === 0 ? (
        <p className="rounded-hifi-md border border-dashed border-hifi-border px-4 py-5 text-center text-hifi-md text-hifi-fg-50">
          {t('appContainer.notify.empty')}
        </p>
      ) : (
        <ul className="max-h-[360px] space-y-1 overflow-y-auto">
          {notifications.map(notification => {
            const { Icon, tile } = KIND_STYLES[notification.kind]
            return (
              <li key={notification.id}>
                <button
                  type="button"
                  data-testid={`notify-item-${notification.id}`}
                  className="flex w-full items-start gap-2.5 rounded-hifi-md px-2 py-2 text-left transition-colors hover:bg-hifi-fg-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-hifi-accent"
                  onClick={notification.onOpen}
                >
                  <span
                    className={cn(
                      'grid size-7 shrink-0 place-items-center rounded-hifi-sm',
                      tile,
                    )}
                  >
                    <Icon className="size-3.5" strokeWidth={1.5} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      {notification.unread && (
                        <span
                          aria-hidden="true"
                          className="size-[6px] shrink-0 rounded-full bg-hifi-accent"
                        />
                      )}
                      <span className="truncate text-hifi-md font-medium text-hifi-foreground">
                        {notification.title}
                      </span>
                    </span>
                    {notification.description && (
                      <span className="mt-0.5 block text-hifi-sm text-hifi-fg-60">
                        {notification.description}
                      </span>
                    )}
                    {notification.timeLabel && (
                      <span className="mt-0.5 block text-hifi-xs text-hifi-fg-50">
                        {notification.timeLabel}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
      {onStopAllAndSwitchSpace && (
        <footer className="mt-2 border-t border-hifi-border pt-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-center"
            onClick={onStopAllAndSwitchSpace}
          >
            {t('appContainer.notify.stopAllAndSwitch')}
          </Button>
        </footer>
      )}
    </section>
  )
}
