import React, { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import ReactDOM from 'react-dom/client'
import { BrowserEmptyStateCard } from '@polo-ai/ui'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { initReactI18next } from 'react-i18next'
import { routes } from '../shared/routes'
import { EMPTY_STATE_PROMPT_SAMPLES } from './components/browser/empty-state-prompts'
import './index.css'

/* ------------------------------------------------------------------ */
/*  i18n (product-closure U6)                                          */
/* ------------------------------------------------------------------ */

// Same discipline as browser-toolbar.tsx: this is an independent renderer
// entry inside the persist:browser-pane partition — without the init every
// useTranslation call warns and the strings degrade to raw keys (LV-E01).
// Synchronous init BEFORE the first render; the UI language rides the
// ?lang= query (main passes it in loadEmptyStatePage) because this
// partition's localStorage is not shared with the main window.
setupI18n([initReactI18next])
const EMPTY_STATE_QUERY_LANG = new URLSearchParams(window.location.search).get('lang')
void i18n.changeLanguage(EMPTY_STATE_QUERY_LANG ?? 'zh-Hans')

function BrowserEmptyStateApp() {
  const { t } = useTranslation()
  const handlePromptSelect = useCallback(async (fullPrompt: string) => {
    const route = routes.action.newSession({ input: fullPrompt, send: true })
    const token = String(Date.now())

    try {
      if (window.electronAPI?.browserPane?.emptyStateLaunch) {
        await window.electronAPI.browserPane.emptyStateLaunch({ route, token })
        return
      }
    } catch {
      // Fallback to hash-signaling below if IPC route fails for any reason.
    }

    const launchParams = new URLSearchParams({ route, ts: token })
    window.location.hash = `launch=${launchParams.toString()}`
  }, [])

  return (
    <div className="h-screen w-screen bg-foreground-2 overflow-hidden">
      <div className="h-full w-full bg-background overflow-auto">
        <BrowserEmptyStateCard
          title={t("browser.readyTitle")}
          description={t("browser.readyDescription")}
          prompts={EMPTY_STATE_PROMPT_SAMPLES}
          showExamplePrompts={true}
          showSafetyHint={true}
          onPromptSelect={(sample) => handlePromptSelect(sample.full)}
        />
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserEmptyStateApp />
  </React.StrictMode>,
)
