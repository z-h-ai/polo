import * as React from 'react'
import { Paperclip, Send, Sparkles } from 'lucide-react'
import type { ComponentEntry } from './types'
import {
  AppCreditsBanner,
  CreditsGate,
  EntCreditsNotify,
  StreamCutNotice,
  TopupCheckFlow,
  TopupHandoff,
  UserStopNotice,
} from '@/components/credits'
import { HomeSurfaceSlotsProvider, useHomeSurfaceSlots } from '@/context/HomeSurfaceSlotsContext'
import { DemoFixedContainer } from '../mocks'
import { cn } from '@/lib/utils'

// =============================================================================
// Credits Flows Playground (POO-70 M09 verification)
// - PRE-BLOCK: input preserved, send unavailable, reason + 去充值 on screen
// - STREAM-CUT: partial output kept and labeled as-is
// - APP-BANNER: non-modal container banner; ENT-NOTIFY informs the Owner
// - USER-STOP: user stop ≠ credits shortage (separate surfaces)
// - BROWSER: topup handoff (also stream + menu + enterprise billing variants)
// - CHECKING / NOT-YET / RESUMED: single user-initiated query; arrival only
//   lifts the block, 继续发送 stays a user action
// =============================================================================

const NO_OP = () => {}

const DRAFT = '把 Q2 报价按客户分组汇总，标出与上季度的差异。'

function ComposerFrame({
  banner,
  sendDisabled = false,
  textareaValue,
  placeholder,
  notice,
}: {
  banner?: React.ReactNode
  notice?: React.ReactNode
  sendDisabled?: boolean
  textareaValue?: string
  placeholder?: string
}) {
  return (
    <div className="w-[560px] rounded-lg border border-border bg-background p-4">
      <div className="mb-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Sparkles className="size-3.5" aria-hidden="true" />
        <span>Polo 助手 · 我的空间</span>
      </div>
      {notice}
      {banner}
      <div className="mt-2 rounded-md border border-border bg-background p-2.5">
        <textarea
          rows={3}
          value={textareaValue}
          placeholder={placeholder}
          readOnly
          className="w-full resize-none border-0 bg-transparent text-[13px] text-foreground outline-none"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Paperclip className="size-3.5" aria-hidden="true" />
            添加文件
          </span>
          <button
            type="button"
            aria-label="发送消息"
            disabled={sendDisabled}
            className={cn(
              'grid size-8 place-items-center rounded-md transition-colors',
              sendDisabled
                ? 'cursor-not-allowed bg-foreground/10 text-muted-foreground'
                : 'cursor-pointer bg-accent text-white',
            )}
          >
            <Send className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  )
}

interface GateDemoProps {
  variant?: 'blocked' | 'resumed'
}

/** Gate mounted through the HomeSurfaceSlots.creditsBlockingBanner slot. */
function GateDemo({ variant = 'blocked' }: GateDemoProps) {
  return (
    <HomeSurfaceSlotsProvider
      slots={{
        creditsBlockingBanner: () =>
          variant === 'resumed' ? (
            <CreditsGate variant="resumed" needed={60} balance={112} onContinueSend={NO_OP} />
          ) : (
            <CreditsGate needed={60} balance={12} onTopup={NO_OP} />
          ),
      }}
    >
      <GateSlotConsumer variant={variant} />
    </HomeSurfaceSlotsProvider>
  )
}

function GateSlotConsumer({ variant }: { variant: 'blocked' | 'resumed' }) {
  const { creditsBlockingBanner } = useHomeSurfaceSlots()
  return (
    <ComposerFrame
      banner={creditsBlockingBanner?.()}
      sendDisabled={variant === 'blocked'}
      textareaValue={DRAFT}
      placeholder="输入内容已保留"
    />
  )
}

function StreamCutDemo() {
  return (
    <ComposerFrame
      banner={<StreamCutNotice onTopup={NO_OP} />}
      sendDisabled
      placeholder="想让助手做什么？例如：把这份报价按客户分组汇总"
    />
  )
}

interface BannerDemoProps {
  scope?: 'enterprise' | 'personal'
  notified?: boolean
}

function BannerDemo({ scope = 'enterprise', notified = false }: BannerDemoProps) {
  return (
    <div className="w-[560px] overflow-hidden rounded-lg border border-border bg-background">
      {notified ? (
        <EntCreditsNotify onAcknowledge={NO_OP} />
      ) : (
        <AppCreditsBanner scope={scope} onAction={NO_OP} />
      )}
      <div className="grid h-40 place-items-center bg-foreground/2 text-[13px] text-muted-foreground">
        App 内容区（合同审查 · 晨星科技）
      </div>
    </div>
  )
}

function UserStopDemo() {
  return (
    <ComposerFrame
      notice={<UserStopNotice />}
      textareaValue={DRAFT}
      placeholder="想让助手做什么？例如：把这份报价按客户分组汇总"
    />
  )
}

interface TopupBrowserDemoProps {
  variant?: 'topup' | 'topup-stream' | 'billing' | 'billing-enterprise'
}

function TopupBrowserDemo({ variant = 'topup' }: TopupBrowserDemoProps) {
  return (
    <DemoFixedContainer width={880} height={560}>
      <TopupHandoff
        variant={variant}
        balance={12}
        needed={60}
        onCancel={NO_OP}
        onContinueInBrowser={NO_OP}
      />
    </DemoFixedContainer>
  )
}

interface CheckDemoProps {
  phase?: 'checking' | 'not-arrived'
}

function CheckDemo({ phase = 'checking' }: CheckDemoProps) {
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
      <TopupCheckFlow phase={phase} open={open} onOpenChange={setOpen} onCheck={NO_OP} />
    </div>
  )
}

export const creditsFlowsComponents: ComponentEntry[] = [
  {
    id: 'credits-pre-block',
    name: 'Credits · Pre-send Block',
    category: 'Chat',
    description:
      '发送前积分不足（P-M09-PRE-BLOCK，PC-N03）：输入完整保留、发送不可用、原因+去充值同屏；经 HomeSurfaceSlots.creditsBlockingBanner 挂载',
    component: GateDemo,
    props: [
      {
        name: 'variant',
        description: '阻断 / 到账恢复',
        control: {
          type: 'select',
          options: [
            { label: 'blocked', value: 'blocked' },
            { label: 'resumed (arrived)', value: 'resumed' },
          ],
        },
        defaultValue: 'blocked',
      },
    ],
    variants: [
      { name: 'P-M09-PRE-BLOCK · blocked', description: '需要 60 / 余额 12，输入已保留', props: { variant: 'blocked' } },
      {
        name: 'P-M09-RESUMED · arrived',
        description: '到账只解除阻断；继续发送是用户动作',
        props: { variant: 'resumed' },
      },
    ],
  },
  {
    id: 'credits-stream-cut',
    name: 'Credits · Stream Cut',
    category: 'Chat',
    description: '生成中不足（P-M09-STREAM-CUT）：已生成部分保留并如实标注，去充值入口',
    component: StreamCutDemo,
    props: [],
    variants: [{ name: 'P-M09-STREAM-CUT · partial output', description: '本次生成已暂停横幅', props: {} }],
  },
  {
    id: 'credits-app-banner',
    name: 'Credits · App Banner',
    category: 'Chat',
    description:
      'App 内非模态横幅（P-M09-APP-BANNER / ENT-NOTIFY）：容器级提示不接管 App 界面；通知 Owner 不代裁决',
    component: BannerDemo,
    props: [
      {
        name: 'scope',
        description: '横幅场景',
        control: {
          type: 'select',
          options: [
            { label: 'enterprise', value: 'enterprise' },
            { label: 'personal', value: 'personal' },
          ],
        },
        defaultValue: 'enterprise',
      },
      {
        name: 'notified',
        description: '已通知管理员（ENT-NOTIFY 态）',
        control: { type: 'boolean' },
        defaultValue: false,
      },
    ],
    variants: [
      { name: 'P-M09-APP-BANNER · non-modal', description: '企业额度提醒 + 通知管理员', props: {} },
      { name: 'P-M09-ENT-NOTIFY · owner notified', description: '成员不能自充，已通知管理员', props: { notified: true } },
    ],
  },
  {
    id: 'credits-user-stop',
    name: 'Credits · User Stop',
    category: 'Chat',
    description: '用户主动停止 ≠ 积分不足（P-M09-USER-STOP）：分开展示，无充值入口',
    component: UserStopDemo,
    props: [],
    variants: [{ name: 'P-M09-USER-STOP · separate notice', description: '消息级停止说明，发送仍可用', props: {} }],
  },
  {
    id: 'credits-topup-handoff',
    name: 'Credits · Topup Handoff',
    category: 'Browser',
    description:
      '充值浏览器交接（P-M09-BROWSER / BROWSER-STREAM / BROWSER-MENU / BROWSER-MENU-ENT）：复用 hifi HandoffCard',
    component: TopupBrowserDemo,
    layout: 'top',
    props: [
      {
        name: 'variant',
        description: '交接场景',
        control: {
          type: 'select',
          options: [
            { label: 'topup (from gate)', value: 'topup' },
            { label: 'topup (from stream cut)', value: 'topup-stream' },
            { label: 'billing menu (personal)', value: 'billing' },
            { label: 'billing menu (enterprise)', value: 'billing-enterprise' },
          ],
        },
        defaultValue: 'topup',
      },
    ],
    variants: [
      { name: 'P-M09-BROWSER · topup', description: '余额 12 / 需要 60 的充值交接', props: { variant: 'topup' } },
      { name: 'P-M09-BROWSER-STREAM · stream entry', description: '生成中断后进入充值', props: { variant: 'topup-stream' } },
      { name: 'P-M09-BROWSER-MENU · billing', description: '账号菜单「充值与账单」个人交接', props: { variant: 'billing' } },
      {
        name: 'P-M09-BROWSER-MENU-ENT · enterprise billing',
        description: '企业积分与账单交接',
        props: { variant: 'billing-enterprise' },
      },
    ],
  },
  {
    id: 'credits-check-flow',
    name: 'Credits · Topup Check',
    category: 'Chat',
    description:
      '返回后核对（P-M09-CHECKING / NOT-YET）：每次查询由用户发起；未到账保持阻断可再查；RESUMED 见 pre-block demo 的 resumed 变体',
    component: CheckDemo,
    props: [
      {
        name: 'phase',
        description: '核对阶段',
        control: {
          type: 'select',
          options: [
            { label: 'checking', value: 'checking' },
            { label: 'not-arrived', value: 'not-arrived' },
          ],
        },
        defaultValue: 'checking',
      },
    ],
    variants: [
      { name: 'P-M09-CHECKING · querying', description: '正在确认到账状态，对话草稿已保留', props: { phase: 'checking' } },
      { name: 'P-M09-NOT-YET · not arrived', description: '未查到新余额，可再查一次（错误态）', props: { phase: 'not-arrived' } },
    ],
  },
]
