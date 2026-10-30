import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, FolderOpen } from 'lucide-react'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { CompactSessionMenu } from '@/components/app-shell/CompactSessionMenu'
import { StatusMenuItems } from '@/components/app-shell/SessionMenuParts'
import { SessionStatusMenu } from '@/components/ui/session-status-menu'
import {
  DropdownMenu, DropdownMenuTrigger, StyledDropdownMenuContent,
  StyledDropdownMenuItem,
} from '@/components/ui/styled-dropdown'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import {
  StyledContextMenuContent, StyledContextMenuItem,
} from '@/components/ui/styled-context-menu'
import { getFileManagerName } from '@/lib/platform'
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

const fileLinkSession: Session = {
  id: 'interview-file-link-session', workspaceId: 'playground-workspace', workspaceName: 'Playground',
  name: '文件链接核对', lastMessageAt: timestamp + 4, isProcessing: false,
  messages: [
    {
      id: 'interview-file-link-1', role: 'user', timestamp: timestamp + 2, turnId: 'interview-file-link-turn-1',
      content: '帮我整理这次更新的发布材料，输出成文件。',
    },
    {
      id: 'interview-file-link-2', role: 'assistant', timestamp: timestamp + 3, turnId: 'interview-file-link-turn-1',
      content: '已整理完成，发布材料在 [发布清单.md](file:///Users/demo/Documents/polo-release/发布清单.md)，可直接打开核对。',
    },
  ],
}

/**
 * POO-173 material fixture: the dedicated FileLinkContextMenu component does
 * not exist yet, so the open state is composed from current renderer natives
 * only — ChatDisplay plus the shared ContextMenu primitives and the existing
 * session-menu vocabulary (showInFileManager / copyPath). The demo button
 * replays a real contextmenu event over the rendered file link; menu actions
 * stay local and never touch the backend.
 */
export function InterviewFileLinkScene() {
  const { t, i18n } = useTranslation()
  const [session] = useState(fileLinkSession)
  const isEn = i18n.language?.startsWith('en')
  const openMenu = () => {
    // Markdown sanitizes file: hrefs away (navigation-escape guard), so the
    // file link is the plain inline anchor inside this scene's message flow.
    const link = document.querySelector<HTMLAnchorElement>('section[aria-label="文件链接右键菜单"] .markdown-content a')
    const trigger = document.querySelector<HTMLElement>('[data-slot="context-menu-trigger"]')
    if (!link || !trigger) return
    const rect = link.getBoundingClientRect()
    trigger.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(rect.left + rect.width / 2),
      clientY: Math.round(rect.top + rect.height / 2),
    }))
  }
  return (
    <NavigationProvider workspaceId="playground-workspace" workspaceSlug="playground"
      onCreateSession={async () => { throw new Error('interview fixture: no server session creation') }}>
      <FocusProvider>
        <section className="flex h-screen min-h-0 flex-col" aria-label="文件链接右键菜单">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex flex-1 min-h-0 flex-col">
                <ChatDisplay session={session} currentModel="gpt-6.1-sol" inputValue="" onInputChange={noAction}
                  placeholder={isEn ? 'Type a message' : '输入消息'} permissionMode="ask"
                  onSendMessage={noAction} onOpenFile={noAction} onOpenUrl={noAction}
                  workspaceId="playground-workspace" />
              </div>
            </ContextMenuTrigger>
            <StyledContextMenuContent>
              <StyledContextMenuItem onClick={noAction}>
                <FolderOpen className="h-3.5 w-3.5" />
                <span className="flex-1">{t('sessionMenu.showInFileManager', { fileManager: getFileManagerName() })}</span>
              </StyledContextMenuItem>
              <StyledContextMenuItem onClick={noAction}>
                <Copy className="h-3.5 w-3.5" />
                <span className="flex-1">{t('sessionMenu.copyPath')}</span>
              </StyledContextMenuItem>
            </StyledContextMenuContent>
          </ContextMenu>
          <div className="flex items-center gap-2 px-3 py-2 border-t border-border/40">
            <Button variant="outline" size="sm" data-file-link-demo="open" onClick={openMenu}>
              {isEn ? 'Demo: right-click the file link' : '演示：右键文件链接'}
            </Button>
            <span className="text-xs text-muted-foreground">
              {isEn
                ? 'Fixture replays a contextmenu event; menu actions stay local.'
                : 'Fixture 重放真实 contextmenu 事件；菜单动作仅本地，不连接后端。'}
            </span>
          </div>
        </section>
      </FocusProvider>
    </NavigationProvider>
  )
}
