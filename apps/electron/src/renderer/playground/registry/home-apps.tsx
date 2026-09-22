import { useCallback, useState } from 'react'
import type { ComponentEntry } from './types'
import { useTranslation } from 'react-i18next'
import * as Icons from 'lucide-react'
import { Button } from '@/components/ui/button'
import { StatusPill } from '@/components/hifi'
import { TabBar } from '@/components/tab-browser/TabBar'
import {
  AppRuntimeTasksProvider,
  type RuntimeTask,
} from '@/components/tab-browser/AppRuntimeTasksContext'
import { AppIcon } from '@/components/tab-browser/AppIcon'
import { OrganizationAppCard } from '@/components/tab-browser/OrganizationAppCard'
import {
  AllAppsPage,
  dedupeCircleSourcedApps,
  type CircleSourcedApp,
  type CircleDirectoryEntry,
  type OrganizationDirectoryEntry,
} from '@/components/tab-browser/AllAppsPage'
import { AppInspector } from '@/components/tab-browser/AppInspector'
import { ManageHomeApps, type ManageHomeAppItem } from '@/components/tab-browser/ManageHomeApps'
import { HiddenApps } from '@/components/tab-browser/HiddenApps'
import {
  DirectoryLoadFailedState,
  EmptyDirectoryState,
  OfflineDirectoryState,
  ZeroFrequentState,
} from '@/components/tab-browser/HomeStates'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'
import {
  DemoFixedContainer,
  MockOrganizationProvider,
  MockTabShellProvider,
  makeOrganizationSummary,
} from '../mocks'
import {
  POLO_APP_DEFINITION,
  POLO_APP_ID,
} from '../../../shared/tab-browser-types'

// =============================================================================
// WS-HOME-APPS Playground（POO-70 M03 首页与目录）
// 一个 entry + scenario 选择：首页四态 / 目录去重 / inspector / 管理常用 / 隐藏。
// 复用真实组件 + 静态 mock 数据（不依赖 electronAPI）。
// =============================================================================

const CIRCLE_APPS: CircleSourcedApp[] = [
  {
    appId: 'minutes',
    name: '会议纪要整理',
    sources: [
      { circleId: 'growth', circleName: '晨星增长圈', creator: '小王', valid: true },
      { circleId: 'design', circleName: '晨星设计圈', creator: '阿琳', valid: true },
    ],
  },
  {
    // 同一作品的第二个来源（D-PC-09：按 appId 去重后并列展示）
    appId: 'minutes',
    name: '会议纪要整理',
    sources: [
      { circleId: 'design', circleName: '晨星设计圈', creator: '阿琳', valid: true },
    ],
  },
  {
    appId: 'growth-playbook',
    name: '增长打法手册',
    sources: [
      { circleId: 'growth', circleName: '晨星增长圈', creator: '小王', valid: true },
    ],
  },
  {
    appId: 'brand-tone',
    name: '品牌语气分析',
    iconUrl: 'https://example.com/brand.png',
    sources: [
      { circleId: 'design', circleName: '晨星设计圈', creator: '阿琳', valid: false },
    ],
  },
]

const DEDUPED_CIRCLE_ENTRIES: CircleDirectoryEntry[] = dedupeCircleSourcedApps(
  CIRCLE_APPS,
).map(entry => ({ ...entry, pinned: entry.appId === 'growth-playbook' }))

function orgApp(overrides: Partial<CatalogApp>): CatalogApp {
  return {
    id: 'quote',
    organizationId: 'org-morningstar',
    name: '报价整理',
    description: '整理并导出客户报价',
    deliveryMode: 'local_bundle',
    currentRelease: {
      version: '1.4.0',
      runtime: 'static',
      downloadUrl: 'https://example.com/quote.zip',
      checksum: 'a'.repeat(64),
      sizeBytes: 24_000_000,
    },
    sortOrder: 0,
    availability: 'available',
    ...overrides,
  }
}

const RUNNING_STATUS: LocalAppRuntimeStatus = {
  appId: 'quote',
  status: 'running',
  currentVersion: '1.4.0',
  runningVersion: '1.4.0',
}

const STOPPED_STATUS: LocalAppRuntimeStatus = {
  appId: 'report',
  status: 'stopped',
  currentVersion: '2.1.0',
}

const ORG_RUNNING = orgApp({})
const ORG_STOPPED = orgApp({
  id: 'report',
  name: '数据报表生成器',
  sortOrder: 1,
})
const ORG_WITHDRAWN = orgApp({
  id: 'contract',
  name: '合同审查',
  sortOrder: 2,
  availability: 'withdrawn',
})

function directoryEntry(
  app: CatalogApp,
  status: LocalAppRuntimeStatus | undefined,
  pinned: boolean,
  offline = false,
): OrganizationDirectoryEntry {
  return {
    id: `scope-${app.id}`,
    app,
    status,
    statusLoading: false,
    statusUnavailable: false,
    compatible: true,
    offline,
    pinned,
  }
}

const ORG_DIRECTORY_ENTRIES: OrganizationDirectoryEntry[] = [
  directoryEntry(ORG_RUNNING, RUNNING_STATUS, true),
  directoryEntry(ORG_STOPPED, STOPPED_STATUS, false),
]

// =============================================================================
// P-M03-HOME-ENT-AFTER-CANCEL / -AFTER-CLOSE：切换取消 / 标签关闭后的
// 企业首页落态。账目式 mock：顶栏运行 pill 计数与卡片状态一致
// （AFTER-CANCEL：2 App 已终止可重开、1 助手项停止失败仍在运行；
//   AFTER-CLOSE：报价整理已关闭，助手项 + 合同审查后台运行）。
// =============================================================================

const ENTERPRISE_SPACE_SUMMARY = makeOrganizationSummary({
  id: 'space-morningstar',
  name: '晨星科技',
  purpose: '晨星科技 demo purpose',
  type: 'enterprise_workspace',
  membership: { role: 'member', status: 'active' },
  memberCount: 6,
})

function entRuntimeTask(overrides: Partial<RuntimeTask>): RuntimeTask {
  return {
    id: 'task-q2-summary',
    appId: POLO_APP_ID,
    tabId: undefined,
    spaceId: 'space-morningstar',
    spaceName: '晨星科技',
    kind: 'assistant',
    title: 'Q2 报价汇总',
    appName: 'Polo 助手',
    startedAt: Date.now(),
    state: 'running',
    ...overrides,
  }
}

const AFTER_CANCEL_TASKS: RuntimeTask[] = [
  entRuntimeTask({}),
]

const AFTER_CLOSE_TASKS: RuntimeTask[] = [
  entRuntimeTask({}),
  entRuntimeTask({
    id: 'task-contract',
    appId: 'app-contract',
    kind: 'app',
    title: '合同后台核对',
    appName: '合同审查',
  }),
]

const ENT_QUOTE = orgApp({})
const ENT_CONTRACT = orgApp({
  id: 'contract',
  name: '合同审查',
  sortOrder: 1,
})

const ENT_QUOTE_STOPPED: LocalAppRuntimeStatus = {
  appId: 'quote',
  status: 'stopped',
  currentVersion: '1.4.0',
}
const ENT_CONTRACT_STOPPED: LocalAppRuntimeStatus = {
  appId: 'contract',
  status: 'stopped',
  currentVersion: '2.1.0',
}
const ENT_CONTRACT_RUNNING: LocalAppRuntimeStatus = {
  appId: 'contract',
  status: 'running',
  currentVersion: '2.1.0',
  runningVersion: '2.1.0',
}

function DemoPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-background p-6 text-foreground">
      {children}
    </div>
  )
}

function OrgCardGrid({ offline = false }: { offline?: boolean }) {
  const cards: Array<[CatalogApp, LocalAppRuntimeStatus | undefined]> = [
    [ORG_RUNNING, RUNNING_STATUS],
    [ORG_STOPPED, STOPPED_STATUS],
  ]
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {cards.map(([app, status]) => (
        <OrganizationAppCard
          key={app.id}
          app={app}
          status={status}
          statusLoading={false}
          statusUnavailable={false}
          compatible
          offline={offline}
          onPrimaryAction={() => {}}
          onStop={() => {}}
          onUninstall={() => {}}
          onViewLogs={() => {}}
        />
      ))}
    </div>
  )
}

function FrequentHeader({ showManage = true }: { showManage?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h1 className="text-lg font-semibold">{t('homeApps.frequent.title')}</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          {t('homeApps.frequent.description')}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {showManage && (
          <Button type="button" variant="ghost" size="sm">
            {t('homeApps.frequent.manage')}
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm">
          {t('homeApps.allApps.title')}
        </Button>
      </div>
    </div>
  )
}

/** 我的圈子入口示例：ws-circles-account 通过 HomeSurfaceSlots 挂载的真实形态参考。 */
function CirclesEntrySlot() {
  return (
    <div
      data-testid="home-circles-slot"
      className="flex items-center justify-between rounded-xl border border-foreground/10 bg-foreground/2 px-4 py-3"
    >
      <div>
        <p className="text-sm font-medium">我的圈子</p>
        <p className="mt-0.5 text-xs text-muted-foreground">3 个圈子 · 有新版本的应用会在这里提醒</p>
      </div>
      <Button type="button" variant="ghost" size="sm">进入</Button>
    </div>
  )
}

const PINNED_APPS = ['minutes', 'growth-playbook', 'brand-tone']

/** 企业首页落态完整壳 demo（P-M03-HOME-ENT-AFTER-*）：顶栏运行 pill、
 * 运行状态中心与首页卡片账目一致；助手入口照常可打开（D-PC-08）。 */
function HomeEntAfterDemo({
  variant,
}: {
  variant: 'P-M03-HOME-ENT-AFTER-CANCEL' | 'P-M03-HOME-ENT-AFTER-CLOSE'
}) {
  const { t } = useTranslation()
  const cancel = variant === 'P-M03-HOME-ENT-AFTER-CANCEL'
  const [tasks, setTasks] = useState<RuntimeTask[]>(
    () => (cancel ? AFTER_CANCEL_TASKS : AFTER_CLOSE_TASKS),
  )
  // 取消切换落态：助手项的停止会失败一次（「停止失败 · 仍在运行」）。
  const [assistantStopFailedOnce, setAssistantStopFailedOnce] = useState(false)

  const stopTask = useCallback(async (taskId: string) => {
    await new Promise(resolve => setTimeout(resolve, 200))
    if (cancel && taskId === 'task-q2-summary' && !assistantStopFailedOnce) {
      setAssistantStopFailedOnce(true)
      throw new Error('STOP_FAILED')
    }
    setTasks(list => list.filter(task => task.id !== taskId))
  }, [assistantStopFailedOnce, cancel])

  const contractStatus = cancel ? ENT_CONTRACT_STOPPED : ENT_CONTRACT_RUNNING

  return (
    <MockOrganizationProvider
      organizations={[ENTERPRISE_SPACE_SUMMARY]}
      activeId={ENTERPRISE_SPACE_SUMMARY.id}
    >
      <AppRuntimeTasksProvider
        tasks={tasks}
        onStopTask={async task => stopTask(task.id)}
        initialCenterOpen={false}
      >
        <MockTabShellProvider tabs={[]}>
          <DemoFixedContainer height={430}>
            <TabBar account={{ user: { username: 'wang', displayName: '小王' }, onLogout: () => {} }} />
            <div
              className="overflow-y-auto bg-foreground/2 p-6"
              style={{ height: 390, marginTop: 'var(--tabbar-height)' }}
            >
              <section data-testid="home-assistant-entry" className="mb-6">
                <div className="flex items-center gap-4 rounded-xl border border-foreground/10 bg-background p-4">
                  <span className="grid size-11 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
                    <Icons.Sparkles className="size-5" strokeWidth={1.5} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h1 className="text-base font-semibold">
                      {POLO_APP_DEFINITION.name}
                    </h1>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t('homeApps.assistant.entrySubtitle')}
                    </p>
                    <p className="mt-1 flex items-center gap-2 text-sm text-foreground/80">
                      <StatusPill tone="info">
                        {t('homeApps.status.running')}
                      </StatusPill>
                      {cancel ? '停止失败 · 仍在运行' : '正在生成回答 · Q2 报价汇总'}
                    </p>
                  </div>
                  <Button type="button" size="sm">
                    {t('homeApps.assistant.openAction')}
                  </Button>
                </div>
              </section>
              <section>
                <h2 className="mb-3 text-base font-semibold">晨星科技的应用</h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <OrganizationAppCard
                    app={ENT_QUOTE}
                    status={ENT_QUOTE_STOPPED}
                    statusLoading={false}
                    statusUnavailable={false}
                    compatible
                    offline={false}
                    onPrimaryAction={() => {}}
                    onStop={() => {}}
                    onUninstall={() => {}}
                    onViewLogs={() => {}}
                  />
                  <OrganizationAppCard
                    app={ENT_CONTRACT}
                    status={contractStatus}
                    statusLoading={false}
                    statusUnavailable={false}
                    compatible
                    offline={false}
                    onPrimaryAction={() => {}}
                    onStop={() => {}}
                    onUninstall={() => {}}
                    onViewLogs={() => {}}
                  />
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  顶栏「{t('appContainer.runtime.pill', { count: tasks.length })}」与卡片账目一致；
                  点击运行 pill 打开运行状态中心
                  {cancel ? '；助手项的停止会失败一次（停止失败 · 仍在运行）' : ''}。
                </p>
              </section>
            </div>
          </DemoFixedContainer>
        </MockTabShellProvider>
      </AppRuntimeTasksProvider>
    </MockOrganizationProvider>
  )
}

interface HomeAppsDemoProps {
  scenario: string
}

function HomeAppsDemo({ scenario }: HomeAppsDemoProps) {
  const { t } = useTranslation()
  const [pinnedIds, setPinnedIds] = useState<ReadonlySet<string>>(
    () => new Set(PINNED_APPS),
  )
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(() => new Set())
  const togglePinned = (id: string) => {
    setPinnedIds(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else if (next.size < 5) next.add(id)
      return next
    })
  }
  const hide = (id: string) => {
    setHiddenIds(current => new Set(current).add(id))
  }

  const circleEntries = DEDUPED_CIRCLE_ENTRIES
    .filter(entry => !hiddenIds.has(entry.appId))
    .map(entry => ({ ...entry, pinned: pinnedIds.has(entry.appId) }))
  const orgEntries = ORG_DIRECTORY_ENTRIES
    .filter(entry => !hiddenIds.has(entry.id))
    .map(entry => ({ ...entry, pinned: pinnedIds.has(entry.id) }))

  const directoryProps = {
    onBack: () => {},
    onViewHidden: () => {},
    hiddenCount: hiddenIds.size,
    onTogglePinned: (target: { id: string }) => togglePinned(target.id),
    onHide: (target: { id: string }) => hide(target.id),
    onOrganizationPrimaryAction: () => {},
    onOrganizationStop: () => {},
    onOrganizationUninstall: () => {},
    onOrganizationViewLogs: () => {},
  }

  switch (scenario) {
    case 'P-M03-HOME-ZERO':
      return (
        <DemoPage>
          <section>
            <FrequentHeader />
            <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-6">
              <div data-testid="home-assistant-card">
                <AppIcon app={POLO_APP_DEFINITION} onOpen={() => {}} />
              </div>
            </div>
            <ZeroFrequentState
              title={t('homeApps.frequent.zeroTitle')}
              description={t('homeApps.frequent.zeroDescription')}
              actionLabel={t('homeApps.frequent.zeroAction')}
              onAction={() => {}}
            />
          </section>
        </DemoPage>
      )
    case 'P-M03-HOME-EMPTY-DIR':
      return (
        <DemoPage>
          <section className="mb-8">
            <FrequentHeader />
            <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-6">
              <div data-testid="home-assistant-card">
                <AppIcon app={POLO_APP_DEFINITION} onOpen={() => {}} />
              </div>
            </div>
          </section>
          <CirclesEntrySlot />
          <section className="mt-8">
            <h2 className="mb-3 text-base font-semibold">晨星科技的应用</h2>
            <EmptyDirectoryState
              title={t('homeApps.organization.empty')}
              description={t('homeApps.organization.emptyEnterprise')}
            />
          </section>
        </DemoPage>
      )
    case 'P-M03-HOME-LOAD-FAIL':
      return (
        <DemoPage>
          <section className="mb-8">
            <FrequentHeader />
            <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-6">
              <div data-testid="home-assistant-card">
                <AppIcon app={POLO_APP_DEFINITION} onOpen={() => {}} />
              </div>
            </div>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold">晨星科技的应用</h2>
            <DirectoryLoadFailedState
              title={t('homeApps.organization.loadFailed')}
              description={t('homeApps.organization.networkError')}
              retryLabel={t('homeApps.actions.tryAgain')}
              onRetry={() => {}}
            />
          </section>
        </DemoPage>
      )
    case 'P-M03-HOME-OFFLINE':
      return (
        <DemoPage>
          <section className="mb-8">
            <FrequentHeader />
            <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-6">
              <div data-testid="home-assistant-card">
                <AppIcon app={POLO_APP_DEFINITION} onOpen={() => {}} />
              </div>
            </div>
          </section>
          <section>
            <h2 className="mb-3 text-base font-semibold">晨星科技的应用</h2>
            <div className="mb-4">
              <OfflineDirectoryState
                description={t('homeApps.organization.offlineWarning')}
                fetchedAtLine={t('homeApps.offline.syncedAt', {
                  time: '10:32',
                })}
              />
            </div>
            <OrgCardGrid offline />
          </section>
        </DemoPage>
      )
    case 'P-M03-ALL-APPS':
    case 'P-M03-ALL-APPS-ZERO':
      return (
        <DemoPage>
          <AllAppsPage
            {...directoryProps}
            organizationEntries={
              scenario === 'P-M03-ALL-APPS' ? orgEntries : []
            }
            circleEntries={circleEntries}
            onInspectOrganization={() => {}}
            onInspectCircle={() => {}}
          />
        </DemoPage>
      )
    case 'P-M03-ALL-APPS-ENT-EMPTY':
      return (
        <DemoPage>
          <AllAppsPage
            {...directoryProps}
            organizationEntries={[]}
            circleEntries={[]}
            onInspectOrganization={() => {}}
            onInspectCircle={() => {}}
            emptyState={(
              <EmptyDirectoryState
                title={t('homeApps.allApps.emptyTitle')}
                description={t('homeApps.allApps.emptyEnterpriseDescription')}
              />
            )}
          />
        </DemoPage>
      )
    case 'P-M03-ALL-APPS-LOADING':
      return (
        <DemoPage>
          <AllAppsPage
            {...directoryProps}
            loading
            organizationEntries={[]}
            circleEntries={[]}
            onInspectOrganization={() => {}}
            onInspectCircle={() => {}}
          />
        </DemoPage>
      )
    case 'P-M03-INSPECTOR':
      return (
        <DemoPage>
          <AppInspector
            target={{
              name: '会议纪要整理',
              sources: [
                { label: '晨星增长圈', detail: '小王', valid: true },
                { label: '晨星设计圈', detail: '阿琳', valid: true },
              ],
              version: 'v1.3.2',
              statusLabel: t('homeApps.inspector.statusAvailable'),
              statusTone: 'success',
              permissions: ['读取所选文件', '写入导出目录'],
            }}
            onBack={() => {}}
            onOpen={() => {}}
            onViewRuntime={() => {}}
          />
        </DemoPage>
      )
    case 'P-M03-INSPECTOR-BLOCKED':
      return (
        <DemoPage>
          <AppInspector
            target={{
              name: '品牌语气分析',
              sources: [
                { label: '晨星设计圈', detail: '阿琳', valid: false },
              ],
              version: 'v1.4.0',
              statusLabel: t('homeApps.allApps.blocked'),
              statusTone: 'destructive',
              blockedPath: t('homeApps.inspector.blockedPath'),
              permissions: ['读取所选文件'],
            }}
            onBack={() => {}}
          />
        </DemoPage>
      )
    case 'P-M03-MANAGE-HOME': {
      const pinned: ManageHomeAppItem[] = [
        { id: 'minutes', name: '会议纪要整理', kind: 'circle' },
        { id: 'growth-playbook', name: '增长打法手册', kind: 'circle' },
        { id: 'scope-quote', name: '报价整理', kind: 'organization' },
        { id: 'scope-report', name: '数据报表生成器', kind: 'organization' },
        { id: 'brand-tone', name: '品牌语气分析', kind: 'circle' },
      ]
      return (
        <DemoPage>
          <ManageHomeApps
            pinned={pinned}
            candidates={[
              { id: 'contract', name: '合同审查', kind: 'organization' },
            ]}
            onRemove={() => {}}
            onAdd={() => {}}
            onViewHidden={() => {}}
            onBack={() => {}}
          />
        </DemoPage>
      )
    }
    case 'P-M03-CONTROLS':
      return (
        <DemoPage>
          <HiddenApps
            hidden={[
              { id: 'brand-tone', name: '品牌语气分析', sourceLabel: '晨星设计圈' },
              { id: 'contract', name: '合同审查', sourceLabel: '晨星科技' },
            ]}
            onRestore={() => {}}
            onBack={() => {}}
          />
        </DemoPage>
      )
    case 'P-M03-HOME-ENT-AFTER-CANCEL':
    case 'P-M03-HOME-ENT-AFTER-CLOSE':
      return <HomeEntAfterDemo variant={scenario as 'P-M03-HOME-ENT-AFTER-CANCEL' | 'P-M03-HOME-ENT-AFTER-CLOSE'} />
    case 'P-M03-HOME-PERSONAL':
    default:
      return (
        <DemoPage>
          <section>
            <FrequentHeader />
            <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-6">
              <div data-testid="home-assistant-card">
                <AppIcon app={POLO_APP_DEFINITION} onOpen={() => {}} />
              </div>
              {DEDUPED_CIRCLE_ENTRIES
                .filter(entry => PINNED_APPS.includes(entry.appId) && !entry.blocked)
                .map(entry => (
                  <AppIcon
                    key={entry.appId}
                    app={{
                      id: entry.appId,
                      name: entry.name,
                      url: 'https://example.com',
                      iconUrl: entry.iconUrl,
                      type: 'webapp',
                      createdAt: 0,
                      order: 0,
                    }}
                    onOpen={() => {}}
                  />
                ))}
            </div>
          </section>
          <div className="mt-8">
            <CirclesEntrySlot />
          </div>
          <section className="mt-8">
            <h2 className="mb-3 text-base font-semibold">晨星科技的应用</h2>
            <OrgCardGrid />
          </section>
        </DemoPage>
      )
  }
}

const SCENARIOS = [
  'P-M03-HOME-PERSONAL',
  'P-M03-HOME-ZERO',
  'P-M03-HOME-EMPTY-DIR',
  'P-M03-HOME-LOAD-FAIL',
  'P-M03-HOME-OFFLINE',
  'P-M03-HOME-ENT-AFTER-CANCEL',
  'P-M03-HOME-ENT-AFTER-CLOSE',
  'P-M03-ALL-APPS',
  'P-M03-ALL-APPS-ZERO',
  'P-M03-ALL-APPS-ENT-EMPTY',
  'P-M03-ALL-APPS-LOADING',
  'P-M03-INSPECTOR',
  'P-M03-INSPECTOR-BLOCKED',
  'P-M03-MANAGE-HOME',
  'P-M03-CONTROLS',
]

export const homeAppsComponents: ComponentEntry[] = [
  {
    id: 'ws-home-apps',
    name: 'Home Apps Surface',
    category: 'Browser',
    description:
      'POO-70 M03 首页与目录：固定助手卡 + ≤5 常用、我的圈子/全部应用入口、首页四态（零常用/真空目录/加载失败/离线缓存）、企业首页落态（取消切换/关闭标签后顶栏与卡片账目一致）、目录去重（D-PC-09 多圈子来源并列、全失效 blocked）、inspector、管理常用（上限5）、个人隐藏/恢复',
    component: HomeAppsDemo,
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
        defaultValue: 'P-M03-HOME-PERSONAL',
      },
    ],
    variants: SCENARIOS.map(name => ({
      name,
      description: name,
      props: { scenario: name },
    })),
  },
]
