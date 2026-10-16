import { readElectronRuntimeDiscovery } from '@polo-ai/shared/runtime-discovery'
import { sameDesktopManagedOwner, type DesktopManagedDescriptor, type DesktopManagedOwner } from '@polo-ai/shared/config'
import { version } from '../package.json'
import { CliRpcClient } from './client'
import type { CliThreadRecord, CliThreadLease } from './cli-thread-store'
import type { ExecutionArgs } from './execution-parser'

export async function connectManagedDesktop() {
  const result = readElectronRuntimeDiscovery({ expectedVersion: version })
  if (result.status !== 'available') throw new Error('POLO_APP_REQUIRED: open Polo App and sign in before using --provider polo')
  const client = new CliRpcClient(result.record.url, { token: result.record.token, expectedServerVersion: version, connectTimeout: 5000, requestTimeout: 15000 })
  try { await client.connect(); return { client, discovery: result.record, discoveryFile: result.path } }
  catch { client.destroy(); throw new Error('POLO_APP_REQUIRED: running Polo App could not be reached') }
}
export async function currentManagedOwner(): Promise<DesktopManagedOwner | undefined> {
  let connection: Awaited<ReturnType<typeof connectManagedDesktop>> | undefined
  try { connection = await connectManagedDesktop(); return await connection.client.invoke('cliManaged.context') as DesktopManagedOwner }
  catch { return undefined }
  finally { connection?.client.destroy() }
}
export async function assertManagedThreadAccess(record: CliThreadRecord, args: ExecutionArgs): Promise<void> {
  if (!record.metadata.managedOwner) {
    if (record.metadata.connection?.provenance?.kind === 'managed' || record.metadata.connection?.slug?.startsWith('polo-space-')) throw new Error('POLO_THREAD_OWNER_UNKNOWN')
    return
  }
  if (args.provider && args.provider !== 'polo' || args.apiKey || args.baseUrl || process.env.LLM_API_KEY || process.env.LLM_BASE_URL) throw new Error('POLO_THREAD_COMPUTE_SOURCE_MISMATCH')
  const owner = await currentManagedOwner()
  if (!owner || !sameDesktopManagedOwner(owner, record.metadata.managedOwner)) throw new Error('POLO_THREAD_OWNER_MISMATCH')
}
export async function beginManagedExecution(record: CliThreadRecord, lease: CliThreadLease, args: ExecutionArgs) {
  if (args.apiKey || args.baseUrl || process.env.LLM_API_KEY || process.env.LLM_BASE_URL) throw new Error('POLO_MANAGED_OVERRIDE_FORBIDDEN: --api-key/--base-url and LLM_API_KEY/LLM_BASE_URL cannot be used with Polo compute')
  if (args.sources.length) throw new Error('POLO_MANAGED_SOURCES_UNSUPPORTED')
  if (args.kind === 'resume' && !record.metadata.managedOwner) throw new Error('POLO_THREAD_COMPUTE_SOURCE_MISMATCH: start a new Polo Thread')
  const connection = await connectManagedDesktop()
  try {
    const descriptor = await connection.client.invoke('cliManaged.begin', { threadId: record.metadata.threadId, configurationScopeId: record.metadata.configurationScopeId,
      ownerPid: process.pid, ownerBirth: lease.owner.cliProcessIdentity, ownerLease: lease.owner.leaseId, expectedSpace: args.space,
      model: args.model ?? record.metadata.connection?.model }) as DesktopManagedDescriptor
    return { ...connection, descriptor }
  } catch (error) { connection.client.destroy(); throw error }
}
