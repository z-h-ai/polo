/** POO-134: ChatInputZone × Goal wiring — the zone reads the per-session
 * goal atoms (default jotai store), renders the GoalStrip above the option
 * badges only while a non-terminal Goal projection exists, derives
 * goalModeActive from armed ∪ projection, routes the strip's pause/resume and
 * the menu's goal-end through AppShellContext.onGoalCommand, and lets a
 * second menu selection cancel the armed-but-unsent goal intent. The heavy
 * subtree (InputContainer) is stubbed; ActiveOptionBadges is a prop-capturing
 * stub exposing its goal callbacks as buttons. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { GoalProjection } from '@polo-ai/shared/protocol'

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

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))
mock.module('@/components/app-shell/input/InputContainer', () => ({
  InputContainer: () => createElement('div', { 'data-testid': 'input-container-stub' }),
}))

// Prop-capturing stub: exposes the goal callbacks as plain buttons so tests
// can drive the wiring without re-testing the menu internals.
let badgeProps: Record<string, unknown> | null = null
mock.module('@/components/app-shell/ActiveOptionBadges', () => ({
  ActiveOptionBadges: (props: Record<string, unknown>) => {
    badgeProps = props
    return createElement('div', { 'data-testid': 'active-option-badges-stub' },
      createElement('button', {
        type: 'button',
        'data-testid': 'stub-goal-toggle',
        onClick: () => (props.onGoalModeToggle as (() => void) | undefined)?.(),
      }),
      createElement('button', {
        type: 'button',
        'data-testid': 'stub-goal-end',
        onClick: () => (props.onGoalEnd as (() => void) | undefined)?.(),
      }),
    )
  },
}))

// onGoalCommand lands here (App.tsx owns the actual sessionCommand RPC).
let goalCommandCalls: Array<[string, 'goalPause' | 'goalResume' | 'goalEnd']> = []
mock.module('@/context/AppShellContext', () => ({
  useOptionalAppShellContext: () => ({
    onGoalCommand: (sessionId: string, command: 'goalPause' | 'goalResume' | 'goalEnd') => {
      goalCommandCalls.push([sessionId, command])
    },
  }),
  useAppShellContext: () => {
    throw new Error('not used in this test')
  },
}))

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ChatInputZone } = await import('../ChatInputZone')
const { goalProjectionAtomFamily, goalModeActiveAtomFamily } = await import('../../../../atoms/sessions')

const store = getDefaultStore()
let sessionSeq = 0

function projection(overrides: Partial<GoalProjection> = {}): GoalProjection {
  sessionSeq += 1
  const sessionId = `zone-goal-${sessionSeq}`
  return {
    revision: 1,
    sessionId,
    currentGoalId: 'goal-1',
    goal: {
      id: 'goal-1',
      sessionId,
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
    },
    ...overrides,
  }
}

function renderZone(sessionId: string) {
  return render(createElement(I18nextProvider, { i18n }, createElement(ChatInputZone, {
    sessionId,
    inputProps: {
      placeholder: '',
      disabled: true,
      currentModel: '',
      onSubmit: () => {},
      onInputChange: () => {},
    },
  })))
}

beforeEach(() => {
  cleanup()
  badgeProps = null
  goalCommandCalls = []
})

afterEach(() => {
  cleanup()
})

describe('ChatInputZone × Goal 接线（POO-134）', () => {
  it('非终态投影：渲染 Goal 条，badges 收到 goalModeActive=goalRunning=true', () => {
    const p = projection()
    store.set(goalProjectionAtomFamily(p.sessionId), p)
    renderZone(p.sessionId)
    expect(screen.getByTestId('goal-strip')).not.toBeNull()
    expect(badgeProps?.goalModeActive).toBe(true)
    expect(badgeProps?.goalRunning).toBe(true)
  })

  it('终态投影（无 currentGoalId）：journey #5 起保留只读 Goal 条，goalRunning=false', () => {
    const p = projection()
    delete (p as { currentGoalId?: string }).currentGoalId
    if (p.goal) p.goal.status = 'completed'
    store.set(goalProjectionAtomFamily(p.sessionId), p)
    renderZone(p.sessionId)
    // Journey #5: the last record stays readable after the Goal ends — the
    // strip renders it read-only (no pause/resume actions) instead of
    // vanishing with the terminal projection.
    expect(screen.getByTestId('goal-strip')).not.toBeNull()
    expect(screen.queryByTestId('goal-strip-pause')).toBeNull()
    expect(screen.queryByTestId('goal-strip-resume')).toBeNull()
    expect(badgeProps?.goalRunning).toBe(false)
    expect(badgeProps?.goalModeActive).toBe(false)
  })

  it('armed（未发送）也点亮 goalModeActive，但不渲染 Goal 条', () => {
    const sessionId = `zone-armed-${sessionSeq + 1}`
    store.set(goalModeActiveAtomFamily(sessionId), true)
    renderZone(sessionId)
    expect(screen.queryByTestId('goal-strip')).toBeNull()
    expect(badgeProps?.goalModeActive).toBe(true)
    expect(badgeProps?.goalRunning).toBe(false)
  })

  it('未发送时再选可取消：toggle 点亮再熄灭 armed', () => {
    const sessionId = `zone-cancel-${sessionSeq + 1}`
    renderZone(sessionId)
    fireEvent.click(screen.getByTestId('stub-goal-toggle'))
    expect(store.get(goalModeActiveAtomFamily(sessionId))).toBe(true)
    expect(badgeProps?.goalModeActive).toBe(true)
    fireEvent.click(screen.getByTestId('stub-goal-toggle'))
    expect(store.get(goalModeActiveAtomFamily(sessionId))).toBe(false)
    expect(badgeProps?.goalModeActive).toBe(false)
  })

  it('Goal 条暂停按钮与菜单结束目标都汇入 onGoalCommand', () => {
    const p = projection()
    store.set(goalProjectionAtomFamily(p.sessionId), p)
    renderZone(p.sessionId)
    fireEvent.click(screen.getByTestId('goal-strip-pause'))
    fireEvent.click(screen.getByTestId('stub-goal-end'))
    expect(goalCommandCalls).toEqual([
      [p.sessionId, 'goalPause'],
      [p.sessionId, 'goalEnd'],
    ])
  })

  it('paused 投影的继续按钮汇入 onGoalCommand(goalResume)', () => {
    const p = projection({
      currentGoalId: 'goal-1',
      goal: {
        id: 'goal-1',
        sessionId: 'zone-anything',
        anchorMessageId: 'm1',
        objective: 'Ship the renderer',
        supplementMessageIds: [],
        status: 'paused',
        pauseReason: 'manual',
        version: 2,
        runGeneration: 1,
        elapsedMs: 1200,
        criteria: [],
        todos: [],
        createdAt: 1,
        updatedAt: 2,
      },
    })
    store.set(goalProjectionAtomFamily(p.sessionId), p)
    renderZone(p.sessionId)
    fireEvent.click(screen.getByTestId('goal-strip-resume'))
    expect(goalCommandCalls).toEqual([[p.sessionId, 'goalResume']])
  })
})
