import { randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { hasManagedCliMarkers, getAdminUrl, getLlmConnection, sameDesktopManagedOwner, type DesktopManagedOwner, type DesktopManagedDescriptor, type LlmConnection } from '@polo-ai/shared/config'
import { getCredentialManager, startInvocationCredentialProxy, isInsufficientCreditCode, type InvocationCredentialProxy } from '@polo-ai/shared/credentials'
import { RootedSessionStorage } from '@polo-ai/shared/sessions'
import { processIdentityMatches } from '@polo-ai/shared/utils'
import { PRODUCT_SPACE_CONTRACT_VERSION, ProductSpaceIdSchema, ProductSpaceExecutionScopeSchema } from '@polo-ai/shared/product-spaces'
import type { RpcServer, RequestContext } from '../transport/types'
import { resolveProductSpaceConnection } from '../handlers/rpc/admin'
import { fetchTrustedProductSpaceList } from '../handlers/rpc/trusted-product-space-account'
import { captureTrustedStartGate, isTrustedStartGateCurrent } from './trusted-start-gate'
import { createAssistantBillingHooks } from './assistant-billing'
import { getRuntimeActiveProductSpace, getRuntimeFenceGeneration, getRegisteredProductSpaceExecution, registerProductSpaceExecution, unregisterProductSpaceExecution, isRuntimeOfflineReadOnly, isRuntimeProductSpaceRestricted, isSwitchInProgress, runUnderSwitchMutex, type RegisteredProductSpaceExecution } from './product-space-executions'

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
const beginSchema = z.object({ threadId: id, configurationScopeId: id, ownerPid: z.number().int().positive(), ownerBirth: z.string().min(1).max(256), ownerLease: z.string().min(1).max(256), expectedSpace: ProductSpaceIdSchema.optional(), model: z.string().min(1).max(128).optional() }).strict()
const attachSchema = z.object({ leaseId: z.string().min(32).max(128), pid: z.number().int().positive(), birth: z.string().min(1).max(256) }).strict()
const leaseSchema = z.object({ leaseId: z.string().min(32).max(128) }).strict()
type Begin = z.infer<typeof beginSchema>
type Runtime = { pid: number; birth: string }
interface Lease {
  clientId: string
  runtimeClientId?: string
  input: Begin
  descriptor: DesktopManagedDescriptor
  proxy: InvocationCredentialProxy
  current(): boolean
  ownerCurrent(): boolean
  runtime?: Runtime
  entry: RegisteredProductSpaceExecution
  active: boolean
  revoked: boolean
  expiresAt: number
  stopPromise?: Promise<'stopped' | 'failed'>
}

function processTable(): Array<{ pid: number; ppid: number; pgid: number; state: string }> {
  return execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n').map(line => {
    const [pid, ppid, pgid, state] = line.trim().split(/\s+/)
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state: state ?? '' }
  })
}
function runtimeGone(runtime?: Runtime): boolean {
  if (!runtime) return true
  // Managed CLI permits only in-process file tools and disables Pi extensions/
  // package resolution and host proxies. This checks that restricted runtime,
  // not arbitrary shell descendants (which could escape its process group).
  return !processIdentityMatches(runtime.pid, runtime.birth)
    && !processTable().some(row => row.pgid === runtime.pid && !row.state.startsWith('Z'))
}
function socketOnly(ctx: RequestContext): void {
  if (!ctx.localSocket || ctx.webContentsId !== null) throw new Error('POLO_MANAGED_LOCAL_SOCKET_REQUIRED')
}

/** Shared trusted context: online validation and canonical compute resolution
 * remain in the existing Admin session coordinator. No raw credential RPC. */
async function captureContext(expectedSpace?: string) {
  const gate = await captureTrustedStartGate()
  if (!gate) throw new Error('POLO_LOGIN_REQUIRED')
  const productSpaceId = getRuntimeActiveProductSpace(), adminOrigin = getAdminUrl()
  if (!productSpaceId || !adminOrigin) throw new Error('POLO_SPACE_REQUIRED')
  if (expectedSpace && expectedSpace !== productSpaceId) throw new Error('POLO_SPACE_MISMATCH')
  const fence = getRuntimeFenceGeneration()
  const current = () => isTrustedStartGateCurrent(gate) && getRuntimeFenceGeneration() === fence
    && getRuntimeActiveProductSpace() === productSpaceId && getAdminUrl() === adminOrigin
    && !isRuntimeOfflineReadOnly() && !isRuntimeProductSpaceRestricted(productSpaceId) && !isSwitchInProgress()
  if (!current()) throw new Error('POLO_SPACE_UNAVAILABLE')
  const result = await fetchTrustedProductSpaceList()
  if (!current() || !result.ok) throw new Error('POLO_ONLINE_REQUIRED')
  const space = result.list.productSpaces.find(item => item.id === productSpaceId)
  if (!space || space.accessMode !== 'active') throw new Error('POLO_SPACE_ACCESS_DENIED')
  const owner: DesktopManagedOwner = { computeSource: 'desktop-managed', accountId: gate.accountId, productSpaceId, adminOrigin }
  return { owner, space, current }
}

/** Identity of authorized compute, excluding harmless UI/usage timestamps.
 * Admin sync rebuilds objects and createdAt; those are not a new grant. */
export function managedConnectionFingerprint(connection: LlmConnection | null | undefined): string {
  if (!connection) return ''
  return JSON.stringify({ slug: connection.slug, managedBy: connection.managedBy, providerType: connection.providerType,
    type: connection.type, piAuthProvider: connection.piAuthProvider, authType: connection.authType, baseUrl: connection.baseUrl,
    api: connection.customEndpoint?.api, supportsImages: connection.customEndpoint?.supportsImages,
    models: connection.models?.map(model => typeof model === 'string' ? model : model.id).sort(),
    defaultModel: connection.defaultModel, adminConfigVersion: connection.adminConfigVersion })
}

const brokers = new Set<CliManagedBroker>()
export class CliManagedBroker {
  private leases = new Map<string, Lease>()
  private finished = new Map<string, string>()
  private disconnected = new Set<string>()
  private closed = false
  private timer: ReturnType<typeof setInterval>
  constructor(private server: RpcServer) {
    brokers.add(this)
    this.timer = setInterval(() => {
      for (const lease of this.leases.values()) if (!lease.revoked && (!lease.current() || Date.now() > lease.expiresAt)) void this.stop(lease)
    }, 1000)
    this.timer.unref()
  }
  async context(ctx: RequestContext) { socketOnly(ctx); return (await captureContext()).owner }
  private ownerProof(input: Begin) {
    const controlled = resolve(process.env.POLO_AI_CONFIG_DIR || join(homedir(), '.polo-ai'), 'cli-sessions')
    const root = join(controlled, input.configurationScopeId, 'executions', input.threadId)
    const storage = new RootedSessionStorage(join(root, 'sessions'), { controlledRoot: controlled })
    const ownerFile = join(root, 'owner.json'), metadataFile = join(root, 'thread.json')
    for (const file of [root, ownerFile, metadataFile, join(root, 'config-snapshot')]) storage.assertSafeFilePath(file, false)
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8'))
    if (metadata.threadId !== input.threadId || metadata.configurationScopeId !== input.configurationScopeId) throw new Error('POLO_MANAGED_THREAD_REJECTED')
    const ownerCurrent = () => {
      try {
        storage.assertSafeFilePath(ownerFile, false)
        const owner = JSON.parse(readFileSync(ownerFile, 'utf8'))
        return owner.cliPid === input.ownerPid && owner.cliProcessIdentity === input.ownerBirth && owner.leaseId === input.ownerLease
          && processIdentityMatches(input.ownerPid, input.ownerBirth)
      } catch { return false }
    }
    if (!ownerCurrent()) throw new Error('POLO_MANAGED_OWNER_REJECTED')
    // Only a genuinely unused Thread can acquire its first managed identity.
    storage.assertSafeFilePath(join(root, 'sessions'), false)
    const hasHistory = readdirSync(join(root, 'sessions')).length > 0
    return { metadata, ownerCurrent, hasHistory }
  }
  async begin(ctx: RequestContext, raw: unknown): Promise<DesktopManagedDescriptor> {
    socketOnly(ctx)
    if (this.closed || process.platform === 'win32') throw new Error('POLO_MANAGED_UNAVAILABLE')
    if (this.leases.size >= 32) throw new Error('POLO_MANAGED_BUSY')
    const input = beginSchema.parse(raw)
    if ([...this.leases.values()].some(l => l.input.threadId === input.threadId && l.active)) throw new Error('POLO_MANAGED_THREAD_BUSY')
    const proof = this.ownerProof(input)
    if (!proof.metadata.managedOwner) {
      if (hasManagedCliMarkers(proof.metadata.connection)) throw new Error('POLO_THREAD_OWNER_UNKNOWN')
      const connection = proof.metadata.connection
      const initialSelectionOnly = !connection || (
        Object.keys(connection).every(key => ['provider', 'model'].includes(key))
        && (!connection.provider || connection.provider === 'polo')
      )
      if (!initialSelectionOnly || proof.metadata.mainSessionId || proof.hasHistory || proof.metadata.status) throw new Error('POLO_THREAD_COMPUTE_SOURCE_MISMATCH: start a new Polo Thread')
    }
    const captured = await captureContext(input.expectedSpace)
    if (proof.metadata.managedOwner && !sameDesktopManagedOwner(proof.metadata.managedOwner, captured.owner)) throw new Error('POLO_THREAD_OWNER_MISMATCH')
    const selection = await resolveProductSpaceConnection(captured.owner)
    if (!captured.current() || !proof.ownerCurrent() || ctx.signal?.aborted) throw new Error('POLO_MANAGED_REVOKED')
    const connection = getLlmConnection(selection.connectionSlug)
    if (connection?.slug !== `polo-space-${captured.owner.productSpaceId}` || connection.managedBy !== 'admin'
      || !connection.baseUrl || connection.providerType !== 'pi_compat' || connection.authType !== 'api_key_with_endpoint'
      || connection.customEndpoint?.api !== 'openai-completions') throw new Error('POLO_MANAGED_PROTOCOL_UNSUPPORTED')
    // Match the Admin custom-endpoint contract before acquiring credentials or billing.
    let endpoint: URL
    try { endpoint = new URL(connection.baseUrl) } catch { throw new Error('POLO_MANAGED_PROTOCOL_UNSUPPORTED') }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('POLO_MANAGED_PROTOCOL_UNSUPPORTED')
    const allowedModels = connection.models?.map(m => typeof m === 'string' ? m : m.id) ?? []
    const model = input.model ?? selection.model ?? connection.defaultModel
    if (!model || !allowedModels.includes(model)) throw new Error('POLO_MODEL_NOT_ALLOWED')
    const credential = await getCredentialManager().getLlmApiKey(connection.slug)
    if (!credential) throw new Error('POLO_COMPUTE_UNAVAILABLE')
    const fingerprint = managedConnectionFingerprint(connection)
    let lease: Lease | undefined
    const current = () => !this.closed && !!lease && !lease.revoked && Date.now() <= lease.expiresAt && proof.ownerCurrent() && captured.current()
      && managedConnectionFingerprint(getLlmConnection(connection.slug)) === fingerprint
    const hooks = createAssistantBillingHooks({ subjectKind: 'polo_assistant', accountId: captured.owner.accountId, productSpaceId: captured.owner.productSpaceId, adminOrigin: captured.owner.adminOrigin }, current)
    const proxy = await startInvocationCredentialProxy({ upstreamBaseUrl: connection.baseUrl, credential, credentialHeaders: [{ name: 'authorization', format: 'bearer' }] }, {
      managedPolicy: { allowedModels }, assertExecutionCurrent: () => { if (!current()) throw new Error('POLO_MANAGED_REVOKED') },
      billing: { beforeSend: async (facts, context) => {
        try { return await hooks.beforeSend(facts, context) }
        catch (error) {
          const raw = (error as { errorCode?: string })?.errorCode
          const code = isInsufficientCreditCode(raw) ? 'POLO_INSUFFICIENT_CREDIT' : 'POLO_BILLING_UNAVAILABLE'
          if (lease) {
            this.server.push('cliManaged.failed', { to: 'client', clientId: lease.clientId }, { leaseId: descriptor.leaseId, code })
            void this.stop(lease)
          }
          throw error
        }
      } },
    })
    const descriptor: DesktopManagedDescriptor = { version: 1, leaseId: randomBytes(32).toString('base64url'), execution: { threadId: input.threadId, configurationScopeId: input.configurationScopeId, ownerPid: input.ownerPid, ownerBirth: input.ownerBirth, ownerLease: input.ownerLease }, owner: captured.owner, spaceName: captured.space.name, spaceKind: captured.space.kind, model, allowedModels, proxyUrl: `${proxy.url}/v1`, capability: proxy.capability }
    try {
      await runUnderSwitchMutex(async () => {
        if (!captured.current() || !proof.ownerCurrent() || ctx.signal?.aborted || this.closed || this.disconnected.has(ctx.clientId)) throw new Error('POLO_MANAGED_REVOKED')
        if ([...this.leases.values()].some(l => l.input.threadId === input.threadId && l.active)) throw new Error('POLO_MANAGED_THREAD_BUSY')
        const scope = ProductSpaceExecutionScopeSchema.parse({ contractVersion: PRODUCT_SPACE_CONTRACT_VERSION, executionId: randomUUID(), accountId: captured.owner.accountId, productSpaceId: captured.owner.productSpaceId, workspaceId: 'cli', subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' } })
        lease = { input, descriptor, proxy, clientId: ctx.clientId, ownerCurrent: proof.ownerCurrent, current, active: true, revoked: false, expiresAt: Date.now() + 15000, entry: undefined! }
        lease.entry = registerProductSpaceExecution({ scope, kind: 'cli_execution', ref: input.threadId, name: `Polo CLI · ${captured.space.name}`, generation: 0,
          isActive: () => lease!.active, getStatus: () => lease!.revoked ? 'stopping' : lease!.runtime ? 'running' : 'preparing', stop: () => this.stop(lease!) })
        this.leases.set(descriptor.leaseId, lease)
      })
      return descriptor
    } catch (error) { await proxy.close(); throw error }
  }
  private get(ctx: RequestContext, leaseId: string, runtimeAllowed = false): Lease {
    socketOnly(ctx)
    const lease = this.leases.get(leaseId)
    if (!lease || (lease.clientId !== ctx.clientId && (!runtimeAllowed || lease.runtimeClientId !== ctx.clientId))) throw new Error('POLO_MANAGED_LEASE_REJECTED')
    return lease
  }
  async attach(ctx: RequestContext, raw: unknown): Promise<DesktopManagedDescriptor> {
    socketOnly(ctx)
    const input = attachSchema.parse(raw), lease = this.leases.get(input.leaseId)
    if (!lease || lease.runtime || !lease.current()) throw new Error('POLO_MANAGED_LEASE_REJECTED')
    const row = processTable().find(row => row.pid === input.pid)
    if (!row || row.ppid !== lease.input.ownerPid || row.pgid !== input.pid || !processIdentityMatches(input.pid, input.birth)) throw new Error('POLO_MANAGED_RUNTIME_REJECTED')
    lease.runtime = { pid: input.pid, birth: input.birth }
    lease.runtimeClientId = ctx.clientId
    return lease.descriptor
  }
  heartbeat(ctx: RequestContext, raw: unknown): void {
    const { leaseId } = leaseSchema.parse(raw), lease = this.get(ctx, leaseId, true)
    if (!lease.current()) { void this.stop(lease); throw new Error('POLO_MANAGED_REVOKED') }
    lease.expiresAt = Date.now() + 15000
  }
  async finish(ctx: RequestContext, raw: unknown) {
    socketOnly(ctx)
    const { leaseId } = leaseSchema.parse(raw)
    if (this.finished.get(leaseId) === ctx.clientId) return { stopped: true }
    const lease = this.get(ctx, leaseId)
    const stopped = await this.stop(lease)
    if (stopped !== 'stopped') throw new Error('POLO_MANAGED_RUNTIME_STOP_FAILED')
    this.finished.set(leaseId, ctx.clientId)
    if (this.finished.size > 128) this.finished.delete(this.finished.keys().next().value!)
    return { stopped: true }
  }
  private stop(lease: Lease): Promise<'stopped' | 'failed'> {
    if (lease.stopPromise) return lease.stopPromise
    lease.revoked = true
    for (const clientId of [lease.clientId, lease.runtimeClientId]) if (clientId) this.server.push('cliManaged.revoked', { to: 'client', clientId }, { leaseId: lease.descriptor.leaseId })
    lease.stopPromise = (async () => {
      const deadline = Date.now() + 8000
      let timeout: ReturnType<typeof setTimeout> | undefined
      const drained = await Promise.race([lease.proxy.close().then(() => true), new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), 8000) })]).finally(() => { if (timeout) clearTimeout(timeout) })
      if (!drained) { lease.stopPromise = undefined; return 'failed' }
      while (!runtimeGone(lease.runtime) && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
      if (!runtimeGone(lease.runtime)) { lease.stopPromise = undefined; return 'failed' }
      lease.active = false
      if (getRegisteredProductSpaceExecution(lease.entry.scope.executionId) === lease.entry) unregisterProductSpaceExecution(lease.entry.scope.executionId)
      this.finished.set(lease.descriptor.leaseId, lease.clientId)
      if (this.finished.size > 128) this.finished.delete(this.finished.keys().next().value!)
      this.leases.delete(lease.descriptor.leaseId)
      return 'stopped'
    })().catch(() => { lease.stopPromise = undefined; return 'failed' as const })
    return lease.stopPromise
  }
  disconnect(clientId: string): void {
    this.disconnected.add(clientId)
    if (this.disconnected.size > 128) this.disconnected.delete(this.disconnected.values().next().value!)
    for (const lease of this.leases.values()) if (lease.clientId === clientId || lease.runtimeClientId === clientId) void this.stop(lease) }
  async shutdown(): Promise<boolean> {
    this.closed = true
    const outcomes = await Promise.all([...this.leases.values()].map(lease => this.stop(lease)))
    if (outcomes.some(outcome => outcome !== 'stopped')) return false
    clearInterval(this.timer); brokers.delete(this); return true
  }
}
export function registerCliManagedHandlers(server: RpcServer): CliManagedBroker {
  const broker = new CliManagedBroker(server)
  server.handle('cliManaged.context', ctx => broker.context(ctx))
  server.handle('cliManaged.begin', (ctx, input) => broker.begin(ctx, input))
  server.handle('cliManaged.attachRuntime', (ctx, input) => broker.attach(ctx, input))
  server.handle('cliManaged.heartbeat', (ctx, input) => broker.heartbeat(ctx, input))
  server.handle('cliManaged.finish', (ctx, input) => broker.finish(ctx, input))
  return broker
}
export function disconnectCliManagedClient(clientId: string): void { for (const broker of brokers) broker.disconnect(clientId) }
export async function shutdownCliManagedBrokers(): Promise<boolean> { return (await Promise.all([...brokers].map(b => b.shutdown()))).every(Boolean) }
