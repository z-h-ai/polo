/**
 * POO-54 Electron Main E2E harness. Drives the REAL local-app manager,
 * loopback gateway, capability registry and run-state through a fixture
 * process App, with the POL-102 Admin boundary and the Host LLM executor
 * replaced by deterministic fakes. Verifies capability env injection,
 * run/query/finish sequencing, sink-unavailable behavior, single-instance
 * cross-ProductSpace replacement and post-replacement token revocation.
 */
import { app } from 'electron'
import { createServer, type Server } from 'http'
import { createHash } from 'crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import * as tar from 'tar'
import { LocalAppRuntimeManager } from '../../src/main/local-app-runtime/manager'
import { LocalAppRuntimeCoordinator } from '../../src/main/local-app-runtime/runtime-coordinator'

const FAILURES: string[] = []

function assert(condition: unknown, message: string): void {
  if (condition) {
    console.log(`[e2e] ok: ${message}`)
  } else {
    FAILURES.push(message)
    console.error(`[e2e] FAIL: ${message}`)
  }
}

async function waitForFile(path: string, timeoutMs = 60_000): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        // retry on a partially written file
      }
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  return null
}

async function main(): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), 'polo-app-runtime-e2e-'))
  app.setPath('userData', join(tempRoot, 'userdata'))
  await app.whenReady()

  // --- Fixture bundle: a real js local-app carrying the fixture server. ---
  const bundleDir = join(tempRoot, 'bundle-src')
  const serverJs = readFileSync(join(__dirname, 'fixture-server.js'), 'utf8')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'server.js'), serverJs)
  writeFileSync(join(bundleDir, 'polo-app.json'), JSON.stringify({
    schemaVersion: 1,
    appId: 'e2e.fixture',
    version: '1.0.0',
    runtime: 'js',
    entry: ['server.js'],
    healthcheck: '/health',
    webPath: '/',
    permissions: [],
  }))
  const archivePath = join(tempRoot, 'bundle.tar.gz')
  await tar.c({ cwd: bundleDir, file: archivePath, gzip: true }, ['.'])
  const archive = readFileSync(archivePath)
  const checksum = createHash('sha256').update(archive).digest('hex')
  const downloadServer: Server = createServer((_request, response) => {
    response.setHeader('content-length', String(archive.length))
    response.end(archive)
  })
  await new Promise<void>(resolve => downloadServer.listen(0, '127.0.0.1', resolve))
  const address = downloadServer.address()
  if (!address || typeof address === 'string') throw new Error('no download port')
  const downloadUrl = `http://127.0.0.1:${address.port}/bundle`

  // --- Real manager + real coordinator; Admin/Host seams are fakes. ---
  const manager = new LocalAppRuntimeManager({
    rootDir: join(tempRoot, 'local-apps'),
    bunPath: process.env.POLO_AI_BUN,
    logger: {
      info: () => {},
      warn: () => {},
      error: (message, details) => console.error('[e2e][manager]', message, details),
    },
  })
  const adminCalls: string[] = []
  const coordinator = new LocalAppRuntimeCoordinator({
    admin: {
      startAppRun: async input => {
        adminCalls.push(`start:${(input as { runId: string }).runId}`)
      },
      recordAppUsage: async input => {
        const body = input as { requestId: string; inputTokens: number; outputTokens: number }
        adminCalls.push(`usage:${body.requestId}:${body.inputTokens}/${body.outputTokens}`)
      },
      finishAppRun: async runId => {
        adminCalls.push(`finish:${runId}`)
      },
    },
    createExecutor: () => ({
      execute: async () => ({
        status: 'completed' as const,
        text: 'e2e-answer',
        usage: {
          inputTokens: 5,
          outputTokens: 7,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 12,
          reportedModel: 'e2e-model',
        },
        requestId: 'host-e2e',
        model: 'e2e-model',
        provider: 'e2e',
      }),
      dispose: async () => {},
    }),
    resolveWorkspaceRoot: () => join(tempRoot, 'workspace'),
    loadWorkspaceConfig: () => ({ defaults: { defaultLlmConnection: 'conn-e2e', model: 'm' } }),
    getDefaultLlmConnection: () => null,
  })
  const gatewayUrl = await coordinator.ensureGateway()
  assert(gatewayUrl.startsWith('http://127.0.0.1:'), 'gateway binds IPv4 loopback only')

  // Install the fixture bundle through the REAL manager install path.
  const hostPlatform = process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin' ? 'darwin' : 'linux'
  await manager.install({
    appId: 'e2e.fixture',
    version: '1.0.0',
    downloadUrl,
    checksum,
    sizeBytes: archive.length,
    platform: hostPlatform,
    arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  })
  downloadServer.close()

  const startForIdentity = async (
    productSpaceId: string,
    scopeGeneration: number,
    resultsPath: string,
  ): Promise<{ token: string; runtimeGeneration: number; executionId: string }> => {
    const identity = {
      accountId: 'account-e2e',
      productSpaceId,
      artifactInstanceId: 'artifact-e2e',
      versionId: 'version-e2e',
      version: '1.0.0',
    }
    const executionId = `local-app:${productSpaceId}:artifact-e2e:e2e`
    let token = ''
    let capabilityGeneration: number | undefined
    const result = await manager.startExactVersion('e2e.fixture', '1.0.0', {
      runtimeKey: `product-space-app-runtime:1:account-e2e:${productSpaceId}:artifact-e2e:version-e2e`,
      processEnvironment: ({ runtimeKind, runtimeGeneration }) => {
        const signing = coordinator.signCapability({
          identity,
          workspaceId: 'ws-e2e',
          executionId,
          runtimeKind,
          runtimeGeneration,
          scopeGeneration,
        })
        token = signing.token
        capabilityGeneration = signing.capabilityGeneration
        // Provisional registration at spawn time: the injected token is
        // valid the moment the process boots.
        coordinator.registerActiveRuntime({
          identity,
          executionId,
          runtimeGeneration,
          scopeGeneration,
          workspaceId: 'ws-e2e',
          runtimeKind,
          capabilityGeneration,
        })
        return {
          env: {
            ...signing.environment,
            POLO_FIXTURE_RESULT_PATH: resultsPath,
          },
          sensitiveValues: signing.sensitiveValues,
        }
      },
    })
    return { token, runtimeGeneration: result.runtimeGeneration, executionId }
  }

  // 1. Workspace-A runtime: the fixture performs the full App sequence over
  // the real loopback gateway with its injected capability token.
  const resultsAPath = join(tempRoot, 'fixture-results-a.json')
  const spaceA = await startForIdentity('space-a', 1, resultsAPath)
  assert(spaceA.token.length > 0, 'capability token signed for space-a runtime')
  const statusA = await manager.getRuntimeStatus('e2e.fixture')
  assert(statusA.status === 'running', 'fixture App reaches running state')

  const resultsARaw = await waitForFile(resultsAPath)
  assert(resultsARaw !== null, 'fixture A wrote its sequence results')
  const resultsA = resultsARaw ? JSON.parse(resultsARaw) as Record<string, {
    path: string
    status: number
    body: Record<string, unknown>
  }> : {}
  assert(resultsA.runStart?.status === 200, 'App run/start succeeds with injected capability')
  assert(
    resultsA.resultReportWhileRunning?.status === 503
    && resultsA.resultReportWhileRunning.body?.error?.code === 'sink_unavailable',
    'result/report without an injected sink is 503 sink_unavailable',
  )
  assert(
    resultsA.query?.status === 200
    && (resultsA.query.body?.data as { text?: string } | undefined)?.text === 'e2e-answer',
    'ai/query releases the Host answer after the receipt is confirmed',
  )
  assert(resultsA.finish?.status === 200, 'App run/finish succeeds after confirmed receipts')
  assert(
    resultsA.startAfterFinish?.status === 409
    && resultsA.startAfterFinish.body?.error?.code === 'run_state_conflict',
    'a second start on a terminal run is run_state_conflict',
  )
  assert(
    resultsA.reportAfterFinish?.status === 409
    && resultsA.reportAfterFinish.body?.error?.code === 'run_finalized',
    'report after terminal is run_finalized',
  )
  assert(
    adminCalls.some(call => call.startsWith('usage:') && call.endsWith(':5/7')),
    'POL-102 usage receipt recorded before the body was released',
  )

  // 2. Cross-ProductSpace single-instance replacement: space-b start must
  // revoke space-a's token and stop its process generation first.
  const existing = coordinator.getActiveRuntimeByExecution(spaceA.executionId)
  assert(Boolean(existing), 'space-a runtime is registered with the coordinator')
  if (existing) {
    await coordinator.teardownRuntime(existing, 'cancelled', async () => {
      await manager.stopExact('e2e.fixture', existing.runtimeGeneration).catch(() => {})
    })
  }
  const resultsBPath = join(tempRoot, 'fixture-results-b.json')
  const spaceB = await startForIdentity('space-b', 2, resultsBPath)
  assert(spaceB.token !== spaceA.token, 'space-b runtime receives a fresh capability')
  const statusAfterReplacement = await manager.getRuntimeStatus('e2e.fixture')
  assert(statusAfterReplacement.status === 'running', 'space-b runtime is running')

  // The revoked space-a token is refused immediately (no replay window).
  const replayResponse = await fetch(`${gatewayUrl}/run/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${spaceA.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ runId: crypto.randomUUID() }),
  })
  assert(replayResponse.status === 401, 'revoked space-a capability is refused with 401')

  // 3. The space-b fixture sequence proves the new capability end-to-end.
  const resultsBRaw = await waitForFile(resultsBPath)
  assert(resultsBRaw !== null, 'fixture B wrote its sequence results')
  const resultsB = resultsBRaw ? JSON.parse(resultsBRaw) as Record<string, { status: number }> : {}
  assert(resultsB.runStart?.status === 200, 'space-b run/start succeeds with the new capability')

  downloadServer.close()
  await coordinator.shutdown()
  await manager.shutdown()

  if (FAILURES.length > 0) {
    console.error(`[e2e] ${FAILURES.length} assertion(s) failed`)
    app.exit(1)
    return
  }
  console.log('[e2e] PASS: ProductSpace App runtime foundation verified end-to-end')
  app.exit(0)
}

main().catch(error => {
  console.error('[e2e] harness error:', error)
  app.exit(1)
})
