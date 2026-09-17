import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

GlobalRegistrator.register()
setupI18n()

function passthrough({ children }: { children?: ReactNode }) {
  return createElement('div', null, children)
}

mock.module('@/components/ui/styled-dropdown', () => ({
  DropdownMenu: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyledDropdownMenuContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyledDropdownMenuItem: ({ children, ...props }: { children?: ReactNode }) =>
    createElement('button', { type: 'button', ...props }, children),
  StyledDropdownMenuSeparator: () => createElement('hr'),
}))

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { ProductSpaceSwitcher } = await import('../ProductSpaceSwitcher')
const { ProductSpaceSwitchDialog } = await import('../ProductSpaceSwitchDialog')

const accountId = 'account-a'
const personalId = 'space-personal'
const personalSpace = {
  id: personalId,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
} as unknown as ProductSpaceSummary
const enterpriseSpace = {
  id: 'space-ent',
  kind: 'enterprise',
  enterpriseId: 'enterprise-1',
  name: '北辰智能科技',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-1' },
} as unknown as ProductSpaceSummary
const restrictedEnterprise = {
  id: 'space-ent-restricted',
  kind: 'enterprise',
  enterpriseId: 'enterprise-2',
  name: '受限企业',
  role: 'member',
  accessMode: 'read_only',
  restrictionCode: 'billing_restricted',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-2' },
} as unknown as ProductSpaceSummary

function makeContextValue(overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    activeProductSpaceId: personalId,
    activeProductSpace: personalSpace,
    productSpaces: [personalSpace, enterpriseSpace],
    allProductSpaces: [personalSpace, enterpriseSpace],
    personalProductSpaceId: personalId,
    productSpaceContextKey: JSON.stringify(['product-space', 1, accountId, personalId]),
    contextVersion: 1,
    pendingSwitch: null,
    onSelectProductSpace: mock(() => {}),
    onRefreshProductSpaces: mock(() => {}),
    onConfirmStopAndSwitch: mock(() => {}),
    onRetryFailedStops: mock(() => {}),
    onRetryTargetLoad: mock(() => {}),
    onCancelSwitch: mock(() => {}),
    onDismissTargetAccessLost: mock(() => {}),
    ...overrides,
  }
}

function renderWithContext(value: Record<string, unknown>) {
  const Provider = ProductSpaceProvider as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(
      Provider,
      { value },
      createElement(ProductSpaceSwitcher),
      createElement(ProductSpaceSwitchDialog),
    ),
  ))
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(() => {
  cleanup()
})

describe('ProductSpaceSwitcher', () => {
  it('exposes stable anchors and lists only personal and enterprise spaces', () => {
    renderWithContext(makeContextValue())
    expect(screen.getByTestId('product-space-switcher')).toBeTruthy()
    const items = screen.getAllByTestId('product-space-item')
    expect(items).toHaveLength(2)
    expect(items.map(item => item.getAttribute('data-space-kind')))
      .toEqual(['personal', 'enterprise'])
  })

  it('never lists a CreatorCircle as a space', () => {
    renderWithContext(makeContextValue())
    for (const item of screen.getAllByTestId('product-space-item')) {
      expect(item.getAttribute('data-space-kind')).not.toBe('creator_circle')
      expect(item.textContent).not.toContain('圈子')
    }
  })

  it('selects a space through the switcher row', () => {
    const onSelectProductSpace = mock(() => {})
    renderWithContext(makeContextValue({ onSelectProductSpace }))
    fireEvent.click(screen.getAllByTestId('product-space-item')[1]!)
    expect(onSelectProductSpace).toHaveBeenCalledWith('space-ent')
  })

  it('marks the active space and restricted spaces', () => {
    renderWithContext(makeContextValue({
      productSpaces: [personalSpace, enterpriseSpace, restrictedEnterprise],
      allProductSpaces: [personalSpace, enterpriseSpace, restrictedEnterprise],
      activeProductSpaceId: personalId,
    }))
    const items = screen.getAllByTestId('product-space-item')
    expect(items[0]!.getAttribute('disabled') !== null).toBe(true)
    expect(items[2]!.textContent).toContain('受限')
  })
})

describe('ProductSpaceSwitchDialog', () => {
  it('shows the confirm dialog with stop-all as the primary action', () => {
    const onCancelSwitch = mock(() => {})
    renderWithContext(makeContextValue({
      pendingSwitch: {
        targetId: 'space-ent',
        phase: 'confirm',
        executions: [
          { executionId: 'exec-1', name: '访谈整理', status: 'running' },
        ],
        statuses: { 'exec-1': 'running' },
        errorCode: null,
      },
      onCancelSwitch,
    }))
    expect(screen.getByTestId('product-space-switch-dialog').getAttribute('data-switch-phase'))
      .toBe('confirm')
    expect(screen.getByTestId('product-space-switch-title').textContent).toBe('切换到北辰智能科技')
    expect(screen.getByTestId('product-space-stop-and-switch').textContent).toBe('终止全部并切换')
    fireEvent.click(screen.getByTestId('product-space-cancel-switch'))
    expect(onCancelSwitch).toHaveBeenCalled()
  })

  it('keeps the origin space visible during termination and offers retry on failure', () => {
    const onRetryFailedStops = mock(() => {})
    const onCancelSwitch = mock(() => {})
    renderWithContext(makeContextValue({
      pendingSwitch: {
        targetId: 'space-ent',
        phase: 'stop-failed',
        executions: [
          { executionId: 'exec-1', name: '访谈整理', status: 'stopped' },
          { executionId: 'exec-2', name: '周报助手', status: 'stopping' },
        ],
        statuses: { 'exec-1': 'stopped', 'exec-2': 'failed' },
        errorCode: 'runtime_stop_failed',
      },
      onRetryFailedStops,
      onCancelSwitch,
    }))
    expect(screen.getByTestId('product-space-switch-dialog').getAttribute('data-switch-phase'))
      .toBe('stop-failed')
    expect(screen.getByTestId('product-space-switch-note').textContent).toBe('当前仍在我的空间')
    expect(screen.getByTestId('product-space-switch-failed-alert').textContent).toContain('未能终止')
    fireEvent.click(screen.getByTestId('product-space-retry-failed'))
    expect(onRetryFailedStops).toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('product-space-cancel-switch'))
    expect(onCancelSwitch).toHaveBeenCalled()
  })

  it('offers retry or stay when the target space fails to load', () => {
    const onRetryTargetLoad = mock(() => {})
    renderWithContext(makeContextValue({
      pendingSwitch: {
        targetId: 'space-ent',
        phase: 'target-failed',
        executions: [],
        statuses: {},
        errorCode: 'service_unavailable',
      },
      onRetryTargetLoad,
    }))
    expect(screen.getByTestId('product-space-switch-title').textContent).toBe('未能加载北辰智能科技')
    fireEvent.click(screen.getByTestId('product-space-retry-target-load'))
    expect(onRetryTargetLoad).toHaveBeenCalled()
    expect(screen.getByTestId('product-space-cancel-switch').textContent).toBe('留在我的空间')
  })
})

describe('ProductSpaceSwitchDialog per-item stop (R33-3)', () => {
  it('every nonterminal row is clickable for a single stop with real production statuses', () => {
    const onStopSwitchExecution = mock(() => {})
    renderWithContext(makeContextValue({
      pendingSwitch: {
        targetId: 'space-ent',
        phase: 'stopping',
        executions: [
          { executionId: 'exec-1', name: '访谈整理', status: 'running' },
          { executionId: 'exec-2', name: '周报助手', status: 'preparing' },
          { executionId: 'exec-3', name: '翻译任务', status: 'waiting_for_network' },
          { executionId: 'exec-4', name: '数据整理', status: 'stopped' },
          { executionId: 'exec-5', name: '图片导出', status: 'failed' },
          { executionId: 'exec-6', name: '代码评审', status: 'stopping' },
        ],
        statuses: {
          'exec-1': 'running',
          'exec-2': 'preparing',
          'exec-3': 'waiting_for_network',
          'exec-4': 'stopped',
          'exec-5': 'failed',
          'exec-6': 'stopping',
        },
        errorCode: null,
      },
      onStopSwitchExecution,
    }))
    const buttons = screen.getAllByTestId('product-space-switch-execution-stop')
    // Exactly the four nonterminal rows (running/preparing/waiting_for_
    // network) are reachable; stopped/failed/stopping rows are not.
    expect(buttons).toHaveLength(3)
    fireEvent.click(buttons[0]!)
    expect(onStopSwitchExecution).toHaveBeenCalledWith('exec-1')
    fireEvent.click(buttons[1]!)
    expect(onStopSwitchExecution).toHaveBeenCalledWith('exec-2')
    fireEvent.click(buttons[2]!)
    expect(onStopSwitchExecution).toHaveBeenCalledWith('exec-3')
    // The selected-row status projection stays truthful per row.
    const rows = screen.getAllByTestId('product-space-switch-execution-row')
    expect(rows[0]!.getAttribute('data-execution-status')).toBe('running')
    expect(rows[3]!.getAttribute('data-execution-status')).toBe('stopped')
    expect(rows[5]!.getAttribute('data-execution-status')).toBe('stopping')
  })

  it('a stopping-phase row that already dispatched shows no second stop button', () => {
    const onStopSwitchExecution = mock(() => {})
    renderWithContext(makeContextValue({
      pendingSwitch: {
        targetId: 'space-ent',
        phase: 'stopping',
        executions: [
          { executionId: 'exec-1', name: '访谈整理', status: 'running' },
        ],
        statuses: { 'exec-1': 'stopping' },
        errorCode: null,
      },
      onStopSwitchExecution,
    }))
    expect(screen.queryAllByTestId('product-space-switch-execution-stop')).toHaveLength(0)
    expect(onStopSwitchExecution).not.toHaveBeenCalled()
  })
})
