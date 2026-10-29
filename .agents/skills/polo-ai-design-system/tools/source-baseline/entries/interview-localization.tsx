/** Real component compositions for POO-179. No product copy, grants or styles live here. */
import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import i18n from 'i18next'
import { useTranslation } from 'react-i18next'
import { ChatDisplay } from '@/components/app-shell/ChatDisplay'
import { SettingsMenuSelect } from '@/components/settings/SettingsMenuSelect'
import { ServerDirectoryBrowser } from '@/components/ServerDirectoryBrowser'
import AppearanceSettingsPage from '@/pages/settings/AppearanceSettingsPage'
import { ReauthScreen } from '@/components/onboarding/ReauthScreen'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { FocusProvider } from '@/context/FocusContext'
import { MarkdownDatatableBlock, PlatformProvider } from '@polo-ai/ui'
import type { Session, Message, PermissionRequest, CredentialRequest } from '../../../../../../apps/electron/src/shared/types'
import type { BaselineScene } from './scenes'

const timestamp = Date.UTC(2026, 9, 28, 12)
const sessionId = 'localization-session'
const rawPath = '/fixture/work/原名 Report.md'
const table = {
  title: 'Fixture Orders',
  columns: [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'amount', label: 'Amount', type: 'number' },
    { key: 'active', label: 'Active', type: 'boolean' },
  ],
  rows: [
    { date: '2026-10-28', amount: 120, active: true },
    { date: '2026-10-29', amount: 75, active: false },
  ],
}

type FixtureEvent = { action: string; args: unknown[] }
type FixtureControl = {
  caseId: string
  events: FixtureEvent[]
  snapshot: () => unknown
  changeLanguage: (language: string) => Promise<unknown>
  setProcessing: (processing: boolean) => void
  arrangePermission: (request: PermissionRequest & { canRememberForSession?: boolean }) => void
  arrangeCredential: (request: CredentialRequest) => void
}
declare global { interface Window { __LOCALIZATION_FIXTURE__?: FixtureControl } }

function message(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return { id, role, content, timestamp, ...extra }
}
function initialSession(caseId: string): Session {
  const messages: Message[] = [
    message('fixture-user', 'user', '请保留 English user content、路径与原始数据。'),
    message('fixture-assistant', 'assistant', 'Fixture user content', { turnId: 'localization-turn' }),
  ]
  if (caseId === 'tool-path-menu') {
    messages.push(message('fixture-read', 'tool', '1: Fixture user content\n2: 原始文件内容', {
      turnId: 'localization-turn', toolName: 'Read', toolUseId: 'localization-read',
      toolInput: { file_path: rawPath }, toolStatus: 'completed',
    }))
  }
  if (caseId === 'turn-executing') {
    messages.push(message('fixture-todo', 'tool', 'Todo list updated successfully', {
      turnId: 'localization-turn', toolName: 'TodoWrite', toolUseId: 'localization-todo',
      toolInput: { todos: [
        { id: 'fixture-todo-1', content: '用户任务 English item', status: 'in_progress', activeForm: '处理用户任务' },
        { id: 'fixture-todo-2', content: '保留原数据', status: 'pending', activeForm: '保留原数据' },
      ] }, toolStatus: 'executing',
    }))
  }
  return {
    id: sessionId, workspaceId: 'playground-workspace', workspaceName: 'Playground',
    name: '原始会话 Fixture', lastMessageAt: timestamp, isProcessing: caseId === 'turn-executing', messages,
    ...(caseId === 'context-ready' ? { tokenUsage: { inputTokens: 139500, contextWindow: 200000, outputTokens: 0, totalTokens: 139500, contextTokens: 139500, costUsd: 0 } } : {}),
  }
}

/** Providers/callback boundaries match the existing InterviewScrollScene. */
function ChatHost({ children }: { children: ReactNode }) {
  return <NavigationProvider workspaceId="playground-workspace" workspaceSlug="playground"
    onCreateSession={async () => { throw new Error('localization fixture forbids server session creation') }}>
    <FocusProvider>{children}</FocusProvider>
  </NavigationProvider>
}

export function InterviewLocalizationScene({ caseId }: { caseId: string }) {
  const { t } = useTranslation()
  const [session, setSession] = useState(() => initialSession(caseId))
  const [draft, setDraft] = useState('用户草稿 Draft179')
  const events = useMemo<FixtureEvent[]>(() => [], [])
  const record = (action: string, ...args: unknown[]) => { events.push({ action, args }) }
  const [settingValue, setSettingValue] = useState('fixture-0')
  const [remoteOpen, setRemoteOpen] = useState(true)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [permission, setPermission] = useState<PermissionRequest | undefined>(() => {
    if (!caseId.startsWith('permission-')) return undefined
    // Existing clients ignore this optional presentation field. It grants nothing.
    const request: PermissionRequest & { canRememberForSession?: boolean } = {
      requestId: 'localization-permission', sessionId, toolName: 'Bash', type: 'bash',
      command: 'npm install fixture-package --ignore-scripts', description: 'Execute: npm install fixture-package --ignore-scripts',
      canRememberForSession: caseId === 'permission-known',
    }
    return request
  })
  const [credential, setCredential] = useState<CredentialRequest | undefined>(() => caseId === 'credential-filled' ? {
    type: 'credential', requestId: 'localization-credential', sessionId, sourceSlug: 'fixture-api', sourceName: 'Fixture API',
    mode: 'basic', passwordRequired: false,
  } : undefined)

  useEffect(() => {
    const value: FixtureControl = {
      caseId, events,
      snapshot: () => ({ session, draft, permission, credential, settingValue, selectedPath, table }),
      changeLanguage: language => i18n.changeLanguage(language),
      setProcessing: isProcessing => setSession(previous => ({ ...previous, isProcessing })),
      arrangePermission: request => setPermission(request),
      arrangeCredential: request => setCredential(request),
    }
    window.__LOCALIZATION_FIXTURE__ = value
    return () => { if (window.__LOCALIZATION_FIXTURE__ === value) delete window.__LOCALIZATION_FIXTURE__ }
  }, [caseId, events, session, draft, permission, credential, settingValue, selectedPath])

  useLayoutEffect(() => {
    if (caseId !== 'remote-empty') return
    const api = window.electronAPI
    const previousList = api.listServerDirectory
    const previousHome = api.getServerHomeDir
    api.listServerDirectory = async path => {
      record('listServerDirectory', path)
      return { currentPath: '/fixture/work', parentPath: '/fixture', platform: 'darwin', breadcrumbs: [{ name: 'work', path: '/fixture/work' }], entries: [], truncated: false, totalEntries: 0 }
    }
    api.getServerHomeDir = async () => '/fixture/work'
    return () => { api.listServerDirectory = previousList; api.getServerHomeDir = previousHome }
  }, [caseId, events])

  const content = caseId === 'table-expanded' ? (
    <PlatformProvider actions={{
      onCopyToClipboard: async text => { record('copy', text) },
      onReadFile: async path => { record('readFile', path); throw new Error('Fixture has inline data only') },
    }}>
      <div className="mx-auto max-w-3xl px-5 py-8"><MarkdownDatatableBlock code={JSON.stringify(table)} enableColumnFilters /></div>
    </PlatformProvider>
  ) : caseId === 'settings-no-results' ? (
    <div className="mx-auto max-w-3xl px-5 py-8"><SettingsMenuSelect
      value={settingValue} searchable options={Array.from({ length: 9 }, (_, index) => ({ value: `fixture-${index}`, label: `Fixture option ${index}` }))}
      onValueChange={value => { record('settingValue', value); setSettingValue(value) }}
    /></div>
  ) : caseId === 'settings-language' ? <AppearanceSettingsPage />
    : caseId === 'reauth-error' ? <ReauthScreen onLogin={async () => { record('login'); throw 'fixture non-Error' }} onReset={() => record('reset')} />
    : caseId === 'remote-empty' ? <ServerDirectoryBrowser open={remoteOpen} mode="browse" initialPath="/fixture/work"
      onSelect={path => { record('selectPath', path); setSelectedPath(path) }}
      onCancel={() => { record('cancelDirectory'); setRemoteOpen(false) }} />
    : <ChatHost><ChatDisplay
      session={session} currentModel="gpt-6.1-sol" inputValue={draft} onInputChange={setDraft}
      // The product's default placeholder list is shuffled per mount and rotates on
      // a timer, which makes a frozen deterministic reference impossible. Pinning one
      // localized entry through the existing placeholder prop keeps the capture
      // reproducible; the rotation itself is already localized in every language.
      placeholder={t('chatInput.placeholder.workOn')}
      permissionMode="ask" pendingPermission={permission} pendingCredential={credential}
      onRespondToPermission={(...args) => { record('permissionResponse', ...args); setPermission(undefined) }}
      onRespondToCredential={(...args) => { record('credentialResponse', ...args); setCredential(undefined) }}
      onSendMessage={(...args) => record('sendMessage', ...args)}
      onOpenFile={path => record('openFile', path)} onOpenUrl={url => record('openUrl', url)}
      workspaceId="playground-workspace"
    /></ChatHost>

  return <PlatformProvider actions={{
    onOpenFileExternal: path => record('openFileExternal', path),
    onRevealInFinder: path => record('revealInFinder', path),
    onOpenFile: path => record('openFile', path),
    onOpenUrl: url => record('openUrl', url),
    onCopyToClipboard: async text => { record('copy', text) },
    fileManagerName: 'Finder',
  }}><section className="flex h-screen min-h-0 flex-col" data-localization-case={caseId}>{content}</section></PlatformProvider>
}

const cases = [
  ['context', 'context-ready'], ['permission', 'permission-known'], ['permission', 'permission-unsupported'],
  ['credential', 'credential-filled'], ['table', 'table-expanded'], ['overlay', 'tool-path-menu'],
  ['turn', 'turn-executing'], ['settings', 'settings-no-results'], ['remote', 'remote-empty'],
] as const

export const localizationScenes: BaselineScene[] = cases.flatMap(([name, caseId]) => {
  const languages = name === 'permission' ? [caseId === 'permission-known' ? 'zh-Hans' : 'en']
    : ['context', 'credential', 'table'].includes(name) ? ['zh-Hans', 'en'] : ['zh-Hans']
  return languages.map(language => ({
    id: `interview-localization-${name}-${language}`, region: '助手', title: `POO-179 ${caseId} (${language})`, fullBleed: true,
    note: 'Current real component and fixed data only. System copy is not yet complete; no permission behavior is implemented by this fixture.',
    render: () => <InterviewLocalizationScene caseId={caseId} />,
  }))
})

// Functional-only real hosts; they do not add formal visual inventory or product controls.
localizationScenes.push(
  { id: 'interview-localization-settings-language', region: '设置', title: 'POO-179 real language menu', fullBleed: true,
    note: 'Real AppearanceSettingsPage language menu on local fixture data only; changing it exercises the product i18n path, not a completed localization.',
    render: () => <InterviewLocalizationScene caseId="settings-language" /> },
  { id: 'interview-localization-reauth-error', region: '登录', title: 'POO-179 real reauthentication failure', fullBleed: true,
    note: 'Real ReauthScreen with an in-memory non-Error login failure; original diagnostics stay untouched and no account action is simulated.',
    render: () => <InterviewLocalizationScene caseId="reauth-error" /> },
)
