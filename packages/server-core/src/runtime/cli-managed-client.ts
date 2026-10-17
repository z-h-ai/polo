import { WsRpcClient } from '../transport/client'
import { desktopManagedConnection, type DesktopManagedDescriptor } from '@polo-ai/shared/config'
import { readElectronRuntimeDiscovery, type ElectronRuntimeDiscovery } from '@polo-ai/shared/runtime-discovery'
import { getProcessBirthIdentity } from '@polo-ai/shared/utils'

export interface DesktopManagedBootstrap { discovery: ElectronRuntimeDiscovery; discoveryFile: string; leaseId: string }
/** Server independently verifies that stdin's endpoint is the current private
 * desktop publication before attaching its actual OS identity. */
export async function attachDesktopManagedRuntime(input: DesktopManagedBootstrap) {
  const found = readElectronRuntimeDiscovery({ path: input.discoveryFile, expectedVersion: input.discovery.version })
  if (found.status !== 'available' || JSON.stringify(found.record) !== JSON.stringify(input.discovery)) throw new Error('POLO_APP_IDENTITY_CHANGED')
  const client = new WsRpcClient(found.record.url, { token: found.record.token, autoReconnect: false, requestTimeout: 10000, connectTimeout: 5000 })
  let active = true
  client.onConnectionStateChanged(state => { if (['disconnected', 'failed', 'reconnecting'].includes(state.status)) active = false })
  client.on('cliManaged.revoked', value => { if (value?.leaseId === input.leaseId) active = false })
  try {
    const descriptor = await client.invoke('cliManaged.attachRuntime', { leaseId: input.leaseId, pid: process.pid, birth: getProcessBirthIdentity(process.pid) }) as DesktopManagedDescriptor
    desktopManagedConnection(descriptor)
    if (descriptor.leaseId !== input.leaseId || !active) throw new Error('POLO_MANAGED_REVOKED')
    const timer = setInterval(() => { void client.invoke('cliManaged.heartbeat', { leaseId: input.leaseId }).catch(() => { active = false }) }, 2000)
    timer.unref()
    return { descriptor, assertCurrent() { if (!active) throw new Error('POLO_MANAGED_REVOKED') }, close() { active = false; clearInterval(timer); client.destroy() } }
  } catch (error) { client.destroy(); throw error }
}
