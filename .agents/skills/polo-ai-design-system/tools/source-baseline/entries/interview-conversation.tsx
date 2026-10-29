import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { CompactSessionMenu } from '@/components/app-shell/CompactSessionMenu'
import { StatusMenuItems } from '@/components/app-shell/SessionMenuParts'
import { SessionStatusMenu } from '@/components/ui/session-status-menu'
import {
  DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { Button } from '@/components/ui/button'
import { FocusProvider } from '@/context/FocusContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { statusConfigsToSessionStatuses } from '@/config/session-status-config'
import type { StatusConfig } from '@polo-ai/shared/statuses'
import type { Session, Message } from '../../../../../../apps/electron/src/shared/types'

const noAction = () => {}
const timestamp = 1793160000000

const initialSession: Session = {
  id: 'interview-scroll-session', workspaceId: 'playground-workspace', workspaceName: 'Playground',
  name: '长对话阅读', lastMessageAt: timestamp + 24, isProcessing: false,
  messages: Array.from({ length: 24 }, (_, index): Message => ({
    id: `interview-message-${index}`, role: index % 2 ? 'assistant' : 'user',
    timestamp: timestamp + index, turnId: `interview-turn-${Math.floor(index / 2)}`,
    content: index % 2
      ? `## 阅读记录 ${Math.floor(index / 2) + 1}\n\n${Array.from({ length: 4 }, (_, paragraph) => `第 ${paragraph + 1} 段：这是一段用于验证真实对话阅读位置的固定文本。向上查看历史、输入文字与返回最新内容都由生产 ChatDisplay 处理。`).join('\n\n')}`
      : `请整理第 ${Math.floor(index / 2) + 1} 份阅读记录。`,
  })),
}

/** Real ChatDisplay; only session data and send persistence are local fixtures. */
export function InterviewScrollScene() {
  const [session, setSession] = useState(initialSession)
  const [draft, setDraft] = useState('')
  return (
    <NavigationProvider workspaceId="playground-workspace" workspaceSlug="playground"
      onCreateSession={async () => { throw new Error('interview fixture: no server session creation') }}>
      <FocusProvider>
        <section className="flex h-screen min-h-0 flex-col" aria-label="长对话阅读">
          <ChatDisplay session={session} currentModel="gpt-6.1-sol" inputValue={draft} onInputChange={setDraft}
            placeholder="输入消息" permissionMode="ask"
            onSendMessage={(content) => {
              setSession(previous => ({ ...previous, messages: [...previous.messages, {
                id: `local-user-${previous.messages.length}`, role: 'user', content,
                timestamp: timestamp + previous.messages.length,
              }] }))
              setDraft('')
            }}
            onOpenFile={noAction} onOpenUrl={noAction} workspaceId="playground-workspace" />
        </section>
      </FocusProvider>
    </NavigationProvider>
  )
}

const citationSession: Session = {
  id: 'interview-citation-session', workspaceId: 'playground-workspace', workspaceName: 'Playground',
  name: '引用来源核对', lastMessageAt: timestamp + 40, isProcessing: false,
  messages: [
    {
      id: 'interview-citation-1', role: 'user', timestamp: timestamp + 36, turnId: 'interview-citation-turn-1',
      content: '请整理这次发布更新的要点，并附上可核对的来源。',
    },
    {
      id: 'interview-citation-2', role: 'assistant', timestamp: timestamp + 37, turnId: 'interview-citation-turn-1',
      content: [
        '## 发布更新要点', '',
        '- 客户端新增引用来源跳转：来源链接在应用内浏览器打开。',
        '- 会话列表支持按状态快速筛选，筛选条件跨重启保留。', '',
        '### 带链接的来源', '',
        '1. [Polo 10 月发布公告](https://polo.example.com/notes/2026-10-release)',
        '2. [客户端更新日志](https://polo.example.com/changelog/desktop)', '',
        '### 纯文本来源', '',
        '3. 来源：2026-10 用户体验访谈记录（内部整理稿）',
      ].join('\n'),
    },
    {
      id: 'interview-citation-3', role: 'user', timestamp: timestamp + 38, turnId: 'interview-citation-turn-2',
      content: '第二条来源为什么没有链接？',
    },
    {
      id: 'interview-citation-4', role: 'assistant', timestamp: timestamp + 39, turnId: 'interview-citation-turn-2',
      content: '该来源没有可跳转的 URL，是访谈现场的纯文本记录，所以只显示普通文本，不渲染为链接。',
    },
  ],
}

/** Real ChatDisplay; citation fixtures cover linked and plain-text sources. */
export function InterviewCitationScene() {
  const [session, setSession] = useState(citationSession)
  const [draft, setDraft] = useState('')
  return (
    <NavigationProvider workspaceId="playground-workspace" workspaceSlug="playground"
      onCreateSession={async () => { throw new Error('interview fixture: no server session creation') }}>
      <FocusProvider>
        <section className="flex h-screen min-h-0 flex-col" aria-label="引用来源链接">
          <ChatDisplay session={session} currentModel="gpt-6.1-sol" inputValue={draft} onInputChange={setDraft}
            placeholder="输入消息" permissionMode="ask"
            onSendMessage={(content) => {
              setSession(previous => ({ ...previous, messages: [...previous.messages, {
                id: `local-user-${previous.messages.length}`, role: 'user', content,
                timestamp: timestamp + previous.messages.length,
              }] }))
              setDraft('')
            }}
            onOpenFile={noAction} onOpenUrl={noAction} workspaceId="playground-workspace" />
        </section>
      </FocusProvider>
    </NavigationProvider>
  )
}

// Fixture data mirrors the five stored defaults; it is not a status schema.
const statuses: StatusConfig[] = [
  { id: 'backlog', label: 'Backlog', category: 'open', isFixed: false, isDefault: true, order: 0 },
  { id: 'todo', label: 'Todo', category: 'open', isFixed: true, isDefault: false, order: 1 },
  { id: 'needs-review', label: 'Needs Review', category: 'open', isFixed: false, isDefault: true, order: 2 },
  { id: 'done', label: 'Done', category: 'closed', isFixed: true, isDefault: false, order: 3 },
  { id: 'cancelled', label: 'Cancelled', category: 'closed', isFixed: true, isDefault: false, order: 4 },
  { id: 'customer-follow-up', label: 'Customer follow-up', category: 'open', isFixed: false, isDefault: false, order: 5 },
]

function useFixtureStatuses() {
  return useMemo(() => statusConfigsToSessionStatuses(statuses, 'playground-workspace', false), [])
}

export function InterviewStatusPickerScene() {
  const [active, setActive] = useState('todo')
  const states = useFixtureStatuses()
  return <section className="mx-auto w-full max-w-sm px-5 py-8" aria-label="状态选择">
    <SessionStatusMenu states={states} activeState={active} onSelect={setActive} onArchive={noAction} />
  </section>
}

export function InterviewStatusDesktopScene() {
  const { t } = useTranslation()
  const [active, setActive] = useState('todo')
  const states = useFixtureStatuses()
  return <section className="px-5 py-8" data-interview-status="desktop">
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="outline">{t('sessionMenu.status')}</Button></DropdownMenuTrigger>
      <StyledDropdownMenuContent align="start">
        <StatusMenuItems sessionStatuses={states} activeStateId={active} onSelect={setActive}
          menu={{ MenuItem: StyledDropdownMenuItem }} />
      </StyledDropdownMenuContent>
    </DropdownMenu>
  </section>
}

export function InterviewStatusCompactScene() {
  const [active, setActive] = useState('todo')
  const states = useFixtureStatuses()
  return <section className="px-5 py-8" data-interview-status="compact">
    <CompactSessionMenu title="访谈会话" item={{ id: 'interview-status-session', workspaceId: 'playground-workspace', sessionStatus: active }}
      sessionStatuses={states} onSessionStatusChange={setActive}
      onRename={noAction} onFlag={noAction} onUnflag={noAction} onArchive={noAction}
      onUnarchive={noAction} onMarkUnread={noAction} onOpenInNewWindow={noAction} onDelete={noAction} />
  </section>
}
