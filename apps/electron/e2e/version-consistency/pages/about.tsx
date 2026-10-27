/**
 * POO-160 version-consistency page. Mounts the PRODUCTION settings surface
 * (`GlobalSettingsSurface` with subpage="app", which renders the real
 * AppSettingsPage including the About section) and reports what the real IPC
 * chain returns. No version string is stubbed anywhere — the number shown is
 * whatever the main process's auto-update module reports.
 *
 * ?lang=zh-Hans — UI language.
 */
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Provider } from 'jotai'
import { setupI18n } from '@polo-ai/shared/i18n'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { ThemeProvider } from '@/context/ThemeContext'
import { FocusProvider } from '@/context/FocusContext'
import { EscapeInterruptProvider } from '@/context/EscapeInterruptContext'
import { DismissibleLayerProvider } from '@/context/DismissibleLayerContext'
import { ModalProvider } from '@/context/ModalContext'
import { NavigationProvider } from '@/contexts/NavigationContext'
import { ActionRegistryProvider } from '@/actions/registry'
import { PlaygroundAppShellProvider } from '@/playground/PlaygroundAppShellProvider'
import { TooltipProvider } from '@polo-ai/ui'
import { GlobalSettingsSurface } from '@/components/app-shell/GlobalSettingsSurface'
import { APP_VERSION } from '@polo-ai/shared/version'
import '@/index.css'

await setupI18n([initReactI18next])
await i18n.changeLanguage(new URLSearchParams(location.search).get('lang') || 'zh-Hans')

function AboutProbe() {
  const [probe, setProbe] = useState<{ ready: boolean }>({ ready: false })

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      window.electronAPI.getUpdateInfo(),
      window.electronAPI.getAppIdentity(),
    ]).then(([info, appVersion]) => {
      if (cancelled) return
      const payload = {
        ready: true,
        // What the settings About row renders (real IPC → main auto-update).
        currentVersion: info.currentVersion,
        // The native app identity (what "About Polo AI" in the app menu shows,
        // and what electron-builder writes into Info.plist).
        appVersion,
        // What the shared bundle inlined from packages/shared/package.json.
        sharedAppVersion: APP_VERSION,
      }
      ;(window as unknown as Record<string, unknown>).__versionProbe = payload
      setProbe({ ready: true })
    })
    return () => { cancelled = true }
  }, [])

  return (
    <div style={{ height: '100vh', position: 'relative' }}>
      <style>{':root{--topbar-height:48px}'}</style>
      <div style={{ position: 'absolute', inset: '48px 0 0 0' }}>
        <GlobalSettingsSurface subpage="app" onSelectSubpage={() => {}} onClose={() => {}} />
      </div>
      {probe.ready ? null : <div data-testid="probe-loading">loading</div>}
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <Provider>
    <TooltipProvider>
      <ThemeProvider defaultMode="light">
        <FocusProvider>
          <ActionRegistryProvider>
            <EscapeInterruptProvider>
              <DismissibleLayerProvider>
                <ModalProvider>
                  <PlaygroundAppShellProvider>
                    <NavigationProvider
                      workspaceId="playground-workspace"
                      workspaceSlug="playground"
                      onCreateSession={async () => null as never}
                      isReady={false}
                    >
                      <AboutProbe />
                    </NavigationProvider>
                  </PlaygroundAppShellProvider>
                </ModalProvider>
              </DismissibleLayerProvider>
            </EscapeInterruptProvider>
          </ActionRegistryProvider>
        </FocusProvider>
      </ThemeProvider>
    </TooltipProvider>
  </Provider>,
)
