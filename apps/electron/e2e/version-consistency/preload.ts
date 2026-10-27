/**
 * Fixture preload for the POO-160 version harness.
 *
 * The update channels are NOT stubbed: getUpdateInfo invokes the real
 * main-process probe, which answers from the production auto-update module.
 * Everything else the settings page touches is a canned fixture.
 */
import { contextBridge, ipcRenderer } from 'electron'

const listen = (name: string) => (cb: (...args: unknown[]) => void) => {
  const h = (_: unknown, ...args: unknown[]) => cb(...args)
  ipcRenderer.on(name, h)
  return () => ipcRenderer.removeListener(name, h)
}

// Real-chain channels.
const update = {
  getUpdateInfo: () => ipcRenderer.invoke('probe-update-info').then((r: { updateInfo: unknown }) => r.updateInfo),
  getAppIdentity: () => ipcRenderer.invoke('probe-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('probe-check-updates'),
  onUpdateAvailable: listen('stub:onUpdateAvailable'),
  onUpdateDownloadProgress: listen('stub:onUpdateDownloadProgress'),
}

const stubMethods = [
  'getRuntimeEnvironment', 'getNotificationsEnabled', 'setNotificationsEnabled',
  'getKeepAwakeWhileRunning', 'setKeepAwakeWhileRunning',
  'getNetworkProxySettings', 'setNetworkProxySettings',
  'getTerminalIntegrationStatus', 'installTerminalIntegration', 'uninstallTerminalIntegration',
  'getAutoCapitalisation', 'getSendMessageKey', 'getSpellCheck',
  'readPreferences', 'writePreferences', 'openUrl',
  'getDismissedUpdateVersion', 'dismissUpdate', 'installUpdate',
]
const stubs: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
for (const name of stubMethods) {
  stubs[name] = (...args: unknown[]) => ipcRenderer.invoke('fixture-stub', name, args)
}

const eventStubs: Record<string, (cb: (...args: unknown[]) => void) => () => void> = {}
for (const name of ['onDeepLinkNavigate', 'onDefaultPermissionsChanged', 'onSystemThemeChange']) {
  eventStubs[name] = listen(`stub:${name}`)
}

contextBridge.exposeInMainWorld('electronAPI', {
  isChannelAvailable: () => true,
  ...update,
  ...eventStubs,
  ...stubs,
})
