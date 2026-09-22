/**
 * Playground registry for assistant session states (POO-70 HiFi
 * WS-ASSISTANT-SKILLS, M05).
 *
 * The assistant conversation itself is frozen G4 behavior (ChatDisplay and
 * the session list are reused as-is); these demos compose the existing
 * chat primitives into the M05 scene variants: generating, stopped with
 * partial output kept (PC-F02), pending follow-up question, reopen with
 * the question restored, and the personal-space quote summary with the
 * browser top-up path (PC-N03).
 */

import * as React from 'react'
import type { ComponentEntry } from './types'
import { TurnCard, UserMessageBubble, type ActivityItem, type ResponseContent } from '@polo-ai/ui'
import { CircleStop, HelpCircle, Wallet } from 'lucide-react'
import { InputContainer } from '@/components/app-shell/input'
import type { PermissionMode } from '../../../shared/types'
import { DemoFixedContainer } from '../mocks/DemoFixedContainer'
import {
  ensureMockElectronAPI,
  mockInputCallbacks,
  mockSources,
} from '../mock-utils'

type SessionVariant =
  | 'generating'
  | 'stopped'
  | 'question'
  | 'question-reopen'
  | 'personal-summary'

const now = Date.now()

const researchActivity: ActivityItem = {
  id: 'tool-research',
  type: 'tool',
  status: 'running',
  toolName: 'Skill',
  toolInput: { skill: '资料研究', question: 'Q2 客户报价' },
  intent: '检索三家客户的 Q2 报价记录',
  timestamp: now - 3000,
}

const completedResearchActivity: ActivityItem = {
  ...researchActivity,
  status: 'completed',
  timestamp: now - 8000,
}

const summaryResponse: ResponseContent = {
  text: [
    'Q2 报价汇总（我的空间）：',
    '',
    '- 晨星科技：软件许可 ¥120,000，续费口径与 Q1 一致',
    '- 蓝湖设计：设计服务 ¥45,000，含两次改稿',
    '- 北极物流：平台接入 ¥68,000，按季度结算',
    '',
    '三家客户的合同到期日都在 9 月内，建议本周内发出续费提醒。',
  ].join('\n'),
  isStreaming: false,
}

const partialResponse: ResponseContent = {
  text: 'Q2 报价汇总：已整理晨星科技与蓝湖设计的报价，北极物流的记录还在核对中…',
  isStreaming: false,
}

/** Demo scaffold for the pending follow-up question card (PC-N04). */
function FollowUpQuestionCard({ restored = false }: { restored?: boolean }) {
  const [answered, setAnswered] = React.useState(false)
  if (answered) return null
  return (
    <div className="mx-auto my-3 max-w-[520px] rounded-xl border border-border bg-surface p-3 shadow-minimal">
      <div className="flex items-start gap-2">
        <HelpCircle className="mt-0.5 size-4 shrink-0 text-accent" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {restored ? '重开后待回答：' : '助手在等你的回答'}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            北极物流的接入费是否沿用去年的框架价？
          </p>
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => setAnswered(true)}
              className="h-7 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-foreground"
            >
              在对话中回答
            </button>
            <button
              type="button"
              onClick={() => setAnswered(true)}
              className="h-7 rounded-md border border-border px-2.5 text-xs font-medium text-foreground hover:bg-foreground/[0.04]"
            >
              暂不回答
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SessionPreviewProps {
  variant?: SessionVariant
}

function SessionPreview({ variant = 'generating' }: SessionPreviewProps) {
  const [permissionMode] = React.useState<PermissionMode>('ask')
  React.useEffect(() => {
    ensureMockElectronAPI()
  }, [])

  return (
    <DemoFixedContainer width={640} height={540}>
      <div className="flex h-full flex-col bg-background">
        <div className="flex-1 overflow-auto px-5 py-6">
          <UserMessageBubble content="把 Q2 三家客户的报价汇总一下，标出到期时间。" />

          {variant === 'generating' && (
            <TurnCard
              sessionId="playground-session"
              turnId="m05-generating"
              activities={[researchActivity]}
              intent="检索三家客户的 Q2 报价记录"
              isStreaming
              isComplete={false}
              onOpenFile={() => {}}
              onOpenUrl={() => {}}
            />
          )}

          {variant === 'stopped' && (
            <>
              <TurnCard
                sessionId="playground-session"
                turnId="m05-stopped"
                activities={[completedResearchActivity]}
                response={partialResponse}
                isStreaming={false}
                isComplete={false}
                onOpenFile={() => {}}
                onOpenUrl={() => {}}
              />
              <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <CircleStop className="size-3.5" />
                已停止生成 · 已生成的内容保留在对话中
              </div>
            </>
          )}

          {(variant === 'question' || variant === 'question-reopen') && (
            <>
              <TurnCard
                sessionId="playground-session"
                turnId="m05-question"
                activities={[completedResearchActivity]}
                response={{
                  text: '已整理晨星科技与蓝湖设计的报价。整理北极物流前需要确认一个问题：',
                  isStreaming: false,
                }}
                isStreaming={false}
                isComplete
                onOpenFile={() => {}}
                onOpenUrl={() => {}}
              />
              <FollowUpQuestionCard restored={variant === 'question-reopen'} />
            </>
          )}

          {variant === 'personal-summary' && (
            <>
              <TurnCard
                sessionId="playground-session"
                turnId="m05-personal"
                activities={[completedResearchActivity]}
                response={summaryResponse}
                intent="使用「资料研究」整理报价"
                isStreaming={false}
                isComplete
                onOpenFile={() => {}}
                onOpenUrl={() => {}}
              />
              <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <Wallet className="size-3.5" />
                个人空间 · 积分不足时走「充值与账单」在系统浏览器完成，回来自行恢复
              </div>
            </>
          )}
        </div>

        <div className="mx-auto w-full px-4 pb-4" style={{ maxWidth: 'var(--content-max-width, 960px)' }}>
          <InputContainer
            placeholder={variant === 'question-reopen'
              ? '上次未回答的问题已恢复，可直接输入…'
              : 'Message Polo AI...'}
            disabled={false}
            isProcessing={variant === 'generating'}
            currentModel="claude-sonnet-4-6"
            permissionMode={permissionMode}
            onPermissionModeChange={() => {}}
            sources={mockSources}
            enabledSourceSlugs={[]}
            workingDirectory="/Users/demo/projects/polo-ai"
            sessionId="playground-session"
            onSubmit={mockInputCallbacks.onSubmit}
            onModelChange={mockInputCallbacks.onModelChange}
            onInputChange={mockInputCallbacks.onInputChange}
            onHeightChange={mockInputCallbacks.onHeightChange}
            onFocusChange={mockInputCallbacks.onFocusChange}
            onSourcesChange={mockInputCallbacks.onSourcesChange}
            onWorkingDirectoryChange={mockInputCallbacks.onWorkingDirectoryChange}
            onStop={mockInputCallbacks.onStop}
          />
        </div>
      </div>
    </DemoFixedContainer>
  )
}

export const assistantSessionComponents: ComponentEntry[] = [
  {
    id: 'assistant-session',
    name: 'Assistant Session States',
    category: 'Chat',
    description:
      'M05 会话态变体（复用既有 chat 原语，不改会话核心）— P-M05-CHAT / STOPPED / QUESTION / QUESTION-REOPEN / CHAT-PERSONAL',
    component: SessionPreview,
    layout: 'centered',
    props: [
      {
        name: 'variant',
        description: 'Session scene variant',
        control: {
          type: 'select',
          options: [
            { label: 'Generating (P-M05-CHAT)', value: 'generating' },
            { label: 'Stopped (P-M05-STOPPED)', value: 'stopped' },
            { label: 'Question pending (P-M05-QUESTION)', value: 'question' },
            { label: 'Question reopened (P-M05-QUESTION-REOPEN)', value: 'question-reopen' },
            { label: 'Personal summary (P-M05-CHAT-PERSONAL)', value: 'personal-summary' },
          ],
        },
        defaultValue: 'generating',
      },
    ],
    variants: [
      {
        name: 'P-M05-CHAT generating',
        description: '企业空间对话生成中：资料研究 Skill 运行中 + composer 处理态',
        props: { variant: 'generating' },
      },
      {
        name: 'P-M05-STOPPED partial kept',
        description: '用户停止：已生成内容保留（PC-F02），可继续追问',
        props: { variant: 'stopped' },
      },
      {
        name: 'P-M05-QUESTION pending',
        description: '追问待回答：在对话中回答 / 暂不回答（PC-N04）',
        props: { variant: 'question' },
      },
      {
        name: 'P-M05-QUESTION-REOPEN restored',
        description: '重开后问题恢复，草稿提示留在 composer',
        props: { variant: 'question-reopen' },
      },
      {
        name: 'P-M05-CHAT-PERSONAL quote summary',
        description: '个人空间报价汇总 + 充值链落点说明（PC-N03）',
        props: { variant: 'personal-summary' },
      },
    ],
  },
]
