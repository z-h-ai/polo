import { mockElectronAPI } from '../mock-utils'

/**
 * Composable electronAPI mock extension for playground demos.
 *
 * `playground/mock-utils.ts` already injects a base mock `window.electronAPI`
 * on import. When a demo needs additional channels (e.g. a `spaceSwitch.*`
 * IPC shape), it calls this helper with just those channels instead of
 * editing mock-utils. Later calls win, so demos can override per variant.
 */
export function extendMockElectronAPI(channels: Record<string, unknown>): void {
  const win = window as unknown as { electronAPI?: Record<string, unknown> }
  if (!win.electronAPI) {
    win.electronAPI = mockElectronAPI as Record<string, unknown>
  }
  Object.assign(win.electronAPI, channels)
}
