/**
 * Fixture preload for the POO-161 canvas-recovery harness: exposes ONLY the
 * IPC fixture channels (GenUi card registry stubs + canned electronAPI).
 * No production preload logic — mirrors e2e/poo-batch-20261027/preload.ts.
 */
import { contextBridge, ipcRenderer } from 'electron'

const listen = (name: string) => (cb: (...args: unknown[]) => void) => {
  const h = (_: unknown, ...args: unknown[]) => cb(...args)
  ipcRenderer.on(name, h)
  return () => ipcRenderer.removeListener(name, h)
}

const stubMethods = [
  'getTabBrowserApps', 'saveTabBrowserApps', 'appendGenUiAudit', 'organizationList',
  'packageGenUiAppArtifact', 'creatorAppPublish', 'registerGenUiCard', 'unregisterGenUiCard',
  'getRuntimeEnvironment',
  'broadcastThemePreferences', 'broadcastWorkspaceThemeChange', 'getAllWorkspaceThemes',
  'getColorTheme', 'getSystemTheme', 'getWorkspaceColorTheme', 'loadPresetTheme',
  'loadPresetThemes', 'setWorkspaceColorTheme', 'changeLanguage',
  'getRichToolDescriptions', 'setRichToolDescriptions', 'openUrl',
  'getAutoCapitalisation', 'setAutoCapitalisation', 'getSendMessageKey', 'setSendMessageKey',
  'getSpellCheck', 'setSpellCheck', 'readPreferences', 'writePreferences',
  'getPendingPlanExecution', 'getHomeRecentApps', 'setHomeRecentApps',
]
const stubs: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
for (const name of stubMethods) {
  stubs[name] = (...args: unknown[]) => ipcRenderer.invoke('fixture-stub', name, args)
}

const eventStubs: Record<string, (cb: (...args: unknown[]) => void) => () => void> = {}
for (const name of [
  'onDeepLinkNavigate', 'onDefaultPermissionsChanged', 'onSystemThemeChange',
  'onThemePreferencesChange', 'onWorkspaceThemeChange',
]) {
  eventStubs[name] = listen(`stub:${name}`)
}

contextBridge.exposeInMainWorld('electronAPI', {
  isChannelAvailable: () => true,
  onAuditRecorded: listen('audit-recorded'),
  ...eventStubs,
  ...stubs,
})
