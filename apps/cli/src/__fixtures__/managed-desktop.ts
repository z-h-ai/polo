// Controlled desktop control plane: real Admin coordinator, Broker, proxy and
// billing outbox. Only the HTTP Admin/Provider are fixtures; no Electron UI.
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { adminNewApiConnection } from '../../../../packages/shared/src/config/__fixtures__/admin-newapi'
const root = resolve(process.argv[2]!)
process.env.POLO_AI_CONFIG_DIR = root
process.env.HOME = root
process.env.POLO_AI_RUNTIME_DISCOVERY_FILE = join(root, 'runtime/electron.json')
const accountId = crypto.randomUUID(), personal = crypto.randomUUID(), enterprise = crypto.randomUUID(), enterpriseId = crypto.randomUUID()
let space = personal, denied = false, receiptFailure = false, hold = false, providerCalls = 0
const missingRoutes: string[] = []
const providerBodies: any[] = [], billing: any[] = [], caps: string[] = []
let allowedModels = ['test-model']
let connectionOverrides: Record<string, unknown> = {}
let requestsInTurn = 0
let computeBarrier: Promise<void> | undefined, releaseCompute: (() => void) | undefined, enteredCompute: (() => void) | undefined
let executionState: () => unknown[] = () => []
let disconnectClient: (id: string) => void = () => {}
let control: (value: any) => Promise<unknown> = async () => ({})
const provider = Bun.serve({ port: 0, async fetch(req) {
  if (req.method === 'GET' && new URL(req.url).pathname.endsWith('/models')) return Response.json({ data: [{ id: 'test-model', object: 'model' }] })
  const body = await req.json() as any
  providerCalls++; providerBodies.push(body)
  if (req.headers.get('authorization') !== 'Bearer fixture-upstream-key') throw new Error('real upstream credential was not injected')
  if (!req.headers.get('x-polo-request-id')) throw new Error('billing admission correlation missing')
  if (hold) return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: ')) } }), { headers: { 'content-type': 'text/event-stream' } })
  const tools = body.tools?.map((t: any) => t.function.name) ?? []
  const user = [...body.messages].reverse().find((m: any) => m.role === 'user')
  const wantsTools = JSON.stringify(user).includes('FILE_LOOP')
  requestsInTurn = body.messages.slice(body.messages.lastIndexOf(user) + 1).filter((m: any) => m.role === 'tool').length
  let delta: any
  const probe = JSON.stringify(user).match(/POLICY_PROBE:([a-z_]+)/)?.[1]
  const hasProbeResult = body.messages.some((m: any) => m.role === 'tool')
  if (probe && !hasProbeResult) {
    const background = `(/bin/sleep 5; /bin/echo LATE > ${join(root, 'work/late.txt')}) >/dev/null 2>&1 & echo $! > ${join(root, 'work/background.pid')}`
    const name = probe === 'prefetch' ? 'mcp__session__call_llm' : probe
    const args = probe === 'bash' ? { command: background } : probe === 'mcp__session__script_sandbox' ? { script: `require('fs').writeFileSync('${join(root, 'work/script.txt')}', 'BAD')`, language: 'javascript' } : { prompt: 'probe', query: 'probe', pattern: '*', path: root }
    delta = { role: 'assistant', tool_calls: Array.from({ length: probe === 'prefetch' ? 2 : 1 }, (_, index) => ({ index, id: `policy_${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }
  } else if (wantsTools && ++requestsInTurn <= 2) {
    const read = requestsInTurn === 1
    delta = { role: 'assistant', tool_calls: [{ index: 0, id: `call_${requestsInTurn}`, type: 'function', function: { name: tools.find((n: string) => n.toLowerCase() === (read ? 'read' : 'write')), arguments: JSON.stringify(read ? { file_path: join(root, 'work/input.txt'), path: join(root, 'work/input.txt') } : { file_path: join(root, 'work/output.txt'), path: join(root, 'work/output.txt'), content: await readFile(join(root, 'work/input.txt'), 'utf8') }) } }] }
  } else delta = { role: 'assistant', content: 'MANAGED_OK' }
  const chunk = (delta: any, finish: string | null) => `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`
  return new Response(chunk(delta, null) + chunk({}, delta.tool_calls ? 'tool_calls' : 'stop') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 13, completion_tokens: 2 }, model: 'test-model' })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream', 'x-oneapi-request-id': `provider-${providerCalls}` } })
} })
const admin = Bun.serve({ port: 0, async fetch(req) {
  const url = new URL(req.url)
  if (url.pathname === '/fixture/control') return Response.json(await control(await req.json()))
  if (url.pathname === '/fixture/state') {
    const secretsOnDisk: string[] = []
    const walk = async (path: string) => { for (const e of await readdir(path, { withFileTypes: true }).catch(() => [])) { const file = join(path, e.name); if (e.isDirectory()) await walk(file); else if (e.isFile()) { const text = await readFile(file, 'utf8').catch(() => ''); if (text.includes('polo-cap-') || caps.some(cap => text.includes(cap))) secretsOnDisk.push(file.replace(root, 'ROOT')) } } }
    await walk(root)
    const outbox = []
    for (const name of await readdir(join(root, 'assistant-billing')).catch(() => [])) if (name.endsWith('.json')) outbox.push(JSON.parse(await readFile(join(root, 'assistant-billing', name), 'utf8')))
    return Response.json({ providerCalls, billing, bodies: providerBodies, secretsOnDisk, space, accountId, personal, enterprise, outbox, missingRoutes, executions: executionState() })
  }
  if (req.headers.get('authorization') !== 'Bearer fixture-admin-token') return Response.json({ error: 'UNAUTHORIZED', message: 'fixture auth required' }, { status: 401 })
  const input = ['POST', 'PATCH'].includes(req.method) ? await req.json() as any : undefined
  if (url.pathname === '/api/me/circles') return Response.json({ circles: [] })
  if (url.pathname === '/api/me/circle-memberships') return Response.json({ memberships: [] })
  if (/^\/api\/product-spaces\/[^/]+\/catalog$/.test(url.pathname)) return Response.json({ contractVersion: 1, productSpaceId: url.pathname.split('/')[3], catalogRevision: 'fixture-catalog-1', entries: [{ catalogEntryId: 'polo-assistant', kind: 'built_in_app', builtInAppId: 'polo_assistant', name: 'Polo Assistant', description: '', availability: 'available' }] })
  if (url.pathname === '/api/auth/validate') return Response.json({ valid: true, user: { id: accountId, username: 'fixture', displayName: 'Fixture', role: 'user', groupIds: [] }, configVersion: 'fixture-1' })
  if (url.pathname === '/api/me/product-spaces') return Response.json({ contractVersion: 1, personalProductSpaceId: personal, productSpaces: [
    { id: personal, kind: 'personal', name: '我的空间', accessMode: 'active', payer: { kind: 'account' } },
    { id: enterprise, kind: 'enterprise', enterpriseId, name: 'Fixture Enterprise', role: 'member', accessMode: 'active', payer: { kind: 'enterprise', enterpriseId } },
  ] })
  if (url.pathname === '/api/llm-connections' && computeBarrier) { enteredCompute?.(); await computeBarrier }
  if (url.pathname === '/api/llm-connections') { const computeSpace = url.searchParams.get('productSpaceId') || space; return Response.json({ productSpaceId: computeSpace, configVersion: 'fixture-1', defaultConnection: `polo-space-${computeSpace}`, connections: [{ ...adminNewApiConnection(computeSpace, `http://127.0.0.1:${provider.port}/v1`, allowedModels), ...connectionOverrides }] }) }
  if (url.pathname === '/api/billing/runs') {
    if (denied) return Response.json({ error: 'insufficient_credit', message: 'insufficient credit' }, { status: 409 })
    billing.push({ kind: 'start', input }); return Response.json({ run: { runId: input.runId, status: 'running' }, idempotent: false })
  }
  if (/\/requests$/.test(url.pathname)) { billing.push({ kind: 'admit', input }); return Response.json({ request: { requestId: input.requestId, state: 'admitted', providerCorrelation: { header: 'X-Polo-Request-Id', nonce: crypto.randomUUID().replaceAll('-', '') } }, idempotent: false }) }
  if (url.pathname === '/api/billing/usage') {
    billing.push({ kind: receiptFailure ? 'receipt_failed' : 'usage', input })
    if (receiptFailure) return Response.json({ error: 'SERVER_ERROR', message: 'fixture receipt outage' }, { status: 503 })
    return Response.json({ receipt: { requestId: input.requestId }, recorded: true, idempotent: false, settlement: 'confirmed' })
  }
  if (req.method === 'PATCH' && /^\/api\/billing\/runs\/[^/]+$/.test(url.pathname)) { const runId = url.pathname.split('/')[4]; billing.push({ kind: 'finish', runId, input }); return Response.json({ run: { runId, status: input.status }, idempotent: false, settlement: 'confirmed' }) }
  missingRoutes.push(url.pathname)
  return Response.json({ error: 'NOT_FOUND', message: url.pathname }, { status: 404 })
} })
await mkdir(join(root, 'work'), { recursive: true })
await writeFile(join(root, 'config.json'), JSON.stringify({ workspaces: [], activeSessionId: '', llmConnections: [], adminUrl: `http://127.0.0.1:${admin.port}` }))
await writeFile(join(root, 'config-defaults.json'), await readFile(resolve('apps/electron/resources/config-defaults.json')))
const { getCredentialManager } = await import('@polo-ai/shared/credentials')
await getCredentialManager().setAdminTokens({ accessToken: 'fixture-admin-token', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() + 3600000, userId: accountId, username: 'fixture' })
if (process.argv[3] === 'http-only') {
  control = async value => {
    if (value.denied !== undefined) denied = value.denied
    if (value.receiptFailure !== undefined) receiptFailure = value.receiptFailure
    if (value.hold !== undefined) hold = value.hold
    return { ok: true }
  }
  console.log(JSON.stringify({ ready: true, admin: `http://127.0.0.1:${admin.port}`, personal, enterprise }))
  process.on('SIGTERM', () => { provider.stop(true); admin.stop(true); process.exit(0) })
  await new Promise(() => {})
}
const { WsRpcServer } = await import('@polo-ai/server-core/transport')
const { registerAdminHandlers, whenInitialSyncTrustedProductSpaceAccountRestored } = await import('@polo-ai/server-core/handlers/rpc/admin')
const { registerCliManagedHandlers, disconnectCliManagedClient, shutdownCliManagedBrokers } = await import('@polo-ai/server-core/runtime/cli-managed-broker')
const execution = await import('@polo-ai/server-core/runtime/product-space-executions')
executionState = () => execution.listRegisteredProductSpaceExecutions().map(e => ({ kind: e.kind, scope: e.scope }))
const token = crypto.randomUUID()
const server = new WsRpcServer({ host: '127.0.0.1', port: 0, serverVersion: '0.10.0', requireAuth: true, validateToken: async value => value === token, onClientDisconnected: id => disconnectClient(id) })
disconnectClient = disconnectCliManagedClient
const originalHandle = server.handle.bind(server)
server.handle = (channel, handler) => originalHandle(channel, async (...args) => { const value = await handler(...args as [any, ...any[]]); if (channel === 'cliManaged.begin') caps.push(value.capability); return value })
registerAdminHandlers(server, { platform: { logger: { info() {}, warn() {}, error() {} } } } as any)
await whenInitialSyncTrustedProductSpaceAccountRestored()
execution.setRuntimeActiveProductSpace(personal); execution.setRuntimeActiveProductSpaceAccount(accountId)
registerCliManagedHandlers(server)
await server.listen()
const { writeElectronRuntimeDiscovery } = await import('@polo-ai/shared/runtime-discovery')
writeElectronRuntimeDiscovery({ pid: process.pid, url: `ws://127.0.0.1:${server.port}`, token, version: '0.10.0' })
control = async value => {
  if (value.connectionOverrides !== undefined) connectionOverrides = value.connectionOverrides
  if (value.allowAlternateModel) allowedModels = ['test-model', 'alternate-model']
  if (value.denied !== undefined) denied = value.denied
  if (value.receiptFailure !== undefined) receiptFailure = value.receiptFailure
  if (value.hold !== undefined) hold = value.hold
  if (value.switch) {
    const stopped = await execution.stopRegisteredProductSpaceExecutionsForSpace(accountId, space)
    if (!stopped.ok) return { stopped }
    space = value.switch === 'enterprise' ? enterprise : personal
    execution.setRuntimeActiveProductSpace(space); execution.setRuntimeActiveProductSpaceAccount(accountId)
  }
  if (value.probes) return await probes()
  if (value.quit) return { stopped: await shutdownCliManagedBrokers() }
  return { ok: true }
}
async function probes() {
  const { CliRpcClient } = await import('../client')
  const { createCliThread, acquireCliThreadLease, deleteCliThread } = await import('../cli-thread-store')
  const record = await createCliThread({ origin: 'cli-exec', configurationScopeId: 'global', configurationWorkspacePath: root, workingDirectory: join(root, 'work'), persistence: 'persistent' })
  await mkdir(join(record.directory, 'config-snapshot'))
  const owner = await acquireCliThreadLease(record)
  const a = new CliRpcClient(`ws://127.0.0.1:${server.port}`, { token }), b = new CliRpcClient(`ws://127.0.0.1:${server.port}`, { token })
  const { WsRpcClient } = await import('@polo-ai/server-core/transport')
  const renderer = new WsRpcClient(`ws://127.0.0.1:${server.port}`, { token, webContentsId: 123, autoReconnect: false })
  const input = { threadId: record.metadata.threadId, configurationScopeId: 'global', ownerPid: process.pid, ownerBirth: owner.owner.cliProcessIdentity, ownerLease: owner.owner.leaseId }
  const rejected: string[] = []
  const reject = async (name: string, operation: Promise<unknown>) => { try { await operation; throw new Error(`probe unexpectedly accepted: ${name}`) } catch (error) { if ((error as Error).message.startsWith('probe unexpectedly')) throw error; rejected.push(name) } }
  try {
    await a.connect(); await b.connect()
    await reject('renderer', renderer.invoke('cliManaged.begin', input))
    await reject('forged_scope', a.invoke('cliManaged.begin', { ...input, accountId }))
    await reject('wrong_birth', a.invoke('cliManaged.begin', { ...input, ownerBirth: 'wrong' }))
    await reject('wrong_pid', a.invoke('cliManaged.begin', { ...input, ownerPid: 1 }))
    await reject('wrong_lease', a.invoke('cliManaged.begin', { ...input, ownerLease: 'wrong' }))
    await reject('wrong_root', a.invoke('cliManaged.begin', { ...input, configurationScopeId: '..' }))
    await reject('wrong_space', a.invoke('cliManaged.begin', { ...input, expectedSpace: crypto.randomUUID() }))
    await reject('wrong_model', a.invoke('cliManaged.begin', { ...input, model: 'unknown' }))
    computeBarrier = new Promise<void>(r => { releaseCompute = r })
    const computeStarted = new Promise<void>(r => { enteredCompute = r })
    const stale = a.invoke('cliManaged.begin', input)
    await computeStarted
    execution.setRuntimeActiveProductSpace(space); execution.setRuntimeActiveProductSpaceAccount(accountId)
    releaseCompute!(); computeBarrier = undefined
    await reject('compute_fence_CAS', stale)
    const lease = await a.invoke('cliManaged.begin', input) as any
    await reject('cross_client_heartbeat', b.invoke('cliManaged.heartbeat', { leaseId: lease.leaseId }))
    await reject('cross_client_finish', b.invoke('cliManaged.finish', { leaseId: lease.leaseId }))
    await reject('arbitrary_runtime_pid', b.invoke('cliManaged.attachRuntime', { leaseId: lease.leaseId, pid: process.pid, birth: owner.owner.cliProcessIdentity }))
    const oldEntry = execution.listRegisteredProductSpaceExecutions().find(e => e.ref === record.metadata.threadId)!
    const successor = execution.registerProductSpaceExecution({ ...oldEntry, name: 'successor', generation: 0, isActive: () => false, stop: async () => 'stopped' })
    await a.invoke('cliManaged.finish', { leaseId: lease.leaseId })
    if (execution.getRegisteredProductSpaceExecution(successor.scope.executionId) !== successor) throw new Error('old lease removed successor registry generation')
    execution.unregisterProductSpaceExecution(successor.scope.executionId)
    rejected.push('registry_generation_CAS')
    await a.invoke('cliManaged.finish', { leaseId: lease.leaseId })
    await reject('late_heartbeat', a.invoke('cliManaged.heartbeat', { leaseId: lease.leaseId }))
    const stoppedLease = await a.invoke('cliManaged.begin', input) as any
    const stubborn = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
    try {
      const { getProcessBirthIdentity } = await import('@polo-ai/shared/utils')
      await b.invoke('cliManaged.attachRuntime', { leaseId: stoppedLease.leaseId, pid: stubborn.pid, birth: getProcessBirthIdentity(stubborn.pid) })
      const beforeFence = execution.getRuntimeFenceGeneration()
      const outcome = await execution.stopRegisteredProductSpaceExecutionsForSpace(accountId, space)
      if (outcome.ok || execution.getRuntimeFenceGeneration() !== beforeFence || !execution.listRegisteredProductSpaceExecutions().length) throw new Error('failed runtime stop did not retain original scope')
    } finally { stubborn.kill('SIGTERM'); await stubborn.exited }
    await a.invoke('cliManaged.finish', { leaseId: stoppedLease.leaseId })
    return { rejected, duplicateFinish: true, stopFailureRetained: true, providerCalls }
  } finally { a.destroy(); b.destroy(); renderer.destroy(); await owner.release(); await deleteCliThread(record) }
}
console.log(JSON.stringify({ ready: true, admin: `http://127.0.0.1:${admin.port}`, personal, enterprise }))
process.on('SIGTERM', async () => { await shutdownCliManagedBrokers(); server.close(); provider.stop(true); admin.stop(true); process.exit(0) })
await new Promise(() => {})
