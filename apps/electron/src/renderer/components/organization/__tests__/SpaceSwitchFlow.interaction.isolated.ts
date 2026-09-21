import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import type {
  RunningActivity,
  SpaceSwitchFlowDeps,
  SpaceSwitchTarget,
} from '../useSpaceSwitchFlow'

GlobalRegistrator.register()
setupI18n()
await i18n.changeLanguage('zh-Hans')

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { SpaceSwitchFlow } = await import('../SpaceSwitchFlow')
const { SpaceSwitchFlowProvider, useSpaceSwitchFlow } = await import('../useSpaceSwitchFlow')

const TARGET: SpaceSwitchTarget = { id: 'org-personal', name: '我的空间' }

const ACTIVITIES: RunningActivity[] = [
  { id: 'act-report', kind: 'app', name: '数据报表生成器', detail: '同空间后台运行' },
  { id: 'act-crm', kind: 'app', name: '客户资料面板', detail: '运行中 · 前台' },
  { id: 'act-weekly', kind: 'assistant', name: '销售周报', detail: '正在生成回答' },
]

/** Failure trajectory: the second item fails to stop. */
const FAIL_SECOND: SpaceSwitchFlowDeps = {
  getRunningActivities: () => ACTIVITIES,
  stopActivity: async (activity) => activity.id !== 'act-crm',
  loadTargetSpace: async () => ({ ok: true }),
  commitSwitch: () => {},
}

function Trigger({ target }: { target: SpaceSwitchTarget }) {
  const flow = useSpaceSwitchFlow()
  return createElement(
    'button',
    {
      type: 'button',
      'data-testid': 'demo-trigger',
      onClick: () => flow.requestSwitch(target),
    },
    'trigger',
  )
}

function renderFlow(deps: SpaceSwitchFlowDeps, target: SpaceSwitchTarget = TARGET) {
  return render(
    createElement(I18nextProvider, {
      i18n,
      children: createElement(SpaceSwitchFlowProvider, {
        deps,
        children: [createElement(Trigger, { target }), createElement(SpaceSwitchFlow)],
      }),
    }),
  )
}

afterEach(() => {
  cleanup()
})

describe('SpaceSwitchFlow dialog', () => {
  it('renders nothing while idle', () => {
    renderFlow(FAIL_SECOND)
    expect(screen.queryByTestId('space-switch-dialog')).toBeNull()
  })

  it('confirm → 停止全部并切换 → stopFailed → 取消切换 → stopCancel (C-R04 copy)', async () => {
    renderFlow(FAIL_SECOND)
    fireEvent.click(screen.getByTestId('demo-trigger'))

    // P-M02-CONFIRM
    const dialog = screen.getByTestId('space-switch-dialog')
    expect(dialog.textContent).toContain('切换到 我的空间')
    expect(dialog.textContent).toContain('停止 3 项任务后切换')
    expect(screen.getAllByTestId('running-activity-row')).toHaveLength(3)
    expect(dialog.textContent).toContain('当前仍在')
    expect(dialog.textContent).toContain('取消切换')
    expect(dialog.textContent).toContain('停止全部并切换')

    await act(async () => {
      fireEvent.click(screen.getByText('停止全部并切换'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('space-switch-dialog').textContent).toContain('未能切换空间'),
    )

    // P-M02-STOP-FAILED — 2/3 stopped, failure alert, retry entry point.
    const failedDialog = screen.getByTestId('space-switch-dialog')
    expect(failedDialog.textContent).toContain('已停止 2 / 3')
    expect(failedDialog.textContent).toContain('有 1 项没停下来，请重试。')
    expect(failedDialog.textContent).toContain('重试失败项')

    await act(async () => {
      fireEvent.click(screen.getByText('取消切换'))
    })

    // P-M02-STOP-CANCEL — stops are not rolled back.
    const cancelDialog = screen.getByTestId('space-switch-dialog')
    expect(cancelDialog.textContent).toContain('已取消切换')
    expect(cancelDialog.textContent).toContain('取消的是切换，不撤销已经完成的停止。')
    expect(cancelDialog.textContent).toContain('返回首页')
    expect(cancelDialog.textContent).toContain('重新选择空间')
  })

  it('target failure offers retry and staying in the current space', async () => {
    renderFlow({
      getRunningActivities: () => ACTIVITIES,
      stopActivity: async () => true,
      loadTargetSpace: async () => ({ ok: false, cause: 'load-error' }),
    })
    fireEvent.click(screen.getByTestId('demo-trigger'))
    await act(async () => {
      fireEvent.click(screen.getByText('停止全部并切换'))
    })
    await waitFor(() =>
      expect(screen.getByTestId('space-switch-dialog').textContent).toContain('未能加载 我的空间'),
    )
    const dialog = screen.getByTestId('space-switch-dialog')
    expect(dialog.textContent).toContain('重试加载')

    await act(async () => {
      fireEvent.click(screen.getByText('留在', { selector: 'button' }))
    })
    expect(screen.queryByTestId('space-switch-dialog')).toBeNull()
  })

  it('access-lost shows the revoked-space explanation (C-R05)', async () => {
    renderFlow({
      getRunningActivities: () => [],
      loadTargetSpace: async () => ({ ok: false, cause: 'access-lost' }),
    })
    fireEvent.click(screen.getByTestId('demo-trigger'))
    await waitFor(() =>
      expect(screen.getByTestId('space-switch-dialog').textContent).toContain('无法切换到 我的空间'),
    )
    const dialog = screen.getByTestId('space-switch-dialog')
    expect(dialog.textContent).toContain('你的成员资格已被移除')
    expect(dialog.textContent).toContain('联系企业管理员重新邀请')

    await act(async () => {
      fireEvent.click(screen.getByText('知道了'))
    })
    expect(screen.queryByTestId('space-switch-dialog')).toBeNull()
  })

  it('successful switch reaches target loading and closes on done', async () => {
    let releaseLoad: (value: { ok: true }) => void = () => {}
    const gate = new Promise<{ ok: true }>((settle) => { releaseLoad = settle })
    renderFlow({
      getRunningActivities: () => [],
      loadTargetSpace: () => gate,
      commitSwitch: () => {},
    })
    fireEvent.click(screen.getByTestId('demo-trigger'))
    // P-M02-TARGET-LOADING — direct switch, no stop ledger.
    await waitFor(() =>
      expect(screen.getByTestId('space-switch-dialog').textContent).toContain('正在切换到 我的空间'),
    )
    expect(screen.getByTestId('space-switch-dialog').textContent).toContain('正在加载目录、权限与助手')

    await act(async () => { releaseLoad({ ok: true }) })
    await waitFor(() => expect(screen.queryByTestId('space-switch-dialog')).toBeNull())
  })
})
