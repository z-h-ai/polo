import { afterAll, afterEach, beforeEach, expect, mock, test, jest } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise the actual four SessionManager factory consumers; only the trusted
// connection transport and model factory are controlled. No provider is called.
const root = mkdtempSync(join(tmpdir(), 'assistant-scoped-connection-'))
const originalConfig = process.env.POLO_AI_CONFIG_DIR
process.env.POLO_AI_CONFIG_DIR = root
const workspaceRoot = join(root, 'workspace')
const { mkdirSync, copyFileSync } = await import('node:fs')
mkdirSync(workspaceRoot)
const workspace = { id: 'ws_owned', name: 'Owned', rootPath: workspaceRoot, createdAt: 1 }
const personal = 'polo-space-personal', enterprise = 'polo-space-enterprise'
const connections = [
  { slug: personal, managedBy: 'admin', defaultModel: 'personal-model', models: ['personal-model'] },
  { slug: enterprise, managedBy: 'admin', defaultModel: 'enterprise-model', models: ['enterprise-model', 'enterprise-choice'] },
  { slug: 'user-endpoint', defaultModel: 'user-model', models: ['user-model'] },
].map(c => ({ ...c, name: c.slug, providerType: 'pi_compat', authType: 'api_key_with_endpoint', createdAt: 1, baseUrl: 'https://owned.invalid/v1', customEndpoint: { api: 'openai-completions' } }))
const writeConfig = () => {
  writeFileSync(join(root, 'config.json'), JSON.stringify({ workspaces: [workspace], activeWorkspaceId: workspace.id, llmConnections: connections, defaultLlmConnection: enterprise, adminUrl: 'https://admin.owned.invalid' }))
  writeFileSync(join(workspaceRoot, 'config.json'), JSON.stringify({ ...workspace, defaults: { defaultLlmConnection: personal, model: 'personal-model' } }))
}
writeConfig()
copyFileSync('apps/electron/resources/config-defaults.json', join(root, 'config-defaults.json'))
let resolverCalls: unknown[] = []
let resolveConnection = async (_scope: unknown) => ({ connectionSlug: enterprise, model: 'enterprise-model' })
const resolver = async (scope: unknown) => { resolverCalls.push(scope); return resolveConnection(scope) }
mock.module('../handlers/rpc/admin', () => ({ resolveProductSpaceConnection: resolver, resolveProductSpaceAppConnection: resolver }))
const backend = await import('@polo-ai/shared/agent/backend')
const attempted: Array<{ slug?: string; model?: string; mini?: string }> = []
const sentinel = new Error('owned factory boundary')
mock.module('@polo-ai/shared/agent/backend', () => ({ ...backend,
  createBackendFromResolvedContext: (args: any) => { attempted.push({ slug: args.context.connection?.slug, model: args.context.resolvedModel, mini: args.coreConfig.miniModel }); throw sentinel },
  createBackendFromConnection: (slug: string, config: any) => { attempted.push({ slug, mini: config.miniModel }); throw sentinel },
}))
const { SessionManager, createManagedSession, setSessionPlatform } = await import('./SessionManager')
const { resetProductSpaceExecutionRegistryForTests, setRuntimeActiveProductSpace, setRuntimeActiveProductSpaceAccount } = await import('../runtime/product-space-executions')
const { setSyncTrustedProductSpaceAccountId, setTrustedProductSpaceAccountProvider } = await import('../handlers/rpc/trusted-product-space-account')
setSessionPlatform({ appRootPath: root, resourcesPath: root, isPackaged: false, logger: { info() {}, warn() {}, error() {}, debug() {} } } as any)
let sm: any, managed: any
beforeEach(() => {
  writeConfig(); resolverCalls = []; attempted.length = 0
  resolveConnection = async () => ({ connectionSlug: enterprise, model: 'enterprise-model' })
  resetProductSpaceExecutionRegistryForTests()
  setTrustedProductSpaceAccountProvider(async () => 'account-owned')
  setSyncTrustedProductSpaceAccountId('account-owned')
  setRuntimeActiveProductSpaceAccount('account-owned'); setRuntimeActiveProductSpace('enterprise')
  sm = new SessionManager({ runtimeWorkspace: workspace })
  managed = createManagedSession({ id: 'owned-session', name: 'Owned', model: 'personal-model', llmConnection: personal, messages: [] }, workspace, { messagesLoaded: true })
  Object.assign(managed, { accountId: 'account-owned', productSpaceId: 'enterprise', llmConnection: personal, model: 'personal-model', messagesLoaded: true, messages: [{ id: 'user-owned', role: 'user', content: 'hello', timestamp: 1 }] })
  sm.sessions.set(managed.id, managed)
  jest.spyOn(sm, 'persistSession').mockImplementation(() => {})
  jest.spyOn(sm, 'assistantBillingFor').mockImplementation(() => undefined)
})
afterEach(() => { jest.restoreAllMocks(); resetProductSpaceExecutionRegistryForTests() })
afterAll(() => { rmSync(root, { recursive: true, force: true }); if (originalConfig === undefined) delete process.env.POLO_AI_CONFIG_DIR; else process.env.POLO_AI_CONFIG_DIR = originalConfig })

for (const operation of ['normal', 'refreshTitle', 'generateTitle', 'remoteSummary'] as const) {
  test(`${operation} rebinds stale personal managed selection to original enterprise before its real factory`, async () => {
    if (operation === 'normal') await sm.getOrCreateAgent(managed).catch(() => {})
    if (operation === 'refreshTitle') await sm.refreshTitle(managed.id)
    if (operation === 'generateTitle') await sm.generateTitle(managed, 'hello')
    if (operation === 'remoteSummary') await sm.generateRemoteTransferSummary(managed).catch(() => {})
    expect(attempted).toHaveLength(1)
    expect(attempted[0]!.slug).toBe(enterprise)
    if (operation === 'normal' || operation === 'remoteSummary') expect(attempted[0]!.model).toBe('enterprise-model')
    else expect(attempted[0]!.mini).toBe('enterprise-model')
    expect(resolverCalls).toContainEqual({ accountId: 'account-owned', productSpaceId: 'enterprise' })
  })
}
test('new enterprise session ignores the stale personal workspace managed default', async () => {
  const session = await sm.createSession(workspace.id)
  expect(session.llmConnection).toBe(enterprise)
  expect(session.model).toBe('enterprise-model')
})
test('explicit user-managed endpoint retains its connection/model without Admin preflight', async () => {
  managed.llmConnection = 'user-endpoint'; managed.model = 'user-model'
  await sm.generateRemoteTransferSummary(managed).catch(() => {})
  expect(attempted[0]).toMatchObject({ slug: 'user-endpoint', model: 'user-model' })
  expect(resolverCalls).toHaveLength(0)
})
test('an explicit supported enterprise model is retained after canonical connection refresh', async () => {
  managed.model = 'enterprise-choice'
  await sm.generateRemoteTransferSummary(managed).catch(() => {})
  expect(attempted[0]).toMatchObject({ slug: enterprise, model: 'enterprise-choice' })
})
test('a fence replacement during trusted refresh cannot dispatch or mutate original session selection', async () => {
  let release!: () => void
  const latch = new Promise<void>(resolve => { release = resolve })
  resolveConnection = async () => { await latch; return { connectionSlug: enterprise, model: 'enterprise-model' } }
  const work = sm.generateRemoteTransferSummary(managed).catch(() => {})
  await new Promise(resolve => setTimeout(resolve, 20))
  setRuntimeActiveProductSpace('other-space'); release(); await work
  expect(attempted).toHaveLength(0)
  expect(managed.llmConnection).toBe(personal)
})
