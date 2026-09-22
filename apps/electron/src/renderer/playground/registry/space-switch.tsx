import * as React from 'react'
import type { ComponentEntry } from './types'
import { TabBar } from '@/components/tab-browser/TabBar'
import { SpaceSwitchFlow } from '@/components/organization/SpaceSwitchFlow'
import {
  SpaceSwitchFlowProvider,
  useSpaceSwitchFlow,
  type RunningActivity,
  type SpaceSwitchFlowDeps,
  type SpaceSwitchTarget,
  type TargetLoadOutcome,
} from '@/components/organization/useSpaceSwitchFlow'
import {
  DemoFixedContainer,
  MockOrganizationProvider,
  MockTabShellProvider,
  makeOrganizationSummary,
} from '../mocks'
import { HOME_TAB, type TabInstance } from '../../../shared/tab-browser-types'

// =============================================================================
// Space Switch Flow Playground (prototype M02, WS-SPACE)
// The real space-switch transaction (confirm → stop → load → commit) over the
// product shell, driven by scripted deps so each scene freezes at a reviewable
// state. The space list state itself (P-M02-SWITCHER) lives in the
// tab-browser-shell demo's open-account-menu variant; here the requestSwitch
// entry is self-wired through SpaceSwitchFlowProvider + useSpaceSwitchFlow.
// =============================================================================

const ENTERPRISE_SPACE = makeOrganizationSummary({
  id: 'org-enterprise',
  name: '晨星科技',
  purpose: '晨星科技 demo purpose',
  type: 'enterprise_workspace',
  membership: { role: 'member', status: 'active' },
  memberCount: 6,
})

const PERSONAL_SPACE = makeOrganizationSummary({
  id: 'org-personal',
  name: '我的空间',
  purpose: '我的空间 demo purpose',
  type: 'creator_space',
  membership: { role: 'owner', status: 'active' },
  memberCount: 1,
})

const REVOKED_SPACE = makeOrganizationSummary({
  id: 'org-revoked',
  name: '北方贸易',
  purpose: '北方贸易 demo purpose',
  type: 'enterprise_workspace',
  status: 'suspended',
  membership: { role: 'member', status: 'removed' },
  memberCount: 8,
})

/** 晨星科技 running ledger — App ×2 + assistant generation ×1 (spec demo data). */
const ENTERPRISE_ACTIVITIES: RunningActivity[] = [
  {
    id: 'ent-report',
    kind: 'app',
    name: '数据报表生成器',
    detail: '同空间后台运行',
  },
  {
    id: 'ent-crm',
    kind: 'app',
    name: '客户资料面板',
    detail: '运行中 · 前台',
  },
  {
    id: 'ent-weekly',
    kind: 'assistant',
    name: '销售周报',
    detail: '正在生成回答',
  },
]

/** 个人方向 running ledger — 1 item (spec demo data). */
const PERSONAL_ACTIVITIES: RunningActivity[] = [
  {
    id: 'personal-report',
    kind: 'app',
    name: '数据报表生成器',
    detail: '同空间后台运行',
  },
]

const DEMO_TABS: TabInstance[] = [HOME_TAB]

const NEVER = new Promise<never>(() => {})

/** Demo trajectories; the second item fails where the spec injects a failure. */
const SCRIPT_OPTIONS = [
  'confirm-ent',
  'confirm-personal',
  'stopping',
  'stop-failed',
  'stop-cancel',
  'target-loading',
  'target-failed',
  'access-lost',
] as const

type DemoScript = (typeof SCRIPT_OPTIONS)[number]

const SCRIPT_LABELS: Record<DemoScript, string> = {
  'confirm-ent': 'P-M02-CONFIRM · 确认（企业→个人，3 项）',
  'confirm-personal': 'P-M02-CONFIRM-PERSONAL · 确认（个人→企业，1 项）',
  stopping: 'P-M02-STOPPING · 停止中（逐项停止）',
  'stop-failed': 'P-M02-STOP-FAILED · 部分失败（第 2 项失败）',
  'stop-cancel': 'P-M02-STOP-CANCEL · 取消后落态（已停止 2/3）',
  'target-loading': 'P-M02-TARGET-LOADING · 目标加载中',
  'target-failed': 'P-M02-TARGET-FAILED · 目标加载失败',
  'access-lost': 'P-M02-ACCESS-LOST · 失权说明（北方贸易）',
}

const TARGETS: Record<DemoScript, SpaceSwitchTarget> = {
  'confirm-ent': { id: PERSONAL_SPACE.id, name: PERSONAL_SPACE.name },
  'confirm-personal': { id: ENTERPRISE_SPACE.id, name: ENTERPRISE_SPACE.name },
  stopping: { id: PERSONAL_SPACE.id, name: PERSONAL_SPACE.name },
  'stop-failed': { id: PERSONAL_SPACE.id, name: PERSONAL_SPACE.name },
  'stop-cancel': { id: PERSONAL_SPACE.id, name: PERSONAL_SPACE.name },
  'target-loading': { id: PERSONAL_SPACE.id, name: PERSONAL_SPACE.name },
  'target-failed': { id: PERSONAL_SPACE.id, name: PERSONAL_SPACE.name },
  'access-lost': { id: REVOKED_SPACE.id, name: REVOKED_SPACE.name },
}

/** Scripts that auto-confirm so the stop/load phases are reached. */
const ADVANCE_AFTER_CONFIRM = new Set<DemoScript>([
  'stopping',
  'stop-failed',
  'stop-cancel',
  'target-loading',
  'target-failed',
])

function buildDeps(script: DemoScript): SpaceSwitchFlowDeps {
  return {
    getRunningActivities: () => {
      if (script === 'access-lost') return []
      return script === 'confirm-personal' ? PERSONAL_ACTIVITIES : ENTERPRISE_ACTIVITIES
    },
    stopActivity: async (activity) => {
      if (script === 'stopping') {
        // First item settles, the second one stays in flight — the dialog
        // freezes showing 已停止 / 停止中 / 运行中 side by side.
        return activity.id === 'ent-report' ? true : NEVER.then(() => true)
      }
      if (script === 'stop-failed' || script === 'stop-cancel') {
        return activity.id !== 'ent-crm' // 第 2 项失败
      }
      return true
    },
    loadTargetSpace: async () => {
      if (script === 'target-loading') return NEVER as Promise<TargetLoadOutcome>
      if (script === 'access-lost') return { ok: false, cause: 'access-lost' }
      if (script === 'target-failed') return { ok: false, cause: 'load-error' }
      return { ok: true }
    },
    commitSwitch: () => {},
  }
}

/** Drives the flow into the scripted scene through the public flow API. */
function DemoDriver({ script }: { script: DemoScript }) {
  const flow = useSpaceSwitchFlow()
  const startedRef = React.useRef<string>('')

  React.useEffect(() => {
    if (startedRef.current === script) return
    startedRef.current = script
    flow.requestSwitch(TARGETS[script])
  }, [script, flow])

  React.useEffect(() => {
    if (flow.phase !== 'confirm' || !ADVANCE_AFTER_CONFIRM.has(script)) return
    const timer = setTimeout(() => flow.confirmStop(), 200)
    return () => clearTimeout(timer)
  }, [flow, script])

  React.useEffect(() => {
    if (flow.phase !== 'stopFailed' || script !== 'stop-cancel') return
    const timer = setTimeout(() => flow.cancelSwitch(), 200)
    return () => clearTimeout(timer)
  }, [flow, script])

  return null
}

interface SpaceSwitchDemoProps {
  script?: DemoScript
}

function SpaceSwitchDemo({ script = 'confirm-ent' }: SpaceSwitchDemoProps) {
  const activeId =
    script === 'confirm-personal' || script === 'access-lost'
      ? PERSONAL_SPACE.id
      : ENTERPRISE_SPACE.id
  const [lastCancelAction, setLastCancelAction] = React.useState('')
  const deps = React.useMemo<SpaceSwitchFlowDeps>(() => ({
    ...buildDeps(script),
    // stopCancel 落态的两个出口接真实行为：返回首页 / 重新选择空间。
    onBackHome: () => { setLastCancelAction('已返回首页（onBackHome）') },
    onReselect: () => { setLastCancelAction('已返回空间列表（onReselect）') },
  }), [script])

  return (
    <MockOrganizationProvider
      organizations={[PERSONAL_SPACE, ENTERPRISE_SPACE, REVOKED_SPACE]}
      activeId={activeId}
    >
      <MockTabShellProvider tabs={DEMO_TABS}>
        <SpaceSwitchFlowProvider key={script} deps={deps}>
          <DemoDriver script={script} />
          <DemoFixedContainer width={880} height={560}>
            <TabBar
              account={{
                user: { username: 'wang', displayName: '小王' },
                onLogout: () => {},
              }}
            />
            <div className="flex flex-col items-center justify-center gap-2 bg-hifi-background px-8 text-center pt-24">
              <p className="m-0 text-hifi-xl text-hifi-foreground">产品壳 · 工作区内容</p>
              <p className="m-0 text-hifi-sm text-hifi-fg-50">
                变体脚本注入停止/加载结果；顶栏头像菜单内是「切换空间」列表（见 tab-browser-shell demo）
              </p>
              {lastCancelAction && (
                <p className="m-0 text-hifi-sm text-hifi-info" data-testid="demo-cancel-action">
                  {lastCancelAction}
                </p>
              )}
            </div>
            <SpaceSwitchFlow />
          </DemoFixedContainer>
        </SpaceSwitchFlowProvider>
      </MockTabShellProvider>
    </MockOrganizationProvider>
  )
}

export const spaceSwitchComponents: ComponentEntry[] = [
  {
    id: 'space-switch',
    name: 'Space Switch Flow',
    // 'Browser' hosts the product-shell demos (tab-browser-shell). A dedicated
    // category would need an out-of-scope categoryOrder edit in registry/index.ts.
    category: 'Browser',
    description:
      'M02 空间切换事务流：确认（App×N+助手生成×N）→ 逐项停止（已终止/停止中/失败）→ 全部停止才提交 → 目标加载/失败重试；取消不撤销已停止项（C-R03/C-R04）；失权目标给出原因说明（C-R05）',
    component: SpaceSwitchDemo,
    layout: 'centered',
    previewOverflow: 'visible',
    props: [
      {
        name: 'script',
        description: '演示轨迹（场景脚本）',
        control: {
          type: 'select',
          options: SCRIPT_OPTIONS.map((value) => ({ label: SCRIPT_LABELS[value], value })),
        },
        defaultValue: 'confirm-ent',
      },
    ],
    variants: SCRIPT_OPTIONS.map((value) => ({
      name: SCRIPT_LABELS[value],
      description: `场景脚本 ${value}`,
      props: { script: value },
    })),
  },
]
