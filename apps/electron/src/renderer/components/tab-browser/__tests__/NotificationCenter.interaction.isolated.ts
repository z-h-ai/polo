import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { AppNotification } from '../AppNotificationsContext'

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen } = await import(
  '@testing-library/react'
)
const { NotificationCenter } = await import('../NotificationCenter')

const NOTIFICATIONS: AppNotification[] = [
  {
    id: 'access-north',
    kind: 'access',
    title: '北方贸易已无法访问',
    description: '成员资格已被移除 · 查看原因',
    unread: true,
    onOpen: () => {},
  },
  {
    id: 'report-done',
    kind: 'background',
    title: '数据报表生成器已在后台完成',
    timeLabel: '今天 10:32 · 点顶栏「3 项运行中」查看',
    unread: true,
    onOpen: () => {},
  },
  {
    id: 'version-brand',
    kind: 'version',
    title: '晨星设计圈有新版本',
    description: '品牌语气分析 v1.4.0 · 下次使用生效',
    onOpen: () => {},
  },
]

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(() => {
  cleanup()
})

describe('NotificationCenter (P-M04-NOTIFY-*)', () => {
  it('lists notifications with title, description and time lines', () => {
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(NotificationCenter, {
        notifications: NOTIFICATIONS,
      }),
    ))

    expect(screen.getByTestId('notification-center')).toBeTruthy()
    expect(screen.getByText('通知', { selector: 'h2' })).toBeTruthy()
    expect(screen.getByText('北方贸易已无法访问')).toBeTruthy()
    expect(screen.getByText('成员资格已被移除 · 查看原因')).toBeTruthy()
    expect(screen.getByText('数据报表生成器已在后台完成')).toBeTruthy()
    expect(screen.getByText('今天 10:32 · 点顶栏「3 项运行中」查看')).toBeTruthy()
    expect(screen.getByText('晨星设计圈有新版本')).toBeTruthy()
    expect(screen.queryByText('全部停止并切换空间')).toBeNull()
  })

  it('fires the row action when a notification is clicked', () => {
    const opened: string[] = []
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(NotificationCenter, {
        notifications: NOTIFICATIONS.map(item => ({
          ...item,
          onOpen: () => { opened.push(item.id) },
        })),
      }),
    ))

    fireEvent.click(screen.getByTestId('notify-item-access-north'))
    expect(opened).toEqual(['access-north'])
  })

  it('shows the empty state and the stop-all footer only when provided', () => {
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(NotificationCenter, {
        notifications: [],
        onStopAllAndSwitchSpace: () => {},
      }),
    ))

    expect(screen.getByText('没有新通知')).toBeTruthy()
    expect(screen.getByText('全部停止并切换空间')).toBeTruthy()
  })
})
