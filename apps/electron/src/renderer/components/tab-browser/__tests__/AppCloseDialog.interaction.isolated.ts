import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { RuntimeTask } from '../AppRuntimeTasksContext'

GlobalRegistrator.register()
setupI18n()

const {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} = await import('@testing-library/react')
const { AppCloseDialog } = await import('../AppCloseDialog')

const TASK_QUOTE: RuntimeTask = {
  id: 'task-quote',
  appId: 'app-quote',
  tabId: 'tab-quote',
  spaceId: 'space-ent',
  spaceName: '晨星科技',
  kind: 'app',
  title: '整理 10 月报价',
  appName: '报价整理',
  startedAt: 1,
  state: 'running',
}

const TASK_REPORT: RuntimeTask = {
  id: 'task-report',
  appId: 'app-report',
  tabId: 'tab-report',
  spaceId: 'space-ent',
  spaceName: '晨星科技',
  kind: 'app',
  title: '生成月度报表',
  appName: '数据报表生成器',
  startedAt: 2,
  state: 'running',
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
})

afterEach(() => {
  cleanup()
})

function renderDialog(overrides: Partial<Parameters<typeof AppCloseDialog>[0]>) {
  const props = {
    open: true,
    appName: '报价整理',
    tasks: [TASK_QUOTE, TASK_REPORT],
    onCancel: () => {},
    onBackgroundContinue: () => {},
    onStopTasks: async () => [] as RuntimeTask[],
    onTerminateSucceeded: () => {},
    ...overrides,
  }
  const spies = {
    cancel: props.onCancel,
    background: props.onBackgroundContinue,
    terminated: props.onTerminateSucceeded,
  }
  return {
    spies,
    ...render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AppCloseDialog, props),
    )),
  }
}

describe('AppCloseDialog three-option flow (P-M04-CLOSE-ACTIVE)', () => {
  it('offers cancel / background continue / stop and close with the running tasks listed', () => {
    renderDialog({})

    expect(screen.getByTestId('app-close-dialog')).toBeTruthy()
    expect(screen.getByText('关闭 报价整理')).toBeTruthy()
    expect(screen.getByText('报价整理 还有 2 个未结束的后台任务。')).toBeTruthy()
    expect(screen.getByText('整理 10 月报价')).toBeTruthy()
    expect(screen.getByText('生成月度报表')).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '后台继续' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停止并关闭' })).toBeTruthy()
  })

  it('background continue hands control back without stopping tasks', () => {
    let backgroundCalls = 0
    renderDialog({ onBackgroundContinue: () => { backgroundCalls += 1 } })

    fireEvent.click(screen.getByRole('button', { name: '后台继续' }))
    expect(backgroundCalls).toBe(1)
  })

  it('closes through onTerminateSucceeded when every task stops', async () => {
    let terminated = 0
    const stopped: string[][] = []
    renderDialog({
      onStopTasks: async tasks => {
        stopped.push(tasks.map(task => task.id))
        return []
      },
      onTerminateSucceeded: () => { terminated += 1 },
    })

    fireEvent.click(screen.getByRole('button', { name: '停止并关闭' }))
    await waitFor(() => {
      expect(terminated).toBe(1)
    })
    expect(stopped).toEqual([['task-quote', 'task-report']])
  })

  it('keeps the dialog in term-failed state and retries only the failed tasks', async () => {
    const stopped: string[][] = []
    let failFirst = true
    renderDialog({
      onStopTasks: async tasks => {
        stopped.push(tasks.map(task => task.id))
        if (failFirst) {
          failFirst = false
          return [TASK_QUOTE]
        }
        return []
      },
    })

    fireEvent.click(screen.getByRole('button', { name: '停止并关闭' }))
    await waitFor(() => {
      expect(screen.getByText('停止失败')).toBeTruthy()
    })
    // 只重试失败项：成功项不再出现在停止请求里。
    fireEvent.click(screen.getByRole('button', { name: '再试一次' }))
    await waitFor(() => {
      expect(stopped).toEqual([
        ['task-quote', 'task-report'],
        ['task-quote'],
      ])
    })
  })

  it('back-to-app leaves the dialog without a terminate success', async () => {
    let terminated = 0
    let cancelled = 0
    renderDialog({
      onStopTasks: async () => [TASK_QUOTE],
      onTerminateSucceeded: () => { terminated += 1 },
      onCancel: () => { cancelled += 1 },
    })

    fireEvent.click(screen.getByRole('button', { name: '停止并关闭' }))
    await waitFor(() => {
      expect(screen.getByText('停止失败')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: '返回页面' }))
    expect(cancelled).toBe(1)
    expect(terminated).toBe(0)
  })
})
