/**
 * ToolsSettingsPage
 *
 * AI tool capabilities the assistant may use during sessions.
 *
 * Settings:
 * - Built-in browser tool
 * - Generative UI inline cards / canvas apps
 * - Rich tool descriptions
 *
 * Scope: assistant (user-level; applies across all workspaces).
 * Note: the CLI command → icon mapping stays on the Polo appearance page —
 * it changes visual presentation, not tool availability.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { PanelHeader } from '@/components/app-shell/PanelHeader'
import { ScrollArea } from '@/components/ui/scroll-area'
import { HeaderMenu } from '@/components/ui/HeaderMenu'
import { routes } from '@/lib/navigate'
import type { DetailsPageMeta } from '@/lib/navigation-registry'

import {
  SettingsSection,
  SettingsCard,
  SettingsToggle,
} from '@/components/settings'

export const meta: DetailsPageMeta = {
  navigator: 'settings',
  slug: 'tools',
}

// ============================================
// Main Component
// ============================================

export default function ToolsSettingsPage() {
  const { t } = useTranslation()

  // Tools state
  const [browserToolEnabled, setBrowserToolEnabled] = useState(true)
  const [generativeUiInlineEnabled, setGenerativeUiInlineEnabled] = useState(true)

  const [generativeUiCanvasEnabled, setGenerativeUiCanvasEnabled] = useState(true)

  // Rich tool descriptions state (persisted in config.json, read by SDK subprocess)
  const [richToolDescriptions, setRichToolDescriptions] = useState(true)

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      if (!window.electronAPI) return
      try {
        const [browserToolOn, generativeUiOn, generativeUiCanvasOn, richDescriptionsOn] = await Promise.all([
          window.electronAPI.getBrowserToolEnabled(),
          window.electronAPI.getGenerativeUiInlineEnabled(),
          window.electronAPI.getGenerativeUiCanvasEnabled(),
          window.electronAPI?.getRichToolDescriptions?.() ?? true,
        ])
        setBrowserToolEnabled(browserToolOn)
        setGenerativeUiInlineEnabled(generativeUiOn)
        setGenerativeUiCanvasEnabled(generativeUiCanvasOn)
        setRichToolDescriptions(richDescriptionsOn)
      } catch (error) {
        console.error('Failed to load tools settings:', error)
      }
    }
    loadSettings()
  }, [])

  const handleBrowserToolEnabledChange = useCallback(async (enabled: boolean) => {
    setBrowserToolEnabled(enabled)
    await window.electronAPI.setBrowserToolEnabled(enabled)
  }, [])

  const handleGenerativeUiInlineEnabledChange = useCallback(async (enabled: boolean) => {
    setGenerativeUiInlineEnabled(enabled)
    await window.electronAPI.setGenerativeUiInlineEnabled(enabled)
  }, [])

  const handleGenerativeUiCanvasEnabledChange = useCallback(async (enabled: boolean) => {
    setGenerativeUiCanvasEnabled(enabled)
    await window.electronAPI.setGenerativeUiCanvasEnabled(enabled)
  }, [])

  const handleRichToolDescriptionsChange = useCallback(async (checked: boolean) => {
    setRichToolDescriptions(checked)
    await window.electronAPI?.setRichToolDescriptions?.(checked)
  }, [])

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("settings.tools.title")} actions={<HeaderMenu route={routes.view.settings('tools')} />} />
      <div className="flex-1 min-h-0 mask-fade-y">
        <ScrollArea className="h-full">
          <div className="px-5 py-7 max-w-3xl mx-auto">
            <div className="space-y-8">
              {/* Tool capabilities */}
              <SettingsSection title={t("settings.tools.capabilities")}>
                <SettingsCard>
                  <SettingsToggle
                    label={t("settings.tools.builtInBrowser")}
                    description={t("settings.tools.builtInBrowserDesc")}
                    checked={browserToolEnabled}
                    onCheckedChange={handleBrowserToolEnabledChange}
                  />
                  <SettingsToggle
                    label={t("settings.tools.generativeUiInline")}
                    description={t("settings.tools.generativeUiInlineDesc")}
                    checked={generativeUiInlineEnabled}
                    onCheckedChange={handleGenerativeUiInlineEnabledChange}
                  />
                  <SettingsToggle
                    label={t("settings.tools.generativeUiCanvas")}
                    description={t("settings.tools.generativeUiCanvasDesc")}
                    checked={generativeUiCanvasEnabled}
                    onCheckedChange={handleGenerativeUiCanvasEnabledChange}
                  />
                  <SettingsToggle
                    label={t("settings.tools.richToolDescriptions")}
                    description={t("settings.tools.richToolDescriptionsDesc")}
                    checked={richToolDescriptions}
                    onCheckedChange={handleRichToolDescriptionsChange}
                  />
                </SettingsCard>
              </SettingsSection>
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  )
}
