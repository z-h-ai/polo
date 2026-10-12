/** Candidate 21 controlled integration: real imported process App, gateway,
 * original Host child, installed Pi SDK, supplier HTTP API, Admin routes and SQL.
 * A private isolated environment configuration is supplied by the fixture owner.
 * This runner does not create cloud services or replace the billing/AI services.
 * bun run .../billing-integration.ts <private-config.json> <ignored-evidence-dir>
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import * as tar from 'tar'
import { AdminClient } from '@polo-ai/shared/admin'
import { setInvocationLlmConnections, clearInvocationLlmConnections } from '@polo-ai/shared/config'
import { setInvocationCredential, clearInvocationCredentials } from '@polo-ai/shared/credentials'
import { createSessionlessHostLlmExecutor } from '@polo-ai/shared/agent/host-llm-executor'
import { LocalAppRuntimeCoordinator } from '../../src/main/local-app-runtime/runtime-coordinator'
import { LocalAppRuntimeManager } from '../../src/main/local-app-runtime/manager'
import { AppBillingOutbox } from '../../src/main/local-app-runtime/app-billing-outbox'
import { buildPiAgentServerBundle, bundleOutputPath } from '../../../../scripts/build/pi-agent-server-staging'
interface FixtureConfig {
  adminUrl: string; accessToken: string; accountId: string; productSpaceId: string
  artifactInstanceId: string; artifactVersionId: string; providerBaseUrl: string
  providerApiKey: string; model: string; version?: string; nodeRuntimePath?: string
}
const [configPath, evidencePath] = process.argv.slice(2)
if (!configPath || !evidencePath) throw new Error('Private configuration and ignored evidence directory are required')
const config = JSON.parse(readFileSync(resolve(configPath), 'utf8')) as FixtureConfig
for (const name of ['adminUrl', 'accessToken', 'accountId', 'productSpaceId', 'artifactInstanceId', 'artifactVersionId', 'providerBaseUrl', 'providerApiKey', 'model'] as const) if (typeof config[name] !== 'string' || !config[name]) throw new Error(`Missing integration configuration ${name}`)
// Controlled integration is local only; a live supplier requires a separately
// authorized owner-scoped acceptance environment.
for (const url of [config.adminUrl, config.providerBaseUrl]) if (!['127.0.0.1', 'localhost', '::1'].includes(new URL(url).hostname.replace(/^\[|\]$/g, ''))) throw new Error('Controlled integration endpoints must be loopback')
const evidence = resolve(evidencePath)
mkdirSync(evidence, { recursive: true, mode: 0o700 })
const nodeRuntimePath = config.nodeRuntimePath ?? Bun.which('node')
if (!nodeRuntimePath || !nodeRuntimePath.startsWith('/') || !existsSync(nodeRuntimePath)) throw new Error('An absolute real Node runtime is required')
const runtime = JSON.parse(execFileSync(nodeRuntimePath, ['-e', 'process.stdout.write(JSON.stringify({node:process.versions.node,bun:process.versions.bun??null}))'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 })) as { node?: string; bun?: string | null }
if (!runtime.node || runtime.bun || Number(runtime.node.split('.')[0]) < 22) throw new Error('Host integration requires real Node 22 or newer')
const repoRoot = resolve(import.meta.dir, '../../../..')
const workerLayout = { sourceEntry: join(repoRoot, 'packages/pi-agent-server/src/index.ts'), distDir: join(evidence, 'pi-agent-server') }
await buildPiAgentServerBundle(workerLayout, repoRoot)
const workerEntry = bundleOutputPath(workerLayout)
const resultsPath = join(evidence, 'fixture-app-results.json')
const bundle = join(evidence, 'bundle-source')
mkdirSync(bundle, { recursive: true })
const built = await Bun.build({ entrypoints: [join(import.meta.dir, 'fixture-app.ts')], target: 'bun', outdir: bundle })
if (!built.success) throw new Error('Fixture App build failed')
writeFileSync(join(bundle, 'polo-app.json'), JSON.stringify({ schemaVersion: 1, appId: 'candidate21.fixture', version: config.version ?? '1.0.0', runtime: 'js', entry: ['fixture-app.js'], healthcheck: '/health', webPath: '/', permissions: [] }))
const archivePath = join(evidence, 'fixture-bundle.tar.gz')
await tar.c({ cwd: bundle, file: archivePath, gzip: true }, ['.'])
const archive = readFileSync(archivePath)
const download = createServer((_req, res) => { res.setHeader('content-length', archive.length); res.end(archive) })
await new Promise<void>(done => download.listen(0, '127.0.0.1', done))
const client = new AdminClient(config.adminUrl)
const outbox = new AppBillingOutbox(join(evidence, 'billing-outbox'))
const connectionSlug = 'candidate21-controlled'
setInvocationLlmConnections([{ slug: connectionSlug, name: 'Candidate 21 controlled original provider', providerType: 'pi_compat', authType: 'api_key_with_endpoint', baseUrl: config.providerBaseUrl, customEndpoint: { api: 'openai-completions' }, defaultModel: config.model, models: [config.model], createdAt: Date.now() }])
setInvocationCredential({ type: 'llm_api_key', connectionSlug }, { value: config.providerApiKey })
const manager = new LocalAppRuntimeManager({ rootDir: join(evidence, 'installed-apps'), bunPath: process.execPath, logger: { info: () => {}, warn: () => {}, error: () => {} } })
let originalCalls = 0
const coordinator = new LocalAppRuntimeCoordinator({
  billingOutbox: outbox, getAdminOrigin: () => config.adminUrl,
  isScopeCurrent: identity => identity.accountId === config.accountId,
  admin: {
    startAppRun: (input, options) => client.startAppRun(config.accessToken, input, options),
    admitAppRequest: (runId, input, options) => client.admitAppRequest(config.accessToken, runId, input, options),
    getAppRequest: (runId, requestId, options) => client.getAppRequest(config.accessToken, runId, requestId, options),
    recordAppUsage: (input, options) => client.recordAppUsage(config.accessToken, input, options),
    finishAppRun: (runId, input, options) => client.finishAppRun(config.accessToken, runId, input, options),
  },
  createExecutor: options => {
    const executor = createSessionlessHostLlmExecutor({ ...options, nodeRuntimePath, serverPath: workerEntry })
    return { execute: async input => { originalCalls++; return executor.execute(input) }, dispose: () => executor.dispose() }
  },
  resolveWorkspaceRoot: () => evidence,
  loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: connectionSlug, model: config.model } }),
  getDefaultLlmConnection: () => connectionSlug,
  stopRuntime: runtime => manager.stopExact('candidate21.fixture', runtime.runtimeGeneration).then(() => {}),
})
let ok = false
try {
  await coordinator.ensureGateway()
  await manager.install({ appId: 'candidate21.fixture', version: config.version ?? '1.0.0', downloadUrl: `http://127.0.0.1:${(download.address() as { port: number }).port}/bundle`, checksum: createHash('sha256').update(archive).digest('hex'), sizeBytes: archive.length, platform: process.platform as 'darwin' | 'linux' | 'win32', arch: process.arch === 'arm64' ? 'arm64' : 'x64' })
  const identity = { accountId: config.accountId, productSpaceId: config.productSpaceId, artifactInstanceId: config.artifactInstanceId, versionId: config.artifactVersionId, version: config.version ?? '1.0.0' }
  await manager.startExactVersion('candidate21.fixture', identity.version, { runtimeKey: JSON.stringify(['candidate21', identity]), processEnvironment: ({ runtimeKind, runtimeGeneration }) => {
    const signing = coordinator.signCapability({ identity, workspaceId: 'controlled-workspace', executionId: 'candidate21-controlled-app', runtimeKind, runtimeGeneration, scopeGeneration: 1 })
    coordinator.registerActiveRuntime({ identity, workspaceId: 'controlled-workspace', executionId: 'candidate21-controlled-app', runtimeKind, runtimeGeneration, scopeGeneration: 1, capabilityGeneration: signing.capabilityGeneration })
    return { env: { ...signing.environment, POLO_FIXTURE_RESULT_PATH: resultsPath, POLO_FIXTURE_BILLING_SCENARIO: '1' }, sensitiveValues: signing.sensitiveValues }
  } })
  const deadline = Date.now() + 90_000
  while (!existsSync(resultsPath) && Date.now() < deadline) await new Promise(done => setTimeout(done, 100))
  if (!existsSync(resultsPath)) throw new Error('Fixture App did not complete')
  const calls = JSON.parse(readFileSync(resultsPath, 'utf8')) as Record<string, { status: number; body: any }>
  for (const label of ['runStart', 'query', 'queryReplay', 'querySecond', 'queryNoOutput', 'finish']) if (calls[label]?.status !== 200) throw new Error(`App ${label} failed with ${calls[label]?.status}`)
  if (calls.query?.body.data.text !== calls.queryReplay?.body.data.text || originalCalls !== 3) throw new Error('Duplicate request reran provider execution')
  if (calls.queryNoOutput?.body.data.status !== 'no_output') throw new Error('No-output scenario did not exercise the original supplier')
  const settlementDeadline = Date.now() + 30_000
  while (outbox.entries(config.accountId, config.adminUrl).length && Date.now() < settlementDeadline) {
    await coordinator.reconcileBillingOutbox(config.accountId, config.adminUrl)
    if (outbox.entries(config.accountId, config.adminUrl).length) await new Promise(done => setTimeout(done, 250))
  }
  const remainingPending = outbox.entries(config.accountId, config.adminUrl).length
  if (remainingPending) throw new Error('App execution completed but original financial facts remain pending')
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ kind: 'controlled-App-Host-Pi-Admin-SQL-integration', hostNodeVersion: runtime.node, productionBundleSha256: createHash('sha256').update(readFileSync(workerEntry)).digest('hex'), originalHostCalls: originalCalls, duplicatedBusinessCalls: 1, callStatuses: Object.fromEntries(Object.entries(calls).map(([label, result]) => [label, result.status])), remainingPendingJournalEntries: outbox.entries(config.accountId, config.adminUrl).length, liveCloudAcceptance: false }, null, 2))
  ok = true
  console.log('Candidate 21 controlled App integration PASS; supplier ledger verification belongs to the isolated backend owner.')
} finally {
  await coordinator.shutdown()
  await manager.shutdown()
  await new Promise<void>(done => download.close(() => done()))
  clearInvocationLlmConnections(); clearInvocationCredentials()
  if (!ok) console.error('Candidate 21 controlled App integration failed; original evidence and journal retained.')
}
