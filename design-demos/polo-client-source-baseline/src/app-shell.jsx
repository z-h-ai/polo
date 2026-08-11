import React, { useEffect, useSyncExternalStore } from 'react'
import { getSnapshot, subscribe, navigate } from './runtime/state.js'
import { SourceHomeLauncher } from './source/HomeLauncher.jsx'
import { SourceFaithfulEmptyChat } from './source/EmptyChat.jsx'
import { SourceHomeTabFrame } from './source/HomeTabFrame.jsx'
import { SourcePoloShell } from './source/PoloShell.jsx'
import { SourceAdminLogin } from './source/AdminLogin.jsx'
import { SettingsRegion } from './source/SettingsRegion.jsx'
import { SourceLifecycleRegion } from './source/LifecycleRegion.jsx'
import { SourceResetConfirmation } from './source/ResetDialog.jsx'
import { SourceBrowserEmptyState } from './source/BrowserEmptyState.jsx'
import { SourceKeyboardShortcutsDialog } from './source/KeyboardShortcutsDialog.jsx'
import { SourceWorkspacePicker } from './source/WorkspacePicker.jsx'
import { SourceOrganizationOnboarding } from './source/OrganizationOnboarding.jsx'
import { SourceResourceEmptyPanel, SourceUnselectedResourceDetail } from './source/ResourceEmptyPanels.jsx'
import { SourceDesktopAppMenu } from './source/AppMenu.jsx'

const poloIconSrc = new URL('../assets/renderer/polo-app-icon.png', import.meta.url).href

function SceneRouter({ query }) {
  if (['splash', 'onboarding', 'reauth'].includes(query.scene)) return <SourceLifecycleRegion scene={query.scene} state={query.state}/>
  if (query.scene === 'workspace-picker') return <SourceWorkspacePicker state={query.state}/>
  if (query.scene === 'organization') return <SourceOrganizationOnboarding state={query.state}/>
  if (query.scene === 'home' || query.scene === 'enterprise-home') return <SourceHomeLauncher poloIconSrc={poloIconSrc} onOpenPolo={() => navigate({ scene: 'chat', state: 'empty' })}/>
  if (query.scene === 'chat' || query.scene === 'chat-permission') return <SourceFaithfulEmptyChat/>
  if (query.scene === 'browser') return <SourceBrowserEmptyState/>
  if (query.scene === 'app-menu') return <SourceDesktopAppMenu/>
  if (query.scene === 'settings') return <SettingsRegion/>
  if (query.scene === 'shortcuts') return <SourceKeyboardShortcutsDialog/>
  if (query.scene === 'reset') return <SourceResetConfirmation/>
  return <SourceHomeLauncher poloIconSrc={poloIconSrc} onOpenPolo={() => navigate({ scene: 'chat', state: 'empty' })}/>
}

export function App() {
  const query = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const ready = !['splash', 'onboarding', 'reauth', 'workspace-picker'].includes(query.scene) && !(query.scene === 'organization' && ['loading', 'join', 'create', 'select'].includes(query.state))
  useEffect(() => {
    document.documentElement.dataset.theme = query.theme
    document.documentElement.lang = query.lang
  }, [query.theme, query.lang])
  if (query.scene === 'onboarding' && query.state === 'admin-login') return <div className="prototype-root"><SourceAdminLogin/></div>
  if (!ready) return <div className="prototype-root"><SceneRouter query={query}/></div>
  if (['browser', 'app-menu', 'organization', 'shortcuts', 'reset'].includes(query.scene)) return <div className="prototype-root"><SceneRouter query={query}/></div>
  if (query.scene === 'home' || query.scene === 'enterprise-home') return <div className="prototype-root"><SourceHomeTabFrame iconSrc={poloIconSrc}><SceneRouter query={query}/></SourceHomeTabFrame></div>
  if (query.scene === 'chat' || query.scene === 'chat-permission') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc}><SceneRouter query={query}/></SourcePoloShell></div>
  if (['sources', 'skills', 'automations'].includes(query.scene)) return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceResourceEmptyPanel kind={query.scene}/>}><SourceUnselectedResourceDetail/></SourcePoloShell></div>
  if (query.scene === 'settings') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={false}><SceneRouter query={query}/></SourcePoloShell></div>
  return <div className="prototype-root"><SourceHomeTabFrame iconSrc={poloIconSrc}><SceneRouter query={query}/></SourceHomeTabFrame></div>
}
