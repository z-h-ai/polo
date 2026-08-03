import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { createRoot, type Root } from 'react-dom/client'
import { initReactI18next } from 'react-i18next'
import { ArrowUp, PanelLeft, Plus, Sparkles } from 'lucide-react'
import { i18n, setupI18n } from '@z-h-ai/shared/i18n'
import { TabShell } from '@/components/tab-browser/TabShell'
import { Button } from '@/components/ui/button'
import { MockTabShellProvider, useTabShell } from '@/context/TabShellContext'
import { POLO_APP_DEFINITION } from '@tab-browser-types'
import '@/index.css'

setupI18n([initReactI18next])

const query = new URLSearchParams(window.location.search)
const page = query.get('page') === 'after' ? 'after' : 'before'
const language = query.get('lang') === 'en' ? 'en' : 'zh-Hans'
const theme = query.get('theme') === 'dark' ? 'dark' : 'light'

void i18n.changeLanguage(language)
document.documentElement.lang = language
document.documentElement.classList.toggle('dark', theme === 'dark')
document.documentElement.dataset.theme = theme
document.documentElement.dataset.prototypePage = page

localStorage.setItem('craft-home-recent-apps', JSON.stringify([
  { id: 'polo-ai', kind: 'builtin', openedAt: 3 },
  { id: 'kanban', kind: 'builtin', openedAt: 2 },
  { id: 'airdrop', kind: 'builtin', openedAt: 1 },
]))

Object.assign(window, {
  electronAPI: {
    onDeepLinkNavigate: () => () => {},
  },
})

const strings = language === 'zh-Hans'
  ? {
      ask: '问问 Pro Buddy',
      placeholder: '想做什么?',
      hint: 'Enter 进入新对话',
      newChat: '新对话',
      empty: '开始一段新对话',
      inputPlaceholder: '输入消息...',
    }
  : {
      ask: 'Ask Pro Buddy',
      placeholder: 'What would you like to work on?',
      hint: 'Enter to open a new chat',
      newChat: 'New chat',
      empty: 'Start a new conversation',
      inputPlaceholder: 'Type a message...',
    }

function QuestionEntry() {
  const [value, setValue] = useState('')
  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    const input = value.trim()
    if (!input) return
    window.dispatchEvent(new CustomEvent('prototype:new-chat', {
      detail: { input },
    }))
  }

  return (
    <section
      className="titlebar-no-drag"
      aria-label={strings.ask}
      data-testid="home-question-entry"
    >
      <div className="mb-3 flex items-center gap-2 px-1 text-sm font-medium text-foreground/70">
        <Sparkles className="size-4" strokeWidth={1.5} />
        <span>{strings.ask}</span>
      </div>
      <form
        className="input-container relative flex min-h-[88px] items-end gap-3 overflow-hidden rounded-[12px] bg-background p-4 shadow-minimal transition-shadow focus-within:shadow-middle"
        onSubmit={submit}
      >
        <textarea
          className="min-h-12 max-h-32 min-w-0 flex-1 resize-none border-0 bg-transparent text-base leading-6 text-foreground outline-none placeholder:text-foreground/40"
          rows={2}
          value={value}
          placeholder={strings.placeholder}
          onChange={event => setValue(event.target.value)}
          data-testid="home-question-input"
        />
        <Button
          type="submit"
          size="icon"
          className="size-7 shrink-0 rounded-full"
          disabled={!value.trim()}
          aria-label={strings.newChat}
          data-testid="home-question-submit"
        >
          <ArrowUp className="size-4" />
        </Button>
      </form>
      <p className="mt-2 px-1 text-right text-[11px] text-foreground/40">
        {strings.hint}
      </p>
    </section>
  )
}

function AfterAugmentation() {
  useEffect(() => {
    if (page !== 'after') return
    const content = document.querySelector<HTMLElement>(
      '[data-testid="home-app-hub"] > div',
    )
    if (!content || content.querySelector('[data-review-question-root]')) return
    const mount = document.createElement('div')
    mount.dataset.reviewQuestionRoot = 'true'
    content.prepend(mount)
    const root: Root = createRoot(mount)
    root.render(<QuestionEntry />)
    return () => {
      root.unmount()
      mount.remove()
    }
  }, [])
  return null
}

function NewChatSurface({ draft }: { draft: string }) {
  return (
    <div className="relative flex h-full min-h-0 bg-background text-foreground">
      <header className="fixed left-0 right-0 z-titlebar flex h-[var(--topbar-height)] items-center gap-2 border-b border-foreground/8 bg-background/95 px-4" style={{ top: 'var(--tabbar-height)' }}>
        <Button variant="ghost" size="icon" className="size-8 rounded-md">
          <PanelLeft className="size-4" />
        </Button>
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4" strokeWidth={1.5} />
          Pro Buddy
        </div>
      </header>
      <aside className="hidden w-60 shrink-0 border-r border-foreground/8 px-3 py-4 md:block">
        <Button variant="secondary" className="w-full justify-start">
          <Plus className="size-4" />
          {strings.newChat}
        </Button>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <span className="flex size-12 items-center justify-center rounded-xl bg-foreground/4">
            <Sparkles className="size-6 text-foreground/65" strokeWidth={1.5} />
          </span>
          <h1 className="text-lg font-semibold">{strings.empty}</h1>
        </div>
        <div className="mx-auto w-full max-w-[760px] px-4 pb-6">
          <div className="input-container relative min-h-[96px] overflow-hidden rounded-[12px] bg-background p-4 shadow-middle">
            <p className="min-h-12 whitespace-pre-wrap text-sm leading-6 text-foreground">
              {draft || strings.inputPlaceholder}
            </p>
            <div className="mt-2 flex justify-end">
              <Button size="icon" className="size-7 rounded-full" disabled={!draft}>
                <ArrowUp className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

function HarnessContent() {
  const { openApp } = useTabShell()
  const [draft, setDraft] = useState('')

  useEffect(() => {
    const openNewChat = (event: Event) => {
      const custom = event as CustomEvent<{ input?: string }>
      setDraft(custom.detail?.input ?? '')
      openApp(POLO_APP_DEFINITION)
    }
    window.addEventListener('prototype:new-chat', openNewChat)
    return () => window.removeEventListener('prototype:new-chat', openNewChat)
  }, [openApp])

  return (
    <>
      <TabShell renderPolo={() => <NewChatSurface draft={draft} />} />
      <AfterAugmentation />
    </>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MockTabShellProvider>
      <HarnessContent />
    </MockTabShellProvider>
  </React.StrictMode>,
)
