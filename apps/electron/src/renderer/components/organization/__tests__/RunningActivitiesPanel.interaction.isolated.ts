import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import type { RunningActivityEntry } from '../useSpaceSwitchFlow'

GlobalRegistrator.register()
setupI18n()
await i18n.changeLanguage('zh-Hans')

const { cleanup, render, screen } = await import('@testing-library/react')
const { RunningActivitiesPanel } = await import('../RunningActivitiesPanel')

const ENTRIES: RunningActivityEntry[] = [
  {
    id: 'act-report',
    kind: 'app',
    name: '数据报表生成器',
    detail: '同空间后台运行',
    status: 'stopped',
  },
  {
    id: 'act-crm',
    kind: 'app',
    name: '客户资料面板',
    detail: '运行中 · 前台',
    status: 'stopping',
  },
  {
    id: 'act-weekly',
    kind: 'assistant',
    name: '销售周报',
    detail: '正在生成回答',
    status: 'failed',
  },
]

function renderPanel(entries: RunningActivityEntry[]) {
  return render(
    createElement(I18nextProvider, { i18n }, createElement(RunningActivitiesPanel, { items: entries })),
  )
}

afterEach(() => {
  cleanup()
})

describe('RunningActivitiesPanel', () => {
  it('renders one row per ledger item with name, type line and detail', () => {
    renderPanel(ENTRIES)
    const rows = screen.getAllByTestId('running-activity-row')
    expect(rows).toHaveLength(3)
    // The type line lives in the row's small element (kind label · detail).
    const typeLines = rows.map((row) => row.querySelector('small')?.textContent ?? '')
    expect(typeLines).toEqual([
      'App · 同空间后台运行',
      'App · 运行中 · 前台',
      '助手生成 · 正在生成回答',
    ])
    const names = rows.map((row) => row.querySelector('strong')?.textContent ?? '')
    expect(names).toEqual(['数据报表生成器', '客户资料面板', '销售周报'])
  })

  it('maps every stop status to its badge label', () => {
    renderPanel([
      { ...ENTRIES[0], status: 'running' },
      { ...ENTRIES[1], status: 'stopping' },
      { ...ENTRIES[2], status: 'stopped' },
      { ...ENTRIES[2], id: 'extra', status: 'failed' },
    ])
    const statuses = screen
      .getAllByTestId('running-activity-status')
      .map((element) => element.textContent)
    expect(statuses).toEqual(['运行中', '停止中', '已停止', '失败'])
  })

  it('renders nothing for an empty ledger', () => {
    const { container } = renderPanel([])
    expect(container.querySelector('[data-testid="running-activities-panel"]')).toBeNull()
  })
})
