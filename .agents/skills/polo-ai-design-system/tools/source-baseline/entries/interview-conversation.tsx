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
