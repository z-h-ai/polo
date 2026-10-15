import { afterAll, beforeEach, expect, jest, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const originalConfig = process.env.POLO_AI_CONFIG_DIR
const root = mkdtempSync(join(tmpdir(), 'assistant-missing-managed-'))
process.env.POLO_AI_CONFIG_DIR = root
const workspace = { id: 'owned', slug: 'owned', name: 'Owned', rootPath: root, createdAt: 1 }
const custom = { slug: 'custom', name: 'Custom', providerType: 'pi_compat', authType: 'api_key_with_endpoint', createdAt: 1, defaultModel: 'custom-model', models: ['custom-model'], baseUrl: 'https://owned.invalid/v1', customEndpoint: { api: 'openai-completions' } }
const canonical = { ...custom, slug: 'polo-space-enterprise', managedBy: 'admin', defaultModel: 'enterprise-model', models: ['enterprise-model'] }
const writeConfig = (includeCanonical = false) => writeFileSync(join(root, 'config.json'), JSON.stringify({ llmConnections: includeCanonical ? [custom, canonical] : [custom], defaultLlmConnection: 'custom', adminUrl: 'https://admin.owned.invalid' }))
writeConfig()
let unavailable = false, calls = 0, factoryCalls: string[] = []
const resolve = async () => { calls++; if (unavailable) throw new Error('Owned compute unavailable'); writeConfig(true); return { connectionSlug: canonical.slug, model: canonical.defaultModel } }
mock.module('../handlers/rpc/admin', () => ({ resolveProductSpaceConnection: resolve, resolveProductSpaceAppConnection: resolve }))
const backend = await import('@polo-ai/shared/agent/backend')
mock.module('@polo-ai/shared/agent/backend', () => ({ ...backend, createBackendFromResolvedContext: (args: any) => { factoryCalls.push(args.context.connection?.slug); throw new Error('owned factory boundary') } }))
const { SessionManager, createManagedSession, setSessionPlatform } = await import('./SessionManager')
const runtime = await import('../runtime/product-space-executions')
const account = await import('../handlers/rpc/trusted-product-space-account')
setSessionPlatform({ appRootPath: root, resourcesPath: root, isPackaged: false, logger: { info() {}, warn() {}, error() {}, debug() {} } } as any)
let sm: any, managed: any
beforeEach(() => {
  writeConfig(); calls = 0; factoryCalls = []; unavailable = false
  runtime.resetProductSpaceExecutionRegistryForTests(); account.setSyncTrustedProductSpaceAccountId('account-owned')
  runtime.setRuntimeActiveProductSpaceAccount('account-owned'); runtime.setRuntimeActiveProductSpace('enterprise')
  sm = new SessionManager({ workspace })
  managed = createManagedSession({ id: 'owned', name: 'Owned' }, workspace, { messagesLoaded: true })
  Object.assign(managed, { accountId: 'account-owned', productSpaceId: 'enterprise', llmConnection: 'polo-space-personal', model: 'old-model', messages: [{ id: 'user', role: 'user', content: 'hello', timestamp: 1 }] })
  sm.sessions.set(managed.id, managed)
  jest.spyOn(sm, 'persistSession').mockImplementation(() => {})
  jest.spyOn(sm, 'assistantBillingFor').mockImplementation(() => undefined)
})
afterAll(() => { jest.restoreAllMocks(); runtime.resetProductSpaceExecutionRegistryForTests(); rmSync(root, { recursive: true, force: true }); if (originalConfig === undefined) delete process.env.POLO_AI_CONFIG_DIR; else process.env.POLO_AI_CONFIG_DIR = originalConfig })
test('a deleted platform-managed selection is refreshed in its original space instead of falling through to a user endpoint', async () => {
  await sm.generateRemoteTransferSummary(managed).catch(() => {})
  expect(calls).toBe(1)
  expect(factoryCalls).toEqual(['polo-space-enterprise'])
})
test('unavailable managed compute does not silently dispatch via an unrelated user default', async () => {
  unavailable = true
  await sm.generateRemoteTransferSummary(managed).catch(() => {})
  expect(factoryCalls).toHaveLength(0)
  expect(managed.llmConnection).toBe('polo-space-personal')
})
