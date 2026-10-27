/**
 * product-closure U7 tab-name harness: the production localizedTabTitle
 * resolver over a tab shape restored from an OLD snapshot (zh-Hans literals
 * baked into `title`). Language flips at runtime — no reload — proving the
 * name resolves at RENDER time from the app id, not from the stored string.
 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { localizedTabTitle } from '@/lib/tab-display-name'

await setupI18n([initReactI18next])
const initialLang = new URLSearchParams(window.location.search).get('lang') ?? 'zh-Hans'
await i18n.changeLanguage(initialLang)

// Persisted tab from an old snapshot: the zh-Hans literal is all it has.
const LEGACY_TAB = { appId: 'polo-ai', title: 'Polo 助手', type: 'polo' as const }
const LEGACY_KB = { appId: 'enterprise-knowledge', title: '企业知识库', type: 'knowledge-base' as const }
const THIRD_PARTY = { appId: 'acme-dashboard', title: 'Acme 看板', type: 'webapp' as const }

function Tabs() {
  const { t } = useTranslation()
  const [, setTick] = useState(0)

  useEffect(() => {
    const w = window as unknown as Record<string, unknown>
    w.__tabs = {
      ready: true,
      setLang: async (lang: string) => {
        await i18n.changeLanguage(lang)
        setTick((n) => n + 1)
      },
    }
  }, [])

  return (
    <div style={{ padding: 24 }}>
      <span data-testid="tab-title">{localizedTabTitle(LEGACY_TAB, t)}</span>
      <span data-testid="tab-title-kb">{localizedTabTitle(LEGACY_KB, t)}</span>
      <span data-testid="tab-title-third">{localizedTabTitle(THIRD_PARTY, t)}</span>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<Tabs />)
