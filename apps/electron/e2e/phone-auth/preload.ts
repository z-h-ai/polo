import { contextBridge, ipcRenderer } from 'electron'
import { WsRpcClient } from '@polo-ai/server-core/transport'
import { buildAdminPreloadApi } from '../../src/preload/admin-api'
import { WebSocket as NodeWebSocket } from 'ws'
import { get } from 'node:http'

const argumentValue = (name: string) => process.argv
  .find(argument => argument.startsWith(`${name}=`))
  ?.slice(name.length + 1)

const rpcUrl = argumentValue('--phone-auth-e2e-rpc-url')
const challengeUrl = argumentValue('--phone-auth-e2e-challenge-url')
if (!rpcUrl || !challengeUrl) {
  throw new Error('Phone auth E2E transport configuration is missing')
}

globalThis.WebSocket = NodeWebSocket as unknown as typeof WebSocket

const client = new WsRpcClient(rpcUrl, {
  autoReconnect: false,
  mode: 'local',
})
client.connect()

function followMockProviderRedirect(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, { agent: false }, response => {
      const location = response.headers.location
      if (location) {
        response.resume()
        followMockProviderRedirect(location).then(resolve, reject)
        return
      }
      response.once('end', resolve)
      response.resume()
    }).once('error', reject)
  })
}

const adminApi = buildAdminPreloadApi(client, {
  configuredIssuerUrl: challengeUrl,
  openExternal: followMockProviderRedirect,
})

contextBridge.exposeInMainWorld('electronAPI', {
  ...adminApi,
  reportPhoneAuthE2eResult: (result: unknown) => {
    ipcRenderer.send('phone-auth-e2e:result', result)
  },
})
