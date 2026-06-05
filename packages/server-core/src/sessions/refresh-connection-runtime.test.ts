import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { LlmConnection } from '@polo-ai/shared/config'

const originalConfigDir = process.env.POLO_AI_CONFIG_DIR
const testConfigDir = mkdtempSync(join(tmpdir(), 'sm-refresh-config-'))
process.env.POLO_AI_CONFIG_DIR = testConfigDir

const testConnections = [
  {
    slug: 'slug-A',
    name: 'Custom Vision Endpoint',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    createdAt: 1,
    baseUrl: 'https://models.example.test/v1',
    defaultModel: 'vision-model',
    customEndpoint: { api: 'openai-completions' },
    models: [
      { id: 'vision-model', supportsImages: true },
      { id: 'text-model', supportsImages: false },
    ],
  },
  {
    slug: 'slug-B',
    name: 'Other Endpoint',
    providerType: 'pi_compat',
    authType: 'api_key_with_endpoint',
    createdAt: 1,
    baseUrl: 'https://other.example.test/v1',
    defaultModel: 'other-model',
    customEndpoint: { api: 'openai-completions' },
    models: ['other-model'],
  },
] as const

function writeTestConfig(): void {
  writeFileSync(join(testConfigDir, 'config.json'), JSON.stringify({
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    llmConnections: testConnections,
    defaultLlmConnection: 'slug-A',
  }, null, 2))
}

writeTestConfig()

const { resolveBackendContext } = await import('@polo-ai/shared/agent/backend')
const { buildBackendRuntimeSignature, buildRestartRequiredSignature } = await import('./runtime-config.ts')
const { SessionManager, createManagedSession } = await import('./SessionManager.ts')

// Regression coverage for the stale-Pi-subprocess bug where toggling
// `supportsImages` on a custom-endpoint model wrote to disk but never reached
// the live agent.
//
// Two failure modes are guarded here:
//   1. `getOrCreateAgent` deferred refresh whenever `managed.isProcessing` was
//      true, but `sendMessage` flips that flag *before* calling
//      `getOrCreateAgent` — which made the refresh branch dead code on the
//      send path. The new gate uses only `agent.isProcessing()`.
//   2. Saving a connection had no notification path to active sessions, so
//      capability changes only propagated lazily after the next send.
//      `refreshConnectionRuntime` now pushes updates from the SAVE handler.

interface AgentStub {
  isProcessing: () => boolean
  updateRuntimeConfig: jest.Mock
  dispose: () => void
  disposeForRestart?: () => Promise<void>
}

function createAgentStub(opts: {
  isProcessing?: boolean
  refreshSucceeds?: boolean
  refreshDelayMs?: number
} = {}): AgentStub {
  const delay = opts.refreshDelayMs ?? 0
  const result = opts.refreshSucceeds ?? true
  return {
    isProcessing: () => opts.isProcessing ?? false,
    updateRuntimeConfig: jest.fn().mockImplementation(async () => {
      if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
      return result
    }),
    dispose: () => { /* no-op for tests */ },
  }
}

function injectSession(
  sm: InstanceType<typeof SessionManager>,
  id: string,
  workspaceRoot: string,
  llmConnection: string,
  agent: AgentStub | null,
  opts: { backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing?: boolean } = {},
) {
  const workspace = {
    id: 'ws_test',
    name: 'Test Workspace',
    rootPath: workspaceRoot,
    createdAt: Date.now(),
  }
  const managed = createManagedSession(
    { id, name: id, llmConnection },
    workspace as never,
    { messagesLoaded: true },
  ) as unknown as { agent: AgentStub | null; backendRuntimeSignature?: string; backendRestartSignature?: string; isProcessing: boolean; llmConnection?: string }
  managed.agent = agent
  // Force a stale runtime signature so the helper's comparison always reaches
  // the refresh branch — the signature it computes from real disk config will
  // never equal this sentinel.
  managed.backendRuntimeSignature = opts.backendRuntimeSignature ?? '__stale_runtime_signature_for_test__'
  // Pre-compute the restart signature against the same resolution the helper
  // will use, so by default tests route through the in-place refresh path.
  // Tests that want the restart-required path pass an explicit sentinel.
  if (opts.backendRestartSignature !== undefined) {
    managed.backendRestartSignature = opts.backendRestartSignature
  } else {
    const ctx = resolveBackendContext({
      sessionConnectionSlug: llmConnection,
    })
    managed.backendRestartSignature = buildRestartRequiredSignature({
      connection: ctx.connection,
      provider: ctx.provider,
      authType: ctx.authType,
      resolvedModel: ctx.resolvedModel,
    })
  }
  managed.isProcessing = opts.isProcessing ?? false
  managed.llmConnection = llmConnection
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
  return managed
}

describe('refreshConnectionRuntime', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof SessionManager>

  beforeEach(() => {
    writeTestConfig()
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-refresh-'))
    sm = new SessionManager()
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    rmSync(testConfigDir, { recursive: true, force: true })
    if (originalConfigDir === undefined) {
      delete process.env.POLO_AI_CONFIG_DIR
    } else {
      process.env.POLO_AI_CONFIG_DIR = originalConfigDir
    }
  })

  it('pushes updateRuntimeConfig to sessions on the matching connection slug', async () => {
    const matchingAgent = createAgentStub()
    const otherAgent = createAgentStub()
    injectSession(sm, 'matching', tmpRoot, 'slug-A', matchingAgent)
    injectSession(sm, 'other', tmpRoot, 'slug-B', otherAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(matchingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(otherAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('skips sessions whose agent is mid-stream (defers, does not yank)', async () => {
    const busyAgent = createAgentStub({ isProcessing: true })
    injectSession(sm, 'busy', tmpRoot, 'slug-A', busyAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(busyAgent.updateRuntimeConfig).not.toHaveBeenCalled()
  })

  it('does not defer just because managed.isProcessing is true (Fix 1 regression)', async () => {
    // sendMessage flips managed.isProcessing=true *before* calling
    // getOrCreateAgent → tryRefreshAgentRuntime. The pre-fix gate
    // `managed.isProcessing || agent.isProcessing()` was therefore always true
    // on the send path, making the refresh branch dead code. The fix narrows
    // the gate to `agent.isProcessing()` only — which is what actually means
    // "an in-flight stream we shouldn't yank."
    const idleAgent = createAgentStub({ isProcessing: false })
    injectSession(sm, 'sending', tmpRoot, 'slug-A', idleAgent, { isProcessing: true })

    await sm.refreshConnectionRuntime('slug-A')

    expect(idleAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when there is no agent yet (cold session)', async () => {
    injectSession(sm, 'cold', tmpRoot, 'slug-A', null)

    await expect(sm.refreshConnectionRuntime('slug-A')).resolves.toBeUndefined()
  })

  it('disposes the runtime when in-place refresh fails so the next send rebuilds it', async () => {
    const failingAgent = createAgentStub({ refreshSucceeds: false })
    const managed = injectSession(sm, 'failing', tmpRoot, 'slug-A', failingAgent)

    await sm.refreshConnectionRuntime('slug-A')

    expect(failingAgent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    expect(managed.agent).toBeNull()
  })

  it('skips in-place refresh and forces recreation when a restart-required field changed', async () => {
    // `update_runtime_config` cannot propagate `piAuthProvider`, slug,
    // providerType, or authType cleanly. When any of those drift, the helper
    // must dispose the runtime instead of marking it refreshed (which would
    // record the new signature against a stale subprocess).
    const agent = createAgentStub()
    const managed = injectSession(sm, 'auth-changed', tmpRoot, 'slug-A', agent, {
      backendRestartSignature: '__stale_restart_signature__',
    })

    await sm.refreshConnectionRuntime('slug-A')

    expect(agent.updateRuntimeConfig).not.toHaveBeenCalled()
    expect(managed.agent).toBeNull()
  })

  it('serializes concurrent refresh requests via the per-session mutex', async () => {
    // SAVE handler is fire-and-forget (Finding 1) so its refresh can be
    // mid-flight when sendMessage triggers another via getOrCreateAgent.
    // Without a mutex, both fire updateRuntimeConfig and the subprocess can
    // race a chat against the still-pending update.
    //
    // The first call holds the lock long enough for the second to see it,
    // wait, and re-evaluate from the post-refresh state — at which point the
    // signature matches and the second call is a no-op.
    const agent = createAgentStub({ refreshDelayMs: 50 })
    injectSession(sm, 'concurrent', tmpRoot, 'slug-A', agent)

    const [first, second] = await Promise.all([
      sm.refreshConnectionRuntime('slug-A'),
      sm.refreshConnectionRuntime('slug-A'),
    ])

    expect(first).toBeUndefined()
    expect(second).toBeUndefined()
    // Only one updateRuntimeConfig — the second call awaited the first via
    // the mutex, then saw matching signatures and bailed.
    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
  })

  it('records customModels with the per-model supportsImages flag in the IPC payload', async () => {
    // End-to-end shape check: when the session's connection resolves to a
    // pi_compat connection with explicit per-model `supportsImages`, the
    // helper must forward that field on `customModels` so the Pi subprocess
    // can re-register the model with `input: ['text', 'image']`.
    const agent = createAgentStub()
    const connection = testConnections[0]!
    const typedConnection = connection as unknown as LlmConnection
    const backendContext = {
      connection: typedConnection,
      provider: 'pi' as const,
      authType: 'api_key_with_endpoint' as const,
      resolvedModel: 'vision-model',
      capabilities: {},
    }
    const sigInput = {
      connection: typedConnection,
      provider: backendContext.provider,
      authType: backendContext.authType,
      resolvedModel: backendContext.resolvedModel,
    }
    const runtimeSignature = buildBackendRuntimeSignature(sigInput)
    const restartSignature = buildRestartRequiredSignature(sigInput)
    const managed = injectSession(sm, 'shape-check', tmpRoot, 'slug-A', agent, {
      backendRestartSignature: restartSignature,
    })

    await (sm as unknown as {
      runAgentRuntimeRefresh: (
        managed: ReturnType<typeof injectSession>,
        runtimeContext: typeof backendContext,
        runtimeSignature: string,
        restartSignature: string,
        restartRequired: boolean,
        reason: string,
      ) => Promise<void>
    }).runAgentRuntimeRefresh(managed, backendContext, runtimeSignature, restartSignature, false, 'connection update')

    expect(agent.updateRuntimeConfig).toHaveBeenCalledTimes(1)
    const payload = agent.updateRuntimeConfig.mock.calls[0]?.[0]
    const runtime = payload?.runtime
    expect(payload).toBeDefined()
    expect(typeof payload?.model).toBe('string')
    expect(runtime).toBeDefined()
    expect(runtime?.customModels).toEqual([
      { id: 'vision-model', supportsImages: true },
      { id: 'text-model', supportsImages: false },
    ])
    // The runtime envelope mirrors what `pi-agent.ts:requestRuntimeConfigUpdate`
    // unpacks — `customModels` shape preserves `supportsImages` when set.
    if (payload.runtime?.customModels) {
      for (const m of payload.runtime.customModels) {
        if (typeof m === 'object') {
          expect(typeof m.id).toBe('string')
          if ('supportsImages' in m) {
            expect(typeof m.supportsImages).toBe('boolean')
          }
        }
      }
    }
  })
})
