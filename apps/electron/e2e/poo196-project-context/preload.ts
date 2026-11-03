/**
 * poo196-project-context fixture preload: exposes ONLY the programmable
 * fixture channels. Every pc* method forwards to the main-process fixture
 * store (`fixture-pc`), which owns latency, fault injection and the asset
 * state machine; the orchestrator reprograms it per scenario.
 *
 * NOTE: an explicit method table, not a Proxy — the Electron context bridge
 * cannot clone a Proxy object ("An object could not be cloned" kills the
 * whole preload). Methods the mounted surface calls but the fixture does not
 * implement meaningfully answer via the generic `fixture-stub` channel; the
 * orchestrator records unexpected calls for evidence.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { toBridgeCarriableError } from '../../src/shared/rpc-error-bridge'

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args)

/** Strips Electron's invoke-rejection prefix and re-carries the embedded
 * polo-rpc-code marker exactly as the production preload bridge does. */
const reCarryCoded = (error: unknown): unknown => {
  const raw = String((error as Error)?.message ?? '')
  const idx = raw.indexOf('polo-rpc-code:')
  if (idx >= 0) {
    return toBridgeCarriableError(new Error(raw.slice(idx)))
  }
  return toBridgeCarriableError(error)
}

const listen = (name: string) => (cb: (...args: unknown[]) => void) => {
  const h = (_: unknown, ...args: unknown[]) => cb(...args)
  ipcRenderer.on(name, h)
  return () => ipcRenderer.removeListener(name, h)
}

// POO-196 project-context channels (LOCAL_ONLY RPC boundary under test).
const pcMethods = [
  'pcListCapabilities', 'pcGetSummary', 'pcListAssets', 'pcGetAsset', 'pcUploadFile',
  'pcUpdateAsset', 'pcSetConfirmed', 'pcSetPinned', 'pcTrashAsset', 'pcRestoreAsset',
  'pcDownloadAsset', 'pcGetPreviewUrl', 'pcReadAsset', 'pcSearchAssets', 'pcRebuild',
]

// POO-196 追加轮 project-members channels (same coded-error bridge as pc*).
const pmMethods = [
  'pmCreateEnterprise', 'pmQueryCreateReceipt', 'pmListProjectMembers',
  'pmListProjectInvitations', 'pmCreateProjectInvitation',
]

// Fixture-owned answers (login state / workspace config boundaries).
const fixtureMethods = [
  'getSessionMessages', 'getSessions', 'getSession', 'sessionCommand', 'searchFiles',
  'readPreferences', 'writePreferences', 'getAutoCapitalisation', 'setAutoCapitalisation',
  'getSpellCheck', 'setSpellCheck', 'getSendMessageKey', 'setSendMessageKey',
  'getPendingPlanExecution', 'getHomeDir', 'openFileDialog', 'readFileBinary',
  'generateThumbnail', 'cancelProcessing', 'getFilePath', 'showInFolder',
  'kbListCollections', 'kbSetSessionCollections', 'adminPaymentHandoff',
  'getWindowFocusState',
  // E2-2: the admin status receipt the copy-link path resolves a
  // root-relative invitation link against (the fixture deployment's trusted
  // admin origin).
  'adminGetStatus',
  // The refresh handover the create-project dialog awaits (created space
  // materializes in the fixture store AFTER pmCreateEnterprise succeeds).
  'productSpaceList',
]

// Neutral answers for the rest of the renderer-used electronAPI surface.
const neutralMethods = [
  'getRuntimeEnvironment', 'getSetupNeeds', 'getWorkspaces', 'getServerStatus',
  'getServerConfig', 'getServerWorkspaces', 'getServerHomeDir', 'getTransportConnectionState',
  'getUnreadSummary', 'getSessionPermissionModeState', 'getDefaultPermissionsConfig',
  'getSourcePermissionsConfig', 'getWorkspacePermissionsConfig', 'getWorkspaceSettings',
  'getSystemWarnings', 'getDismissedUpdateVersion', 'getUpdateInfo', 'getLogoUrl',
  'getAppTheme', 'getNetworkProxySettings', 'getNotificationsEnabled',
  'getTerminalIntegrationStatus', 'getBrowserToolEnabled', 'getTaskOutput',
  'getGenerativeUiCanvasEnabled', 'getGenerativeUiInlineEnabled', 'getGoalProjection',
  'getKeepAwakeWhileRunning', 'getProductSpaceContextStorage', 'getWindowWorkspace',
  'getWindowLaunchContext', 'getWindowFocusState', 'getMcpTools', 'getSkills',
  'getSkillsUnfiltered', 'getSources', 'getStatuses', 'getLabels', 'getStatuses2',
  'listLabels', 'listStatuses', 'listLlmConnectionsWithStatus', 'listManagedSkills',
  'listViews', 'getAutomations', 'getAutomationHistory', 'getAutomationLastExecuted',
  'getEditPopoverPendingQuestion', 'getHomeQuickAccess', 'getAllDrafts',
  'getMessagingConfig', 'getMessagingBindings', 'getMessagingPendingSenders',
  'getMessagingPlatformAccessMode', 'getMessagingPlatformOwners', 'getMessagingSupergroup',
  'getTabBrowserApps', 'getSessionFiles', 'isDebugMode', 'logout', 'openUrl',
  'openFile', 'openSessionInNewWindow', 'debugLog', 'memberCircles',
  'getAllWorkspaceThemes', 'getColorTheme', 'getSystemTheme', 'getWorkspaceColorTheme',
  'loadPresetTheme', 'loadPresetThemes', 'setWorkspaceColorTheme', 'changeLanguage',
  'broadcastThemePreferences', 'broadcastWorkspaceThemeChange',
  'organizationList', 'getRichToolDescriptions', 'setRichToolDescriptions',
  'setDraft', 'setHomeQuickAccess', 'readFile', 'readFileDataUrl', 'readFilePreviewDataUrl',
  'readUserAttachment', 'readWorkspaceImage', 'writeWorkspaceImage', 'storeAttachment',
  'invokeOnServer', 'productSpaceGetCatalog',
]

// Event subscribers: never fire unless the orchestrator emits, always return
// a real unsubscribe.
const eventMethods = [
  'onDeepLinkNavigate', 'onDefaultPermissionsChanged', 'onSystemThemeChange',
  'onThemePreferencesChange', 'onWorkspaceThemeChange', 'onWindowFocusChange',
  'onSessionEvent', 'onReconnected', 'onTransportConnectionStateChanged',
  'onUnreadSummaryChanged', 'onAppThemeChange', 'onUpdateAvailable',
  'onUpdateDownloadProgress', 'onLlmConnectionsChanged', 'onSkillsChanged',
  'onSourcesChanged', 'onStatusesChanged', 'onLabelsChanged', 'onAutomationsChanged',
  'onMenuNewChat', 'onMenuOpenSettings', 'onMenuToggleSidebar', 'onMenuToggleFocusMode',
  'onMenuKeyboardShortcuts', 'onMenuNewWindow', 'onMenuNewWindowFailed',
  'onCloseRequested', 'onNotificationNavigate', 'onBadgeDraw', 'onBadgeDrawWindows',
  'onTransferProgress', 'onCreatorSkillProgress', 'onCopilotDeviceCode',
  'onMessagingBindingChanged', 'onMessagingPendingChanged', 'onMessagingPlatformStatus',
  'onSessionFilesChanged', 'onAdminReauthRequired', 'onWhatsAppEvent',
]

const api: Record<string, unknown> = {
  isChannelAvailable: () => true,
}
for (const method of pcMethods) {
  // Production parity (build-api.ts codedErrors): the trusted side answers
  // with a coded Error. Electron prefixes invoke rejections with
  // "Error invoking remote method '<channel>': " — recover the embedded
  // marker and re-carry it the way the context bridge expects.
  api[method] = async (input: unknown) => {
    try {
      return await invoke('fixture-pc', method, input)
    } catch (error) {
      throw reCarryCoded(error)
    }
  }
}
for (const method of pmMethods) {
  api[method] = async (input: unknown) => {
    try {
      return await invoke('fixture-pm', method, input)
    } catch (error) {
      throw reCarryCoded(error)
    }
  }
}
for (const method of fixtureMethods) {
  api[method] = (...args: unknown[]) => invoke('fixture-stub', method, args)
}
for (const method of neutralMethods) {
  // Neutral answers must NOT forward caller args: some production callers
  // pass non-cloneable payloads (theme preferences with functions), and a
  // failed clone would surface as a renderer-side error.
  api[method] = () => invoke('fixture-stub', method, [])
}
for (const method of eventMethods) {
  api[method] = listen(`stub:${method}`)
}

contextBridge.exposeInMainWorld('electronAPI', api)
