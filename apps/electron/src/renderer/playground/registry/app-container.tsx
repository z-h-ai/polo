import { useCallback, useState } from 'react'
import type { ComponentEntry } from './types'
import * as Icons from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TabBar } from '@/components/tab-browser/TabBar'
import { AppCloseDialog } from '@/components/tab-browser/AppCloseDialog'
import { TermFailedToast } from '@/components/tab-browser/TermFailedToast'
import { PermissionGate } from '@/components/tab-browser/PermissionGate'
import { RuntimeCenter } from '@/components/tab-browser/RuntimeCenter'
import {
  AppRuntimeTasksProvider,
  type RuntimeTask,
} from '@/components/tab-browser/AppRuntimeTasksContext'
import {
  AppNotificationsProvider,
  type AppNotification,
} from '@/components/tab-browser/AppNotificationsContext'
import { useTranslation } from 'react-i18next'
import {
  DemoFixedContainer,
  MockOrganizationProvider,
  MockTabShellProvider,
  makeOrganizationSummary,
} from '../mocks'
import {
  POLO_TAB_ID,
  POLO_APP_ID,
  type TabInstance,
} from '../../../shared/tab-browser-types'

// =============================================================================
// WS-HOME-APPS Playground（POO-70 M04 App 容器）
// 准备/权限被拒/关闭三选项/终止失败/后台 pill/运行状态中心。
// =============================================================================

const QUOTE_TAB: TabInstance = {
  id: 'tab-quote',
  appId: 'app-quote',
  type: 'webapp',
  title: '报价整理',
  url: 'https://quote.example.com',
}

const DEMO_TABS: TabInstance[] = [
  { id: POLO_TAB_ID, appId: POLO_APP_ID, type: 'polo', title: 'Polo 助手' },
  QUOTE_TAB,
]

function runningTask(overrides: Partial<RuntimeTask>): RuntimeTask {
  return {
    id: 'task-quote',
    appId: 'app-quote',
    tabId: 'tab-quote',
    spaceId: 'space-morningstar',
    spaceName: '晨星科技',
    kind: 'app',
    title: '整理 10 月报价',
    appName: '报价整理',
    startedAt: Date.now(),
    state: 'running',
    ...overrides,
  }
}

const RUNTIME_TASKS: RuntimeTask[] = [
  runningTask({}),
  runningTask({
    id: 'task-report',
    appId: 'app-report',
    tabId: 'tab-report',
    title: '生成月度报表',
    appName: '数据报表生成器',
  }),
  runningTask({
    id: 'task-summary',
    appId: POLO_APP_ID,
    tabId: undefined,
    spaceId: 'space-personal',
    spaceName: '我的空间',
    kind: 'assistant',
    title: '总结晨星会议录音',
    appName: 'Polo 助手',
  }),
]

const PERSONAL_RUNTIME_TASKS: RuntimeTask[] = [
  runningTask({
    id: 'task-report',
    appId: 'app-report',
    tabId: 'tab-report',
    spaceId: 'space-personal',
    spaceName: '我的空间',
    title: '生成月度报表',
    appName: '数据报表生成器',
  }),
  runningTask({
    id: 'task-summary',
    appId: POLO_APP_ID,
    tabId: undefined,
    spaceId: 'space-personal',
    spaceName: '我的空间',
    kind: 'assistant',
    title: '总结晨星会议录音',
    appName: 'Polo 助手',
  }),
]

const PERSONAL_SPACE = makeOrganizationSummary({
  id: 'space-personal',
  name: '我的空间',
  purpose: '我的空间 demo purpose',
  type: 'creator_space',
  membership: { role: 'owner', status: 'active' },
  memberCount: 1,
})

const ENTERPRISE_SPACE = makeOrganizationSummary({
  id: 'space-morningstar',
  name: '晨星科技',
  purpose: '晨星科技 demo purpose',
  type: 'enterprise_workspace',
  membership: { role: 'member', status: 'active' },
  memberCount: 6,
})

function DemoPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background p-6 text-foreground">
      {children}
    </div>
  )
}

/** 关闭三选项交互 demo：终止失败可注入（首任务失败一次）。 */
function CloseDialogDemo({ injectFailure }: { injectFailure: boolean }) {
  const [open, setOpen] = useState(true)
  const [failedOnce, setFailedOnce] = useState(false)
  const [showToast, setShowToast] = useState(false)

  const stopTasks = async (tasks: RuntimeTask[]): Promise<RuntimeTask[]> => {
    if (injectFailure && !failedOnce) {
      setFailedOnce(true)
      return [RUNTIME_TASKS[0]!]
    }
    return []
  }

  return (
    <DemoPage>
      <p className="mb-3 text-xs text-muted-foreground">
        {injectFailure
          ? '停止并关闭 → 首个任务停止失败：标签保留、只重试失败项'
          : '取消 / 后台继续 / 停止并关闭（全部停止成功后关闭标签）'}
      </p>
      {showToast && (
        <div className="mb-4">
          <TermFailedToast
            appName="报价整理"
            failedCount={1}
            onRetry={() => { void 0 }}
            onBack={() => setShowToast(false)}
          />
        </div>
      )}
      <Button type="button" variant="secondary" size="sm" onClick={() => {
        setOpen(true)
        setFailedOnce(false)
      }}>
        重新打开关闭对话框
      </Button>
      <AppCloseDialog
        open={open}
        appName={QUOTE_TAB.title}
        tasks={RUNTIME_TASKS.slice(0, 2)}
        onCancel={() => {
          setOpen(false)
          if (injectFailure) setShowToast(true)
        }}
        onBackgroundContinue={() => setOpen(false)}
        onStopTasks={stopTasks}
        onTerminateSucceeded={() => setOpen(false)}
      />
    </DemoPage>
  )
}

function PermissionGateDemo({ phase }: { phase: 'prepare' | 'failed' | 'os-denied' }) {
  const [open, setOpen] = useState(true)
  return (
    <DemoPage>
      <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
        重新打开权限对话框
      </Button>
      <PermissionGate
        open={open}
        phase={phase}
        appName="合同审查"
        requestedPermissions={['读取所选文件 · Q3-采购合同.pdf', '访问剪贴板']}
        version="v2.1.0"
        progressPercent={phase === 'prepare' ? 68 : undefined}
        onDeny={() => setOpen(false)}
        onAllow={() => setOpen(false)}
        onRetryReload={() => setOpen(false)}
        onUseCurrentVersion={() => setOpen(false)}
        onOpenSystemSettings={() => {}}
        onRetryRequest={() => setOpen(false)}
        onLater={() => setOpen(false)}
      />
    </DemoPage>
  )
}

/** 运行中心 demo：逐项停止 + 失败注入（第一个任务的停止总是失败）。 */
function RuntimeCenterDemo({ tasks }: { tasks: RuntimeTask[] }) {
  const [current, setCurrent] = useState<RuntimeTask[]>(tasks)
  const stopTask = useCallback(async (taskId: string) => {
    await new Promise(resolve => setTimeout(resolve, 200))
    if (taskId === 'task-quote' && current.some(task => task.id === 'task-quote')) {
      throw new Error('STOP_FAILED')
    }
    setCurrent(list => list.filter(task => task.id !== taskId))
  }, [current])

  return (
    <DemoPage>
      <p className="mb-3 text-xs text-muted-foreground">
        按空间分组；「整理 10 月报价」的停止会失败一次（toast 提示后可重试成功）。
      </p>
      <RuntimeCenter
        tasks={current}
        onStopTask={stopTask}
        onOpenTask={() => {}}
      />
    </DemoPage>
  )
}

/** 顶栏运行 pill + 关闭拦截的完整壳 demo（接线点验收用）。 */
function TabBarRuntimeDemo({ personal }: { personal: boolean }) {
  const [tasks, setTasks] = useState<RuntimeTask[]>(
    personal
      ? [
          // Give the quote tab an owned task so its × actually hits the close guard.
          runningTask({ spaceId: 'space-personal', spaceName: '我的空间' }),
          ...PERSONAL_RUNTIME_TASKS,
        ]
      : RUNTIME_TASKS,
  )
  const [quoteStopFailedOnce, setQuoteStopFailedOnce] = useState(false)

  const stopTask = useCallback(async (taskId: string) => {
    await new Promise(resolve => setTimeout(resolve, 200))
    setTasks(list => {
      if (taskId === 'task-quote' && !quoteStopFailedOnce) {
        return list
      }
      return list.filter(task => task.id !== taskId)
    })
    if (taskId === 'task-quote' && !quoteStopFailedOnce) {
      setQuoteStopFailedOnce(true)
      throw new Error('STOP_FAILED')
    }
  }, [quoteStopFailedOnce])

  const organizations = personal
    ? [PERSONAL_SPACE, ENTERPRISE_SPACE]
    : [ENTERPRISE_SPACE, PERSONAL_SPACE]

  return (
    <MockOrganizationProvider
      organizations={organizations}
      activeId={personal ? PERSONAL_SPACE.id : ENTERPRISE_SPACE.id}
    >
      <AppRuntimeTasksProvider
        tasks={tasks}
        onStopTask={async task => stopTask(task.id)}
        initialCenterOpen={false}
      >
        <MockTabShellProvider tabs={DEMO_TABS} activeTabId={QUOTE_TAB.id}>
          <DemoFixedContainer height={280}>
            <TabBar account={{ user: { username: 'wang', displayName: '小王' }, onLogout: () => {} }} />
            <div
              className="flex flex-col items-center justify-center gap-2 bg-foreground/2 text-xs text-muted-foreground"
              style={{ height: 220, marginTop: 'var(--tabbar-height)' }}
            >
              <Icons.LayoutGrid className="size-5" strokeWidth={1.5} />
              <span>（应用页面占位 · 报价整理）</span>
              <span>点击标签 × 触发关闭三选项；点击运行 pill 打开运行状态中心</span>
            </div>
          </DemoFixedContainer>
        </MockTabShellProvider>
      </AppRuntimeTasksProvider>
    </MockOrganizationProvider>
  )
}

/** 通知中心完整壳 demo（P-M04-NOTIFY-ENT / -PERSONAL）：铃铛入口 + 弹层。 */
function NotificationCenterTabDemo({ personal }: { personal: boolean }) {
  const { t } = useTranslation()
  const [tasks, setTasks] = useState<RuntimeTask[]>(
    personal ? PERSONAL_RUNTIME_TASKS : RUNTIME_TASKS,
  )
  const stopTask = useCallback(async (taskId: string) => {
    await new Promise(resolve => setTimeout(resolve, 200))
    setTasks(list => list.filter(task => task.id !== taskId))
  }, [])

  const notifications: AppNotification[] = personal
    ? [
        {
          id: 'version-brand',
          kind: 'version',
          title: '晨星设计圈有新版本',
          description: '品牌语气分析 v1.4.0 · 下次使用生效',
          unread: true,
          onOpen: () => {},
        },
        {
          id: 'report-done',
          kind: 'background',
          title: '数据报表生成器已在后台完成',
          timeLabel: t('appContainer.runtime.pill', { count: 1 }),
          unread: true,
          onOpen: () => {},
        },
      ]
    : [
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
          timeLabel: `今天 10:32 · ${t('appContainer.runtime.pill', { count: 3 })}`,
          unread: true,
          onOpen: () => {},
        },
      ]

  const organizations = personal
    ? [PERSONAL_SPACE, ENTERPRISE_SPACE]
    : [ENTERPRISE_SPACE, PERSONAL_SPACE]

  // 企业变体提供弹层尾部「全部停止并切换空间」（NOTIFY-ENT transition）：
  // 这里以「清空运行任务」演示，产品内由空间切换流程接线。
  const stopAllAndSwitch = personal ? undefined : () => {
    setTasks([])
  }

  return (
    <MockOrganizationProvider
      organizations={organizations}
      activeId={personal ? PERSONAL_SPACE.id : ENTERPRISE_SPACE.id}
    >
      <AppNotificationsProvider
        notifications={notifications}
        onStopAllAndSwitchSpace={stopAllAndSwitch}
        initialCenterOpen
      >
        <AppRuntimeTasksProvider
          tasks={tasks}
          onStopTask={async task => stopTask(task.id)}
          initialCenterOpen={false}
        >
          <MockTabShellProvider tabs={DEMO_TABS} activeTabId={QUOTE_TAB.id}>
            <DemoFixedContainer height={300}>
              <TabBar account={{ user: { username: 'wang', displayName: '小王' }, onLogout: () => {} }} />
              <div
                className="flex flex-col items-center justify-center gap-2 bg-foreground/2 text-xs text-muted-foreground"
                style={{ height: 240, marginTop: 'var(--tabbar-height)' }}
              >
                <Icons.LayoutGrid className="size-5" strokeWidth={1.5} />
                <span>（{personal ? '我的空间' : '晨星科技'}首页占位）</span>
                <span>
                  点击铃铛开合通知中心；未读项带圆点；失权通知提供「查看原因」；
                  {personal ? '新版本通知进圈子详情' : '尾部可「全部停止并切换空间」'}
                </span>
              </div>
            </DemoFixedContainer>
          </MockTabShellProvider>
        </AppRuntimeTasksProvider>
      </AppNotificationsProvider>
    </MockOrganizationProvider>
  )
}

function TermFailedToastDemo() {
  const [visible, setVisible] = useState(true)
  return (
    <DemoPage>
      <p className="mb-3 text-xs text-muted-foreground">
        终止失败后标签保留态：应用视图上的常驻提示条（C-R03）。
      </p>
      {visible && (
        <TermFailedToast
          appName="报价整理"
          failedCount={1}
          onRetry={() => {}}
          onBack={() => setVisible(false)}
        />
      )}
      {!visible && (
        <Button type="button" variant="secondary" size="sm" onClick={() => setVisible(true)}>
          重新显示
        </Button>
      )}
    </DemoPage>
  )
}

interface AppContainerDemoProps {
  scenario: string
}

function AppContainerDemo({ scenario }: AppContainerDemoProps) {
  switch (scenario) {
    case 'P-M04-PREPARE':
      return <PermissionGateDemo phase="prepare" />
    case 'P-M04-PREP-FAILED':
      return <PermissionGateDemo phase="failed" />
    case 'P-M04-PERM-DENIED':
      return <PermissionGateDemo phase="os-denied" />
    case 'P-M04-TERM-FAILED':
      return <CloseDialogDemo injectFailure />
    case 'P-M04-TERM-FAILED-TOAST':
      return <TermFailedToastDemo />
    case 'P-M04-RUNTIME':
      return <RuntimeCenterDemo tasks={RUNTIME_TASKS} />
    case 'P-M04-RUNTIME-PERSONAL':
      return <RuntimeCenterDemo tasks={PERSONAL_RUNTIME_TASKS} />
    case 'P-M04-BACKGROUND-PERSONAL':
      return <TabBarRuntimeDemo personal />
    case 'P-M04-NOTIFY-ENT':
      return <NotificationCenterTabDemo personal={false} />
    case 'P-M04-NOTIFY-PERSONAL':
      return <NotificationCenterTabDemo personal />
    case 'P-M04-CLOSE-ACTIVE':
    default:
      return <CloseDialogDemo injectFailure={false} />
  }
}

const SCENARIOS = [
  'P-M04-CLOSE-ACTIVE',
  'P-M04-TERM-FAILED',
  'P-M04-TERM-FAILED-TOAST',
  'P-M04-PREPARE',
  'P-M04-PREP-FAILED',
  'P-M04-PERM-DENIED',
  'P-M04-RUNTIME',
  'P-M04-RUNTIME-PERSONAL',
  'P-M04-BACKGROUND-PERSONAL',
  'P-M04-NOTIFY-ENT',
  'P-M04-NOTIFY-PERSONAL',
]

export const appContainerComponents: ComponentEntry[] = [
  {
    id: 'ws-app-container',
    name: 'App Container Runtime',
    category: 'Browser',
    description:
      'POO-70 M04 应用容器：关闭三选项（取消/后台继续/停止并关闭，D-PC-07）、终止失败标签保留（C-R03）、准备/权限确认/加载失败（C-R02）、OS 权限被拒走系统设置（C-R06）、运行状态中心（按空间列 App 任务 + 助手生成、逐项停止，C-R03）、顶栏运行 pill + 关闭拦截完整壳、通知中心（铃铛 + 失权「查看原因」+ 后台完成进运行中心）',
    component: AppContainerDemo,
    layout: 'top',
    previewOverflow: 'visible',
    props: [
      {
        name: 'scenario',
        description: '场景（变体名含 scene ID 便于截图命名）',
        control: {
          type: 'select',
          options: SCENARIOS.map(value => ({ label: value, value })),
        },
        defaultValue: 'P-M04-CLOSE-ACTIVE',
      },
    ],
    variants: SCENARIOS.map(name => ({
      name,
      description: name,
      props: { scenario: name },
    })),
  },
]
