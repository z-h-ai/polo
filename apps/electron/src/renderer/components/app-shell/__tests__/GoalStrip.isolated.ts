/** POO-134: GoalStrip contract — the server-authoritative Goal bar above the
 * chat input. Pins the single-action rule (active→pause, paused→resume,
 * verifying→running label, never both), the frozen clock semantics
 * (computeGoalElapsedMs stops when runningSince is absent), the upward todo
 * panel (counts, empty states, scroll, Escape collapse, focus return), and
 * the paused-never-animates rule. Renders the real component with real i18n;
 * no App/AppShell dependencies (onPause/onResume are props). */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { GoalRecord, GoalTodoItem } from '@polo-ai/shared/protocol'

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

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { GoalStrip } = await import('../GoalStrip')

let seq = 0
function todo(label: string, status: GoalTodoItem['status']): GoalTodoItem {
  seq += 1
  return { id: `td-${seq}`, label, status, seq, updatedAt: 1 }
}

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    sessionId: 's1',
    anchorMessageId: 'm1',
    objective: 'Ship the renderer',
    supplementMessageIds: [],
    status: 'active',
    version: 1,
    runGeneration: 1,
    elapsedMs: 0,
    criteria: [],
    todos: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

// Each render gets a FRESH per-session expansion atom — the atom family is
// module-global (default jotai store), so reusing a session id across cases
// would leak the previous case's expanded state.
let sessionSeq = 0
function tree(record: GoalRecord, onPause = () => {}, onResume = () => {}) {
  sessionSeq += 1
  const sessionId = `goal-strip-session-${sessionSeq}`
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(GoalStrip, { sessionId, goal: { ...record, sessionId }, onPause, onResume }),
  )
}

beforeEach(() => {
  cleanup()
  seq = 0
})

afterEach(() => {
  cleanup()
})

describe('GoalStrip 单一动作区（POO-134）', () => {
  it('active：唯一按钮是暂停，点击发 onPause；状态徽标显示进行中', () => {
    const onPause = mock(() => {})
    render(tree(goal({ status: 'active', elapsedMs: 65000 }), onPause))
    expect(screen.getByTestId('goal-strip-pause').textContent).toBe('Pause')
    expect(screen.queryByTestId('goal-strip-resume')).toBeNull()
    expect(screen.getByTestId('goal-strip-status').textContent).toBe('Running')
    fireEvent.click(screen.getByTestId('goal-strip-pause'))
    expect(onPause).toHaveBeenCalledTimes(1)
  })

  it('paused：唯一按钮是继续，点击发 onResume；状态徽标显示已暂停', () => {
    const onResume = mock(() => {})
    render(tree(goal({ status: 'paused', pauseReason: 'manual', elapsedMs: 30000 }), () => {}, onResume))
    expect(screen.getByTestId('goal-strip-resume').textContent).toBe('Resume')
    expect(screen.queryByTestId('goal-strip-pause')).toBeNull()
    expect(screen.getByTestId('goal-strip-status').textContent).toBe('Paused')
    fireEvent.click(screen.getByTestId('goal-strip-resume'))
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('verifying：按钮位显示进行中文案，无任何动作按钮', () => {
    render(tree(goal({ status: 'verifying', runningSince: Date.now() - 1000 })))
    expect(screen.getByTestId('goal-strip-verifying').textContent).toBe('Running')
    expect(screen.queryByTestId('goal-strip-pause')).toBeNull()
    expect(screen.queryByTestId('goal-strip-resume')).toBeNull()
  })
})

describe('GoalStrip 用时停表（computeGoalElapsedMs 语义）', () => {
  it('无 runningSince（暂停/等待/失败）：显示冻结的累计时间，不tick', () => {
    render(tree(goal({ status: 'paused', pauseReason: 'awaiting_user', elapsedMs: 3725000 })))
    // 3725s = 1:02:05 — deterministic, no clock segment.
    expect(screen.getByTestId('goal-strip-elapsed').textContent).toBe('1:02:05')
  })

  it('running：显示累计+本段，格式 m:ss / h:mm:ss', () => {
    render(tree(goal({ status: 'active', elapsedMs: 65000 })))
    expect(screen.getByTestId('goal-strip-elapsed').textContent).toBe('1:05')
  })
})

describe('GoalStrip 展开面板（只读 Todo）', () => {
  it('默认收起；点击摘要展开，渲染 todo/完成计数/状态图标', () => {
    render(tree(goal({
      status: 'active',
      todos: [
        todo('read spec', 'completed'),
        todo('write code', 'in_progress'),
        todo('run tests', 'pending'),
      ],
    })))
    expect(screen.getByTestId('goal-strip-panel').getAttribute('data-open')).toBe('false')
    fireEvent.click(screen.getByTestId('goal-strip-trigger'))
    expect(screen.getByTestId('goal-strip-panel').getAttribute('data-open')).toBe('true')
    expect(screen.getByTestId('goal-todo-list').children.length).toBe(3)
    expect(screen.getByTestId('goal-strip-count').textContent).toBe('1/3 done')
    expect(screen.getByTestId('goal-todo-item-td-1').getAttribute('data-todo-status')).toBe('completed')
    expect(screen.getByTestId('goal-todo-item-td-2').getAttribute('data-todo-status')).toBe('in_progress')
    expect(screen.getByTestId('goal-todo-item-td-3').getAttribute('data-todo-status')).toBe('pending')
  })

  it('动作按钮不触发展开（独立于 trigger）', () => {
    render(tree(goal({ status: 'active' })))
    fireEvent.click(screen.getByTestId('goal-strip-pause'))
    expect(screen.getByTestId('goal-strip-panel').getAttribute('data-open')).toBe('false')
  })

  it('active 空 todo：正在拆解空态；paused awaiting_user：等待补充空态', () => {
    const { unmount } = render(tree(goal({ status: 'active' })))
    fireEvent.click(screen.getByTestId('goal-strip-trigger'))
    expect(screen.getByTestId('goal-todos-empty').textContent).toBe('Breaking down the goal…')
    unmount()

    render(tree(goal({ status: 'paused', pauseReason: 'awaiting_user' })))
    fireEvent.click(screen.getByTestId('goal-strip-trigger'))
    expect(screen.getByTestId('goal-todos-empty').textContent).toBe('Waiting for more details…')
  })

  it('暂停不播执行动画：in_progress 圆点仅在 Goal running 时带 pulse 类', () => {
    const todos = [todo('write code', 'in_progress')]
    const { unmount } = render(tree(goal({ status: 'active', todos })))
    fireEvent.click(screen.getByTestId('goal-strip-trigger'))
    const activeDot = screen.getByTestId('goal-todo-item-td-1').firstElementChild as HTMLElement
    expect(activeDot.className).toContain('goal-todo-pulse')
    unmount()

    render(tree(goal({ status: 'paused', pauseReason: 'manual', todos })))
    fireEvent.click(screen.getByTestId('goal-strip-trigger'))
    const pausedDot = screen.getByTestId('goal-todo-item-td-1').firstElementChild as HTMLElement
    expect(pausedDot.className).not.toContain('goal-todo-pulse')
  })

  it('长清单：列表容器固定高度内滚动（overflow-y-auto）', () => {
    render(tree(goal({
      status: 'active',
      todos: Array.from({ length: 30 }, (_, i) => todo(`step ${i + 1}`, 'pending')),
    })))
    fireEvent.click(screen.getByTestId('goal-strip-trigger'))
    const list = screen.getByTestId('goal-todo-list') as HTMLElement
    expect(list.className).toContain('overflow-y-auto')
    expect(list.children.length).toBe(30)
  })
})

describe('GoalStrip 键盘与焦点', () => {
  it('Escape 收起面板并把焦点还给 trigger', () => {
    const { container } = render(tree(goal({ status: 'active' })))
    const trigger = screen.getByTestId('goal-strip-trigger')
    fireEvent.click(trigger)
    expect(screen.getByTestId('goal-strip-panel').getAttribute('data-open')).toBe('true')
    fireEvent.keyDown(container.querySelector('[data-testid="goal-strip"]')!, { key: 'Escape' })
    expect(screen.getByTestId('goal-strip-panel').getAttribute('data-open')).toBe('false')
    expect(container.ownerDocument.activeElement).toBe(trigger)
  })

  it('收起时面板内容带 inert，不进 Tab 序；展开后移除', () => {
    render(tree(goal({ status: 'active', todos: [todo('a', 'pending')] })))
    const inner = screen.getByTestId('goal-strip-panel').firstElementChild as HTMLElement
    expect(inner.hasAttribute('inert')).toBe(true)
    fireEvent.click(screen.getByTestId('goal-strip-trigger'))
    expect(inner.hasAttribute('inert')).toBe(false)
  })
})
