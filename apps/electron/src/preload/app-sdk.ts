import { contextBridge, ipcRenderer } from 'electron'
import { SDK_CHANNEL, SDK_STATUS_CHANNEL, validCallId, validQuery } from '../../../../packages/sdk/src/protocol'
import type { AppSdkHost, HostInfo, PoloResult, Reply } from '../../../../packages/sdk/src/protocol'
// Main supplies this one-use attach ticket only to the isolated preload argv.
// Electron omits preload/additionalArguments from getLastWebPreferences().
const attachNonce = process.argv.find(value => value.startsWith('--polo-app-sdk-attach='))?.slice('--polo-app-sdk-attach='.length)
const unavailable = (): Reply<never> => ({ ok: false, error: { code: 'host_unavailable' } })
const invoke = async <T>(request: unknown): Promise<Reply<T>> => {
  try { return await ipcRenderer.invoke(SDK_CHANNEL, request, attachNonce) as Reply<T> } catch { return unavailable() }
}
const host: AppSdkHost = {
  info: async () => {
    // Initial preload can precede did-attach/dom-ready. Bounded, read-only handshake.
    for (let attempt = 0; attempt < 40; attempt++) {
      const result = await invoke<HostInfo>({ action: 'info' })
      if (result.ok || result.error.code !== 'capability_invalid') return result
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    return unavailable()
  },
  start: (callId, input) => validCallId(callId) && validQuery(input)
    ? invoke<PoloResult>({ action: 'start', callId, input })
    : Promise.resolve({ ok: false, error: { code: 'invalid_request' } }),
  cancel: callId => validCallId(callId) ? invoke({ action: 'cancel', callId }) : Promise.resolve({ ok: false, error: { code: 'invalid_request' } }),
  onStatus: listener => {
    const handler = (_event: Electron.IpcRendererEvent, data: { callId: string; phase: string }) => {
      if (validCallId(data?.callId) && ['starting', 'running', 'settling', 'completed', 'cancelled', 'failed'].includes(data.phase)) listener({ callId: data.callId, phase: data.phase as Parameters<typeof listener>[0]['phase'] })
    }
    ipcRenderer.on(SDK_STATUS_CHANNEL, handler)
    return () => { ipcRenderer.removeListener(SDK_STATUS_CHANNEL, handler) }
  },
}
if (process.isMainFrame) contextBridge.exposeInMainWorld('poloAppHost', Object.freeze(host))
