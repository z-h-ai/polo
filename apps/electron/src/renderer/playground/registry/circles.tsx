import * as React from 'react'
import type { ComponentEntry } from './types'
import {
  CirclesEntryCard,
  CirclesListPage,
  CircleDetailPage,
  JoinFlow,
  LeaveFlow,
  RenewFlow,
  SubscribeFlow,
  SourcedWorksPanel,
  revokeCircleSources,
  type CircleSourcedApp,
  type CircleSummary,
} from '@/components/tab-browser/circles'
import { HomeSurfaceSlotsProvider, useHomeSurfaceSlots } from '@/context/HomeSurfaceSlotsContext'
import { DemoFixedContainer } from '../mocks'

// =============================================================================
// Circles Playground (POO-70 M07 verification)
// Renders the real circle surfaces with prototype-faithful demo data:
// - LIST / EMPTY: the 「我的圈子」 list beside 「全部 Apps」(D-PC-07)
// - DETAIL joined / paid / expired / left: works + subscription terms
// - JOIN free-confirm / pending-approval dialogs
// - Pay chain: browser handoff → return-fail re-check (C-R08)
// - RENEW active (from expiry) / expired (immediate, PC-F03)
// - LEAVE free / paid confirmations (D-PC-09 source accounting)
// - SOURCE-FALLBACK: one revoked source, work stays (dedupe contract)
// =============================================================================

const NOW = '2026-09-22'

const GROWTH: CircleSummary = {
  id: 'circle-growth',
  name: '晨星增长圈',
  creator: '晨星增长工作室',
  membership: 'active',
  updateNote: '本周新增打法案例 2 篇',
  appCount: 1,
  skillCount: 1,
}

const DESIGN: CircleSummary = {
  id: 'circle-design',
  name: '晨星设计圈',
  creator: '晨星增长工作室',
  membership: 'active',
  subscription: { price: '¥39 / 月', expiresAt: '2026-10-01' },
  updateNote: '品牌语气分析 v1.4.0 已更新',
  appCount: 2,
  skillCount: 1,
}

const DESIGN_EXPIRED: CircleSummary = {
  ...DESIGN,
  subscription: { price: '¥39 / 月', expiresAt: '2026-09-01' },
}

const WORKSHOP: CircleSummary = {
  id: 'circle-workshop',
  name: '数据工坊圈',
  creator: '数据工坊',
  membership: 'active',
  updateNote: '已获得 1 个 App：数据报表生成器',
  appCount: 1,
  skillCount: 0,
}

function source(circleId: string, circleName: string, creator: string, valid = true) {
  return { circleId, circleName, creator, valid }
}

const APPS: CircleSourcedApp[] = [
  {
    appId: 'app-growth-playbook',
    name: '增长打法手册',
    sources: [source('circle-growth', '晨星增长圈', '晨星增长工作室')],
  },
  {
    appId: 'app-brand-voice',
    name: '品牌语气分析',
    sources: [source('circle-design', '晨星设计圈', '晨星增长工作室')],
  },
  {
    appId: 'app-meeting-notes',
    name: '会议纪要整理',
    sources: [
      source('circle-design', '晨星设计圈', '晨星增长工作室'),
      source('circle-growth', '晨星增长圈', '晨星增长工作室'),
    ],
  },
  {
    appId: 'app-report-gen',
    name: '数据报表生成器',
    sources: [source('circle-workshop', '数据工坊圈', '数据工坊')],
  },
]

const SKILLS: CircleSourcedApp[] = [
  {
    appId: 'skill-case-search',
    name: '增长案例检索',
    sources: [
      source('circle-growth', '晨星增长圈', '晨星增长工作室'),
      source('circle-design', '晨星设计圈', '晨星增长工作室'),
    ],
  },
]

const WORK_DETAILS = {
  'app-growth-playbook': { description: '查增长方法和真实案例', version: 'v3.0.2' },
  'app-brand-voice': { description: '分析对外文案语气', version: 'v1.4.0' },
  'app-meeting-notes': { description: '把会议录音变成纪要', version: 'v0.6.1' },
  'app-report-gen': { description: '定期自动生成数据报表' },
  'skill-case-search': { description: '检索打法与案例' },
}

const NO_OP = () => {}

function PageFrame({ height = 620, children }: { height?: number; children: React.ReactNode }) {
  return (
    <div
      className="h-full overflow-auto rounded-lg border border-border bg-hifi-background"
      style={{ height }}
    >
      {children}
    </div>
  )
}

interface CircleListDemoProps {
  empty?: boolean
}

function CircleListDemo({ empty = false }: CircleListDemoProps) {
  return (
    <PageFrame>
      <CirclesListPage
        now={NOW}
        circles={empty ? [] : [GROWTH, DESIGN, WORKSHOP]}
        onBack={NO_OP}
        onOpenCircle={NO_OP}
        onUseInviteLink={NO_OP}
      />
    </PageFrame>
  )
}

interface CircleDetailDemoProps {
  state?: 'joined' | 'paid' | 'expired' | 'left'
}

function CircleDetailDemo({ state = 'joined' }: CircleDetailDemoProps) {
  // Left and expired both render against this circle's revoked sources;
  // the membership state (not the data) decides the row presentation:
  // expired keeps only-here works actionable (已到期 + 打开 + 续费恢复).
  const sourcesRevoked = state === 'left' || state === 'expired'
  const revokedApps = revokeCircleSources(APPS, 'circle-design')
  const revokedSkills = revokeCircleSources(SKILLS, 'circle-design')
  const circle =
    state === 'joined'
      ? GROWTH
      : state === 'expired'
        ? DESIGN_EXPIRED
        : state === 'left'
          ? { ...DESIGN, membership: 'left' as const }
          : DESIGN
  return (
    <PageFrame height={680}>
      <CircleDetailPage
        now={NOW}
        circle={circle}
        apps={sourcesRevoked ? revokedApps : APPS}
        skills={sourcesRevoked ? revokedSkills : SKILLS}
        installedSkillIds={['skill-installed-elsewhere']}
        workDetails={WORK_DETAILS}
        onBack={NO_OP}
        onViewAllApps={NO_OP}
        onManageSkills={NO_OP}
        onOpenWork={NO_OP}
        onInstallWork={NO_OP}
        onRenew={NO_OP}
        onRejoin={NO_OP}
        onLeave={NO_OP}
      />
    </PageFrame>
  )
}

interface CirclesEntryDemoProps {
  count?: number
}

/** Home-surface slot wiring proof: provider injects the entry card renderer. */
function CirclesEntryDemo({ count = 3 }: CirclesEntryDemoProps) {
  return (
    <HomeSurfaceSlotsProvider
      slots={{
        circlesEntry: () => (
          <CirclesEntryCard count={count} onClick={NO_OP} className="max-w-[360px]" />
        ),
      }}
    >
      <HomeSlotConsumer />
    </HomeSurfaceSlotsProvider>
  )
}

function HomeSlotConsumer() {
  const { circlesEntry } = useHomeSurfaceSlots()
  return (
    <div className="w-[420px] rounded-lg border border-border bg-hifi-background p-6">
      <p className="m-0 mb-3 text-hifi-md font-semibold text-hifi-foreground">下午好，小王</p>
      {circlesEntry?.()}
    </div>
  )
}

interface JoinDemoProps {
  variant?: 'confirm' | 'pending'
}

function JoinDemo({ variant = 'confirm' }: JoinDemoProps) {
  const [open, setOpen] = React.useState(true)
  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="justify-self-start rounded-md border border-border px-3 py-1.5 text-xs"
      >
        重新打开对话框
      </button>
      <p className="m-0 text-xs text-muted-foreground">
        对话框以真实 Dialog 渲染在预览中央（prototype P-M07-JOIN-FREE / JOIN-PENDING）
      </p>
      <JoinFlow
        circle={GROWTH}
        variant={variant}
        open={open}
        onOpenChange={setOpen}
        onConfirm={NO_OP}
      />
    </div>
  )
}

interface PayChainDemoProps {
  step?: 'handoff' | 'return-fail' | 'handoff-expired'
}

function PayChainDemo({ step = 'handoff' }: PayChainDemoProps) {
  return (
    <DemoFixedContainer width={880} height={560}>
      <SubscribeFlow
        circle={step === 'handoff-expired' ? DESIGN_EXPIRED : DESIGN}
        variant={step === 'return-fail' ? 'return-fail' : 'handoff'}
        restore={step === 'handoff-expired'}
        onCancel={NO_OP}
        onContinueInBrowser={NO_OP}
        onRecheck={NO_OP}
        onBackToList={NO_OP}
      />
    </DemoFixedContainer>
  )
}

interface RenewDemoProps {
  expired?: boolean
}

function RenewDemo({ expired = false }: RenewDemoProps) {
  const [open, setOpen] = React.useState(true)
  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="justify-self-start rounded-md border border-border px-3 py-1.5 text-xs"
      >
        重新打开对话框
      </button>
      <RenewFlow
        circle={expired ? DESIGN_EXPIRED : DESIGN}
        months={1}
        now={NOW}
        open={open}
        onOpenChange={setOpen}
        onPayInBrowser={NO_OP}
      />
    </div>
  )
}

interface LeaveDemoProps {
  paid?: boolean
}

function LeaveDemo({ paid = false }: LeaveDemoProps) {
  const [open, setOpen] = React.useState(true)
  const circle = paid ? DESIGN : GROWTH
  return (
    <div className="grid gap-3">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="justify-self-start rounded-md border border-border px-3 py-1.5 text-xs"
      >
        重新打开对话框
      </button>
      <LeaveFlow
        circle={circle}
        works={[...APPS, ...SKILLS]}
        open={open}
        onOpenChange={setOpen}
        onConfirm={NO_OP}
      />
    </div>
  )
}

function SourceFallbackDemo() {
  const apps = revokeCircleSources(APPS, 'circle-design')
  return (
    <div className="grid w-[520px] gap-3">
      <SourcedWorksPanel apps={apps.slice(0, 3)} />
      <p className="m-0 text-xs text-muted-foreground">
        同一作品仍是一条目；「会议纪要整理」的晨星设计圈来源已撤销、晨星增长圈来源仍有效（D-PC-09）
      </p>
    </div>
  )
}

export const circlesComponents: ComponentEntry[] = [
  {
    id: 'circles-list',
    name: 'Circles · List',
    category: 'Browser',
    description:
      '「我的圈子」列表/空态（P-M07-LIST / P-M07-EMPTY）：与「全部 Apps」并列的个人空间稳定入口；空态说明链接/二维码/定向邀请/付费/审批等私域入口',
    component: CircleListDemo,
    layout: 'top',
    props: [
      {
        name: 'empty',
        description: '空态（还没有加入圈子）',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'P-M07-LIST · 3 circles', description: '已加入 3 个圈子（免费/付费/免费）', props: {} },
      { name: 'P-M07-EMPTY · empty state', description: '空态 + 使用已有链接或二维码 CTA', props: { empty: true } },
    ],
  },
  {
    id: 'circles-detail',
    name: 'Circles · Detail',
    category: 'Browser',
    description:
      '圈子详情四态（P-M07-DETAIL-FOCUS / DETAIL-PAID / EXPIRED / DETAIL-PAID-AFTER-LEAVE）：已获得作品 + 订阅信息 + 到期规则；续费/退出都在详情',
    component: CircleDetailDemo,
    layout: 'top',
    props: [
      {
        name: 'state',
        description: '成员资格状态',
        control: {
          type: 'select',
          options: [
            { label: 'joined (free)', value: 'joined' },
            { label: 'paid (subscribed)', value: 'paid' },
            { label: 'expired', value: 'expired' },
            { label: 'left', value: 'left' },
          ],
        },
        defaultValue: 'joined',
      },
    ],
    variants: [
      { name: 'P-M07-DETAIL-FOCUS · joined free', description: '免费 · 长期有效；App 与技能行', props: { state: 'joined' } },
      { name: 'P-M07-DETAIL-PAID · subscribed', description: '¥39/月 · 下次续费 2026-10-01；续费 + 退出按钮', props: { state: 'paid' } },
      { name: 'P-M07-EXPIRED · expired', description: '到期态：独有作品已到期+打开+续费恢复；共同授权作品仍可用', props: { state: 'expired' } },
      {
        name: 'P-M07-DETAIL-PAID-AFTER-LEAVE · left',
        description: '已退出态：仅此圈提供的作品不可用（仅晨星设计圈提供）；共同授权仍可用',
        props: { state: 'left' },
      },
    ],
  },
  {
    id: 'circles-entry-card',
    name: 'Circles · Home Entry Card',
    category: 'Browser',
    description:
      '首页「我的圈子」入口卡（HomeSurfaceSlots.circlesEntry slot 注入示例，P-M03-HOME-PERSONAL 的 circle-entry 锚点）',
    component: CirclesEntryDemo,
    props: [
      {
        name: 'count',
        description: '圈子数量',
        control: { type: 'number', min: 0, max: 99, step: 1 },
        defaultValue: 3,
      },
    ],
    variants: [
      { name: 'P-M03 · 3 circles', description: 'slot 注入后首页渲染入口卡', props: { count: 3 } },
      { name: 'P-M03 · no circles', description: '空计数变体', props: { count: 0 } },
    ],
  },
  {
    id: 'circles-join',
    name: 'Circles · Join Flow',
    category: 'Browser',
    description:
      '免费加入两态（P-M07-JOIN-FREE / P-M07-JOIN-PENDING）：免费确认后立即生效；待审批在批准前不出现作品',
    component: JoinDemo,
    props: [
      {
        name: 'variant',
        description: '加入流程变体',
        control: {
          type: 'select',
          options: [
            { label: 'confirm (free)', value: 'confirm' },
            { label: 'pending approval', value: 'pending' },
          ],
        },
        defaultValue: 'confirm',
      },
    ],
    variants: [
      { name: 'P-M07-JOIN-FREE · confirm', description: '内容价格/可获得/加入后 + 确认加入', props: { variant: 'confirm' } },
      { name: 'P-M07-JOIN-PENDING · awaiting approval', description: '等待审批说明 + 知道了', props: { variant: 'pending' } },
    ],
  },
  {
    id: 'circles-pay-chain',
    name: 'Circles · Pay Chain',
    category: 'Browser',
    description:
      '付费订阅支付链（P-M07-PAY-BROWSER / PAY-RETURN-FAIL / PAY-BROWSER-EXPIRED）：支付在浏览器完成，桌面只发起并核对；返回失败可重试核对、不伪造到期（C-R08）',
    component: PayChainDemo,
    props: [
      {
        name: 'step',
        description: '支付链步骤',
        control: {
          type: 'select',
          options: [
            { label: 'browser handoff', value: 'handoff' },
            { label: 'return: status unconfirmed', value: 'return-fail' },
            { label: 'browser handoff (expired repurchase)', value: 'handoff-expired' },
          ],
        },
        defaultValue: 'handoff',
      },
    ],
    variants: [
      { name: 'P-M07-PAY-BROWSER · handoff', description: '浏览器/桌面职责两栏交接卡 + 在浏览器继续', props: { step: 'handoff' } },
      { name: 'P-M07-PAY-RETURN-FAIL · recheck', description: '订单已提交/成员资格确认中 + 重新核对', props: { step: 'return-fail' } },
      { name: 'P-M07-PAY-BROWSER-EXPIRED · repurchase', description: '到期后重购（续费恢复）交接卡', props: { step: 'handoff-expired' } },
    ],
  },
  {
    id: 'circles-renew',
    name: 'Circles · Renew Flow',
    category: 'Browser',
    description:
      '手动续费两态（P-M07-RENEW / RENEW-EXPIRED）：从到期日起算、上限 12 个月、无自动扣款；到期后重购立即生效（PC-F03）',
    component: RenewDemo,
    props: [
      {
        name: 'expired',
        description: '到期后重购（起算日=今天，立即生效）',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'P-M07-RENEW · from expiry', description: '起算日=当前到期日 2026-10-01', props: { expired: false } },
      { name: 'P-M07-RENEW-EXPIRED · immediate', description: '起算日=今天（立即生效）', props: { expired: true } },
    ],
  },
  {
    id: 'circles-leave',
    name: 'Circles · Leave Flow',
    category: 'Browser',
    description:
      '退出确认两态（P-M07-LEAVE / LEAVE-PAID）：确认前说明哪些作品仍可用（其他圈授权）与哪些将不可用（仅此圈提供）',
    component: LeaveDemo,
    props: [
      {
        name: 'paid',
        description: '付费圈子变体（晨星设计圈）',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'P-M07-LEAVE · free circle', description: '退出晨星增长圈：会议纪要整理仍可用', props: { paid: false } },
      { name: 'P-M07-LEAVE-PAID · paid circle', description: '退出晨星设计圈：品牌语气分析将不可用', props: { paid: true } },
    ],
  },
  {
    id: 'circles-source-fallback',
    name: 'Circles · Source Fallback',
    category: 'Browser',
    description:
      '来源回退展示（P-M07-SOURCE-FALLBACK，D-PC-09）：单圈来源撤销后同一作品仍一条目、另一来源仍有效；CircleSourcedApp 数据形状（ws-home-apps 目录侧对齐约定）',
    component: SourceFallbackDemo,
    props: [],
    variants: [
      {
        name: 'P-M07-SOURCE-FALLBACK · one source revoked',
        description: '晨星设计圈来源撤销、晨星增长圈仍有效',
        props: {},
      },
    ],
  },
]
