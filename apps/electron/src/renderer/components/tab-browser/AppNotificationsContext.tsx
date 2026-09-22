import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

/**
 * 通知中心数据注册表（POO-70 WS-HOME-APPS，P-M04-NOTIFY-*）。
 *
 * 顶栏铃铛入口与通知弹层从这里读数据。产品内的真实通知来源
 * （后台完成事件、新版本、失权提醒等）由主 agent 接线
 * （见 .ws-requests/WS-HOME-APPS.md）；未挂 Provider 时使用空默认值，
 * TabBar 不出现铃铛，行为与接入前完全一致。
 */

export type AppNotificationKind =
  | 'access'
  | 'background'
  | 'version'
  | 'assistant'
  | 'app'

export interface AppNotification {
  id: string
  kind: AppNotificationKind
  title: string
  description?: string
  /** 完成时间等补充行（如「今天 10:32 · 点顶栏查看」）。 */
  timeLabel?: string
  /** 未读：顶栏铃铛显示圆点。 */
  unread?: boolean
  /** 整行点击的主操作（查看原因 / 进入运行中心 / 打开结果等）。 */
  onOpen: () => void
}

export interface AppNotificationsContextValue {
  notifications: AppNotification[]
  unreadCount: number
  centerOpen: boolean
  openCenter: () => void
  closeCenter: () => void
  toggleCenter: () => void
  /** 弹层尾部「全部停止并切换空间」；未提供时不渲染（企业运行项场景）。 */
  onStopAllAndSwitchSpace?: (() => void) | null
}

const NO_OP = () => {}

const AppNotificationsContext = createContext<AppNotificationsContextValue>({
  notifications: [],
  unreadCount: 0,
  centerOpen: false,
  openCenter: NO_OP,
  closeCenter: NO_OP,
  toggleCenter: NO_OP,
})

export interface AppNotificationsProviderProps {
  /** 受控通知列表（新通知在前）。 */
  notifications: AppNotification[]
  /** 弹层尾部「全部停止并切换空间」（企业空间运行项场景）。 */
  onStopAllAndSwitchSpace?: (() => void) | null
  initialCenterOpen?: boolean
  children: ReactNode
}

export function AppNotificationsProvider({
  notifications,
  onStopAllAndSwitchSpace = null,
  initialCenterOpen = false,
  children,
}: AppNotificationsProviderProps) {
  const [centerOpen, setCenterOpen] = useState(initialCenterOpen)
  const openCenter = useCallback(() => {
    setCenterOpen(true)
  }, [])
  const closeCenter = useCallback(() => {
    setCenterOpen(false)
  }, [])
  const toggleCenter = useCallback(() => {
    setCenterOpen(current => !current)
  }, [])

  const value = useMemo<AppNotificationsContextValue>(() => ({
    notifications,
    unreadCount: notifications.filter(item => item.unread).length,
    centerOpen,
    openCenter,
    closeCenter,
    toggleCenter,
    onStopAllAndSwitchSpace,
  }), [centerOpen, closeCenter, notifications, onStopAllAndSwitchSpace, openCenter, toggleCenter])

  return (
    <AppNotificationsContext.Provider value={value}>
      {children}
    </AppNotificationsContext.Provider>
  )
}

/** Reads the notification registry; empty and inert without a provider. */
export function useAppNotifications(): AppNotificationsContextValue {
  return useContext(AppNotificationsContext)
}
