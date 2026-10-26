/** POO-134: the permission-mode dropdown grows the Goal entries — a FIRST
 * group ("Goal mode") above the permission modes, and, while a Goal runs,
 * a disabled entry plus a trailing "End goal" action. Goal stays orthogonal
 * to PermissionMode: selecting it never touches onPermissionModeChange, and
 * the armed button reads "Goal mode · <mode>". Real SlashCommandMenu + Radix
 * popover; only the theme hook is stubbed (import.meta.glob breaks under bun). */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()

mock.module('@/context/ThemeContext', () => ({ useTheme: () => ({ isDark: false }) }))
// SessionInfoPopover's module body touches window.electronAPI at import time
// and is irrelevant to the menu contract — stub at the module edge.
mock.module('@/components/app-shell/SessionInfoPopover', () => ({
  SessionInfoPopover: () => createElement('div', { 'data-testid': 'session-info-stub' }),
}))

// Edge stubs (shared-process pattern): the import graph pulls pdfjs and
// Sentry transitively; neither participates in the dropdown contract.
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))

const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ActiveOptionBadges } = await import('../ActiveOptionBadges')

interface GoalMenuProps {
  permissionMode?: 'safe' | 'ask' | 'allow-all'
  goalModeActive?: boolean
  goalRunning?: boolean
  onGoalModeToggle?: () => void
  onGoalEnd?: () => void
  onPermissionModeChange?: (mode: 'safe' | 'ask' | 'allow-all') => void
}

function tree(props: GoalMenuProps) {
  return createElement(I18nextProvider, { i18n }, createElement(ActiveOptionBadges, {
    permissionMode: props.permissionMode ?? 'ask',
    onPermissionModeChange: props.onPermissionModeChange,
    goalModeActive: props.goalModeActive,
    goalRunning: props.goalRunning,
    onGoalModeToggle: props.onGoalModeToggle,
    onGoalEnd: props.onGoalEnd,
  }))
}

function findTrigger(): HTMLElement {
  const el = document.querySelector('[data-tutorial="permission-mode-dropdown"]')
  if (!el) throw new Error('permission-mode-dropdown trigger not found')
  return el as HTMLElement
}

function menuItem(id: string): HTMLElement | null {
  return document.querySelector(`[data-tutorial="permission-mode-${id}"]`)
}

async function openMenu(props: GoalMenuProps) {
  render(tree(props))
  await userEvent.setup().click(findTrigger())
  // Radix mounts the cmdk list asynchronously on open.
  await waitFor(() => expect(menuItem('goal')).not.toBeNull())
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('模式菜单目标模式（POO-134）', () => {
  it('目标模式是菜单第一项，位于权限模式（Explore）之上', async () => {
    await openMenu({})
    const items = Array.from(document.querySelectorAll('[data-tutorial^="permission-mode-"]:not([data-tutorial="permission-mode-dropdown"])'))
    expect(items[0].getAttribute('data-tutorial')).toBe('permission-mode-goal')
    const goalIndex = items.findIndex(el => el.getAttribute('data-tutorial') === 'permission-mode-goal')
    const safeIndex = items.findIndex(el => el.getAttribute('data-tutorial') === 'permission-mode-safe')
    expect(goalIndex).toBeLessThan(safeIndex)
  })

  it('点击目标模式触发 onGoalModeToggle，不触碰权限回调（正交）', async () => {
    const onGoalModeToggle = mock(() => {})
    const onPermissionModeChange = mock(() => {})
    await openMenu({ onGoalModeToggle, onPermissionModeChange })
    fireEvent.click(menuItem('goal')!)
    expect(onGoalModeToggle).toHaveBeenCalledTimes(1)
    expect(onPermissionModeChange).not.toHaveBeenCalled()
  })

  it('未运行时没有「结束目标」入口', async () => {
    await openMenu({ goalRunning: false })
    expect(menuItem('goal-end')).toBeNull()
  })

  it('Goal 运行中：目标模式项禁用不可选，尾部出现「结束目标」，点击发 onGoalEnd', async () => {
    const onGoalModeToggle = mock(() => {})
    const onGoalEnd = mock(() => {})
    await openMenu({ goalRunning: true, onGoalModeToggle, onGoalEnd })
    const goalItem = menuItem('goal')!
    expect(goalItem.getAttribute('data-disabled')).toBe('true')
    fireEvent.click(goalItem)
    expect(onGoalModeToggle).not.toHaveBeenCalled()
    expect(menuItem('goal-end')).not.toBeNull()
    fireEvent.click(menuItem('goal-end')!)
    expect(onGoalEnd).toHaveBeenCalledTimes(1)
  })

  it('armed 时按钮显示「目标模式 · <当前权限名>」', async () => {
    render(tree({ goalModeActive: true, permissionMode: 'ask' }))
    const trigger = findTrigger()
    expect(trigger.textContent).toContain('Goal mode')
    expect(trigger.textContent).toContain('Ask')
  })

  it('回归：权限模式切换仍走原回调', async () => {
    const onPermissionModeChange = mock(() => {})
    await openMenu({ onPermissionModeChange })
    fireEvent.click(menuItem('safe')!)
    expect(onPermissionModeChange).toHaveBeenCalledWith('safe')
  })
})
