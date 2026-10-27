/**
 * Fixture preload: exposes ONLY the IPC fixture channels (browserPane bridge
 * + the U12 destroy-all channel + canned electronAPI stubs). No production
 * preload logic.
 */
import { contextBridge, ipcRenderer } from 'electron'

const listen = (name: string) => (cb: (...args: unknown[]) => void) => {
  const h = (_: unknown, ...args: unknown[]) => cb(...args)
  ipcRenderer.on(name, h)
  return () => ipcRenderer.removeListener(name, h)
}

const browserMethods = [
  'create', 'destroy', 'list', 'navigate', 'goBack', 'goForward', 'reload', 'stop', 'focus',
  'embed', 'detachToPopup', 'setEmbedBounds', 'unembed', 'hide', 'setElementPicking',
]
const browserPane: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
for (const method of browserMethods) {
  browserPane[method] = (...args: unknown[]) => ipcRenderer.invoke('fixture-browser', method, ...args)
}
Object.assign(browserPane, {
  onStateChanged: listen('state'),
  onRemoved: listen('removed'),
  onInteracted: listen('interacted'),
  onElementPickerEvent: listen('picker'),
  onOpenRequested: listen('open'),
  // product-closure U11: terminal download outcome for the renderer toast.
  onDownloadEvent: listen('download'),
})

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

// Event-subscriber stubs: never fire, but return a real unsubscribe.
const eventStubs: Record<string, (cb: (...args: unknown[]) => void) => () => void> = {}
for (const name of [
  'onDeepLinkNavigate', 'onDefaultPermissionsChanged', 'onSystemThemeChange',
  'onThemePreferencesChange', 'onWorkspaceThemeChange',
]) {
  eventStubs[name] = listen(`stub:${name}`)
}

contextBridge.exposeInMainWorld('electronAPI', {
  browserPane,
  isChannelAvailable: () => true,
  showInFolder: (...args: unknown[]) => ipcRenderer.invoke('fixture-show-in-folder', ...args),
  // product-closure U12: the logout teardown channel under test.
  browserPaneDestroyAll: () => ipcRenderer.invoke('fixture-destroy-all'),
  ...eventStubs,
  ...stubs,
})
