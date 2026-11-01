/**
 * Fixture preload: exposes ONLY the IPC fixture channels (browserPane bridge +
 * canned electronAPI stubs). No production preload logic.
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
  canvasPane: {
    ...Object.fromEntries(['embed','unembed','hide','destroy','release','detachToPopup','attachFromPopup','focus'].map(m => [m, (...a: unknown[]) => ipcRenderer.invoke('fixture-canvas', m, ...a)])),
    onStateChanged: listen('canvas-state'),
  },
  isChannelAvailable: () => true,
  onAuditRecorded: listen('audit-recorded'),
  ...eventStubs,
  ...stubs,
})
