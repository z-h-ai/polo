import React, { useEffect, useSyncExternalStore } from 'react'
import { getSnapshot, subscribe, navigate } from './runtime/state.js'
import { SourceHomeLauncher } from './source/HomeLauncher.jsx'
import { SourceFaithfulEmptyChat } from './source/EmptyChat.jsx'
import { SourceChatConversation } from './source/ChatConversation.jsx'
import { SourceChatStreaming, SourceChatError, SourceChatDetail } from './source/ChatStreaming.jsx'
import { SourceHomeTabFrame } from './source/HomeTabFrame.jsx'
import { SourcePoloShell } from './source/PoloShell.jsx'
import { SourceAdminLogin } from './source/AdminLogin.jsx'
import { SourceSettingsNavigator, SourceSettingsDetail } from './source/SettingsRegion.jsx'
import { SourceLifecycleRegion } from './source/LifecycleRegion.jsx'
import { SourceOnboardingStep } from './source/OnboardingSteps.jsx'
import { SourceResetConfirmation } from './source/ResetDialog.jsx'
import { SourceBrowserEmptyState } from './source/BrowserEmptyState.jsx'
import { SourceBrowserRegion } from './source/BrowserRegion.jsx'
import { SourceKeyboardShortcutsDialog } from './source/KeyboardShortcutsDialog.jsx'
import { SourceWorkspacePicker } from './source/WorkspacePicker.jsx'
import { SourceOrganizationOnboarding } from './source/OrganizationOnboarding.jsx'
import { SourceOrganizationManage } from './source/OrganizationManage.jsx'
import { SourceResourceEmptyPanel, SourceUnselectedResourceDetail } from './source/ResourceEmptyPanels.jsx'
import { SourceAutomationsList, SourceAutomationDetail } from './source/AutomationsRegion.jsx'
import { SourceSkillsList, SourceSkillDetail, SourceSourcesList, SourceSourceDetail } from './source/ResourceListDetail.jsx'
import { SourceOrganizationAppsSection } from './source/HomeApps.jsx'
import { SourceDesktopAppMenu } from './source/AppMenu.jsx'
import { SourceTelegramConnect, SourceTelegramReconfigure, SourceWhatsAppQr, SourceWhatsAppConnected, SourceLarkConnect, SourcePairingCode, SourceSupergroupPairing } from './source/MessagingDialogs.jsx'
import { SourceSessionNavigator } from './source/SessionSidebar.jsx'
import { SourceSpaceSwitcher } from './source/SpaceSwitcher.jsx'
import { SourcePhoneAuth, SourceApiSetup } from './source/OnboardingAuth.jsx'
import { SourceActiveTasksBar, SourceMultiSelectPanel, SourceBatchSessionMenu, SourceSendToWorkspace, SourceFabNewChat } from './source/EdgePanels.jsx'
import { SourceSessionInfoPopover, SourceFileViewer, SourceFileViewerEmpty } from './source/SessionInfoRegion.jsx'
import { SourceAuthRequestCard, SourceAuthRequestCompleted, SourceAuthRequestCancelled, SourceAuthRequestBasic } from './source/AuthRequestRegion.jsx'

const poloIconSrc = new URL('../assets/renderer/polo-app-icon.png', import.meta.url).href

// Onboarding wizard states route through the OnboardingSteps translation; the
// catalog's welcome/complete/admin states stay on LifecycleRegion.
function OnboardingScene({ state }) {
  if (['git-bash', 'provider-select', 'local-model', 'credentials'].includes(state)) return <SourceOnboardingStep step={state}/>
  return <SourceLifecycleRegion scene="onboarding" state={state}/>
}

function SceneRouter({ query }) {
  if (['splash', 'reauth'].includes(query.scene)) return <SourceLifecycleRegion scene={query.scene} state={query.state}/>
  if (query.scene === 'onboarding') {
    if (query.state === 'phone-auth') return <SourcePhoneAuth state="entry"/>
    if (query.state === 'phone-auth-verify') return <SourcePhoneAuth state="verify"/>
    if (query.state === 'api-setup') return <SourceApiSetup segment="anthropic"/>
    if (query.state === 'api-setup-pi') return <SourceApiSetup segment="pi"/>
    if (query.state === 'copilot-code') return <SourceOnboardingStep step="copilot-code"/>
    if (query.state === 'claude-code') return <SourceOnboardingStep step="claude-code"/>
    return <OnboardingScene state={query.state}/>
  }
  if (query.scene === 'workspace-picker') return <SourceWorkspacePicker state={query.state}/>
  if (query.scene === 'messaging') {
    if (query.state === 'telegram-connect') return <SourceTelegramConnect />
    if (query.state === 'telegram-reconfigure') return <SourceTelegramReconfigure />
    if (query.state === 'whatsapp-qr') return <SourceWhatsAppQr />
    if (query.state === 'whatsapp-connected') return <SourceWhatsAppConnected />
    if (query.state === 'lark-connect') return <SourceLarkConnect />
    if (query.state === 'pairing-code') return <SourcePairingCode />
    return <SourceSupergroupPairing />
  }
  if (query.scene === 'organization') {
    if (['normal', 'members', 'artifacts', 'invitations'].includes(query.state)) return <SourceOrganizationManage state={query.state}/>
    return <SourceOrganizationOnboarding state={query.state}/>
  }
  if (query.scene === 'home' || query.scene === 'enterprise-home') {
    if (query.scene === 'enterprise-home' && query.state === 'organization-apps') return <SourceOrganizationAppsSection/>
    return <SourceHomeLauncher poloIconSrc={poloIconSrc} onOpenPolo={() => navigate({ scene: 'chat', state: 'empty' })}/>
  }
  if (query.scene === 'chat') {
    if (query.state === 'conversation') return <SourceChatConversation/>
    if (query.state === 'streaming') return <SourceChatStreaming/>
    if (query.state === 'error') return <SourceChatError/>
    if (query.state === 'detail') return <SourceChatDetail/>
    if (query.state === 'active-tasks') return <SourceActiveTasksBar/>
    if (query.state === 'auth-request') return <SourceAuthRequestCard/>
    if (query.state === 'auth-request-basic') return <SourceAuthRequestBasic/>
    if (query.state === 'auth-completed') return <SourceAuthRequestCompleted/>
    if (query.state === 'auth-cancelled') return <SourceAuthRequestCancelled/>
    if (query.state === 'fab') return <SourceFabNewChat/>
    return <SourceFaithfulEmptyChat/>
  }
  if (query.scene === 'session-info') {
    if (query.state === 'viewer') return <SourceFileViewer/>
    if (query.state === 'viewer-empty') return <SourceFileViewerEmpty/>
    return <SourceSessionInfoPopover/>
  }
  if (query.scene === 'multi-select') {
    if (query.state === 'menu') return <SourceBatchSessionMenu/>
    return <SourceMultiSelectPanel/>
  }
  if (query.scene === 'send-remote') return <SourceSendToWorkspace state={query.state}/>
  if (query.scene === 'chat-permission') return <SourceFaithfulEmptyChat permission/>
  if (query.scene === 'browser') return <SourceBrowserRegion state={query.state}/>
  if (query.scene === 'app-menu') return <SourceDesktopAppMenu/>
  if (query.scene === 'settings') return <SourceSettingsDetail subpage={query.state}/>
  if (query.scene === 'shortcuts') return <SourceKeyboardShortcutsDialog/>
  if (query.scene === 'reset') return <SourceResetConfirmation/>
  if (query.scene === 'space-switcher') return <SourceSpaceSwitcher state={query.state}/>
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
  if (['browser', 'app-menu', 'organization', 'shortcuts', 'reset', 'space-switcher', 'session-info', 'multi-select', 'send-remote'].includes(query.scene)) return <div className="prototype-root"><SceneRouter query={query}/></div>
  if (query.scene === 'home' || query.scene === 'enterprise-home') return <div className="prototype-root"><SourceHomeTabFrame iconSrc={poloIconSrc}><SceneRouter query={query}/></SourceHomeTabFrame></div>
  if (query.scene === 'chat' || query.scene === 'chat-permission') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc}><SceneRouter query={query}/></SourcePoloShell></div>
  if (query.scene === 'conversations') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceSessionNavigator state={query.state}/>}><SourceFaithfulEmptyChat/></SourcePoloShell></div>
  if (query.scene === 'automations' && query.state === 'detail') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceAutomationsList/>}><SourceAutomationDetail/></SourcePoloShell></div>
  if (query.scene === 'skills' && (query.state === 'list' || query.state === 'detail' || query.state === 'detail-menu')) {
    if (query.state === 'list') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceSkillsList/>}><SourceUnselectedResourceDetail kind="skills"/></SourcePoloShell></div>
    return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceSkillsList/>}><SourceSkillDetail menuOpen={query.state === 'detail-menu'}/></SourcePoloShell></div>
  }
  if (query.scene === 'sources' && (query.state === 'list' || query.state === 'detail' || query.state === 'detail-menu')) {
    if (query.state === 'list') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceSourcesList/>}><SourceUnselectedResourceDetail kind="sources"/></SourcePoloShell></div>
    return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceSourcesList/>}><SourceSourceDetail menuOpen={query.state === 'detail-menu'}/></SourcePoloShell></div>
  }
  if (['sources', 'skills', 'automations'].includes(query.scene)) return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceResourceEmptyPanel kind={query.scene}/>}><SourceUnselectedResourceDetail kind={query.scene}/></SourcePoloShell></div>
  if (query.scene === 'settings') return <div className="prototype-root"><SourcePoloShell iconSrc={poloIconSrc} navigator={<SourceSettingsNavigator selectedSubpage={query.state === 'list' ? 'app' : query.state}/>}><SourceSettingsDetail subpage={query.state}/></SourcePoloShell></div>
  return <div className="prototype-root"><SourceHomeTabFrame iconSrc={poloIconSrc}><SceneRouter query={query}/></SourceHomeTabFrame></div>
}
