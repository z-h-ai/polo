import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'
import * as serverCoreDomain from '@polo-ai/server-core/domain'

// Fault injection for releaseBrowserOwnershipOnForcedStop — must be installed
// before SessionManager is imported so the module binding picks up the mock.
const realRelease = serverCoreDomain.releaseBrowserOwnershipOnForcedStop as
  | ((...args: unknown[]) => Promise<unknown>)
  | undefined
mock.module('@polo-ai/server-core/domain', () => ({
  ...serverCoreDomain,
  releaseBrowserOwnershipOnForcedStop: async (...args: unknown[]) => {
    if (realRelease) return await realRelease(...args)
    return undefined
  },
}))

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')

const { SessionManager, createManagedSession } = await import('./SessionManager.ts')
const { getSessionFilePath, listSessions, writeSessionJsonl } = await import('@polo-ai/shared/sessions')
type StoredSession = import('@polo-ai/shared/sessions').StoredSession
const { buildQuestionFixtures } = await import('./request-user-input-fixtures.ts')
const sharedAgent = await import('@polo-ai/shared/agent')

// The PRODUCTION renderer modules (event processor + pending-question map
// helpers) are loaded through a computed specifier: the acceptance runs them
// for real at runtime, while staying outside the electron tsconfig graph
// (its path aliases only resolve inside the app project).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rendererModules: { events: any; pending: any } = await (async () => {
  const base = '../../../../apps/electron/src/renderer/'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const events = await (import(base + 'event-processor/processor.ts' as string)) as any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pending = await (import(base + 'lib/pending-questions.ts' as string)) as any
  return { events, pending }
})()

// PRODUCTION-HARNESS OUTSIDE-IN ACCEPTANCE for request_user_input (POO-53).
//
// Every scenario starts a REAL production turn — `SessionManager.sendMessage`
// with the turn-start commit, agent wiring, per-turn session MCP spawn
// boundary and generation binding — and the MODEL's request_user_input call
// is executed through that engine's PRODUCTION consumption path:
//
// - Claude (embedded): the production SDK session toolset
//   (`getSessionScopedTools` — the exact tool assembly the SDK hands the
//   model). The model discovers the tool via `tools/list` and the call is a
//   real MCP `callTool` round-trip into the canonical registry handler.
// - Pi (embedded): a REAL PiAgent — the model-visible toolset is
//   `buildSessionToolDefs` (what `register_tools` installs for the
//   subprocess), and the call is dispatched through the production
//   subprocess-forwarded path (`routeToolCall` → `executeSessionTool`).
// - External Codex: `sendMessage` AWAITS the per-turn session MCP spawn to
//   full readiness (host listening + client connected) BEFORE the model may
//   start; the real server process exposes the tool in `tools/list` and the
//   call travels stdio → HTTP callback → durable handoff.
//
// The MOUNTED RENDERER contract is observed through the production pipeline:
// every server event is delivered through the renderer event processor
// (`processEvent`) into the same pending-question map helpers App.tsx uses
// (realtime-first, snapshot fill-holes, requestId guard), so the question
// card state, its requestId and its resolution are derived exactly as a
// live renderer would.
//
// Each scenario asserts: one tool call → ONE requestId, ONE question_request
// event, pendingQuestion persisted → answer/cancel → ONE readable message →
// the session continues (answer) / does not (cancel).

describe('request_user_input outside-in acceptance (production harness)', () => {
  let tmpRoot: string
  let sm: InstanceType<typeof import('./SessionManager').SessionManager>
  let events: Array<Record<string, unknown>>
  const seededSessionIds = new Set<string>()

  const { makeQuestionRequest, makeAnswerResolution } = buildQuestionFixtures()

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-question-acceptance-'))
    sm = new SessionManager()
    events = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
      renderer.deliver(event)
    }) as never)
  })

  afterEach(async () => {
    sm.stopSessionMcpHost()
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    const queue = (sm as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
    for (const id of seededSessionIds) {
      try { queue.cancel(id) } catch { /* ignore */ }
    }
    seededSessionIds.clear()
    await new Promise(r => setTimeout(r, 650))
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildWorkspace() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  function seedSession(sessionId: string) {
    const filePath = getSessionFilePath(tmpRoot, sessionId)
    mkdirSync(dirname(filePath), { recursive: true })
    const stored = {
      id: sessionId,
      workspaceRootPath: tmpRoot,
      name: 'acceptance session',
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      messages: [] as unknown as StoredSession['messages'],
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, contextTokens: 0, costUsd: 0 },
    } as StoredSession
    writeSessionJsonl(filePath, stored)
    const managed = createManagedSession(
      { id: sessionId, name: stored.name, createdAt: stored.createdAt },
      buildWorkspace(),
    )
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(sessionId, managed)
    seededSessionIds.add(sessionId)
    return managed as unknown as {
      id: string
      processingGeneration: number
      isProcessing: boolean
      messages: Array<Record<string, unknown>>
      agent: Record<string, unknown>
      pendingAgentResume?: unknown
    }
  }

  function getManaged(sessionId: string) {
    return (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as unknown as {
      pendingQuestion?: { requestId: string } | null
      messages: Array<Record<string, unknown>>
      isProcessing: boolean
      pendingAgentResume?: unknown
    }
  }

  function questionEvents(): Array<Record<string, unknown>> {
    return events.filter(e => e.type === 'question_request')
  }

  function readableAnswerMessages(sessionId: string, requestId: string) {
    return getManaged(sessionId).messages.filter(
      m => m.role === 'user' && (m as { questionResponse?: { requestId: string } }).questionResponse?.requestId === requestId,
    )
  }

  async function waitForCondition(check: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('waitForCondition timed out')
  }

  // -------------------------------------------------------------------------
  // MOUNTED RENDERER harness: the production renderer pipeline
  // (event-processor + pending-question map helpers) fed with the exact
  // events the SessionManager broadcasts.
  // -------------------------------------------------------------------------

  const renderer = (() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const guard = new rendererModules.pending.PendingQuestionTerminalGuard()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let map = new Map<string, any>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const states = new Map<string, any>()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const deliver = (event: any): void => {
      const { events, pending } = rendererModules
      const sessionId = event.sessionId as string
      if (event.type === 'session_deleted') {
        map = pending.clearPendingQuestionForDeletedSession(map, sessionId, guard)
        return
      }
      if (typeof sessionId !== 'string') return
      let state = states.get(sessionId)
      if (!state) {
        state = {
          session: {
            id: sessionId,
            name: '',
            createdAt: 0,
            lastUsedAt: 0,
            messages: [],
            tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
          },
          streaming: null,
        }
        states.set(sessionId, state)
      }
      const { state: nextState, effects } = events.processEvent(state, event)
      states.set(sessionId, nextState)
      for (const effect of effects) {
        if (effect.type === 'question_request') {
          map = pending.setPendingQuestionForSession(map, sessionId, effect.request, guard)
        } else if (effect.type === 'question_resolved') {
          map = pending.removePendingQuestionForSession(map, sessionId, effect.requestId, guard)
        }
      }
    }
    return { pendingOf: (sessionId: string) => map.get(sessionId) ?? null, deliver }
  })()

  // -------------------------------------------------------------------------
  // MODEL-STUB agents: the turn's chat performs the model's tool call THROUGH
  // the engine's production consumption path. Scripted: turn 1 asks the user
  // a question via request_user_input; the continuation turn (after the
  // answer) simply completes.
  // -------------------------------------------------------------------------

  function scriptedAgent(turnActions: Array<(generation: number) => Promise<void>>) {
    let interrupted = 0
    let stampedGeneration = 0
    let chatCalls = 0
    const agent: Record<string, unknown> = {
      allowRequestUserInput: true,
      interruptForHandoff: () => { interrupted++ },
      forceAbort: () => {},
      setSessionTurnGeneration: (generation: number) => { stampedGeneration = generation },
      get sessionTurnGeneration() { return stampedGeneration },
      onQuestionRequested: null,
      // chatImpl: the model turn. The generation argument snapshot is the
      // production one (stamped at the turn-start boundary).
      chat: async function* () {
        const action = turnActions[chatCalls]
        chatCalls++
        if (action) await action(stampedGeneration)
        yield { type: 'complete' as const }
      },
      getModel: () => 'fake-model',
      getSessionId: () => null,
      isProcessing: () => false,
      supportsBranching: true,
      setAllSources: () => {},
      setSourceServers: async () => {},
      getSummarizeCallback: () => undefined,
      dispose: () => {},
      respondToPermission: () => {},
      get interruptedCount() { return interrupted },
      get chatCallCount() { return chatCalls },
    }
    return agent
  }

  /**
   * PRODUCTION WIRING mirror (ClaudeAgent construction): the SDK toolset's
   * context resolves its callbacks through the per-session registry, so the
   * registry forwards the toolset's call into the agent field (which
   * sendMessage's own wiring routes into the durable handoff) with the
   * initiation-time generation snapshot.
   */
  /**
   * PRODUCTION WIRING mirror (getOrCreateAgent): the agent field routes the
   * question callback into the durable handoff. The real getOrCreateAgent
   * assigns this; the stub replaces the method, so the wiring is mirrored
   * here 1:1 — same route, same managed object.
   */
  function wireAgentQuestionField(managed: ReturnType<typeof seedSession>, agent: Record<string, unknown>) {
    agent.onQuestionRequested = (questions: unknown[], generationAtRequest: number) =>
      (sm as unknown as {
        routeAgentQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void>
      }).routeAgentQuestionRequested(managed, questions, generationAtRequest)
  }

  function registerClaudeCallbackRegistry(agent: Record<string, unknown>) {
    sharedAgent.registerSessionScopedToolCallbacks(agent.sessionIdForTools as string, {
      onQuestionRequested: (questions, generationAtRequest) =>
        (agent.onQuestionRequested as ((q: unknown[], g: number) => Promise<void> | void) | null)?.(questions, generationAtRequest),
      getTurnGeneration: () => agent.sessionTurnGeneration as number,
    })
  }

  /** Build the real Claude SDK session toolset and connect a real MCP client to it. */
  async function connectClaudeToolset(sessionId: string, allowRequestUserInput: boolean) {
    const serverConfig = sharedAgent.getSessionScopedTools(
      sessionId,
      tmpRoot,
      'ws_test',
      undefined,
      tmpRoot,
      { allowRequestUserInput },
    ) as unknown as { instance: McpServer }
    const client = new Client({ name: 'claude-model-toolset', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([
      serverConfig.instance.connect(serverTransport),
      client.connect(clientTransport),
    ])
    return client
  }

  /** The model's tool call on the REAL Claude SDK session toolset. */
  async function claudeModelToolCall(sessionId: string, questions: unknown[]): Promise<void> {
    const client = await connectClaudeToolset(sessionId, true)
    // DISCOVERY: the tool is in the production toolset the model sees.
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain('request_user_input')
    const result = await client.callTool({ name: 'request_user_input', arguments: { questions } })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('Waiting for user input')
    await client.close()
  }

  // -------------------------------------------------------------------------
  // Engine 1: Claude — real turn, production SDK toolset, renderer observed.
  // -------------------------------------------------------------------------

  it('claude: a real desktop turn discovers and calls the tool from the production toolset; the renderer question state appears; the answer resumes with ONE readable message', async () => {
    const managed = seedSession('acc-claude-1')
    // The turn's model behavior: ask the user via the production toolset.
    const agent = scriptedAgent([
      generation => claudeModelToolCall(managed.id, makeQuestionRequest(managed.id).questions),
      async () => { /* continuation turn: the model completes with the answer in context */ },
    ])
    ;(agent as { sessionIdForTools: string }).sessionIdForTools = managed.id
    wireAgentQuestionField(managed, agent as Record<string, unknown>)
    registerClaudeCallbackRegistry(agent as Record<string, unknown>)
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent

    // REAL production turn.
    await sm.sendMessage(managed.id, 'please ask me what to do', [], [], { invocationSource: 'desktop' })

    // Server state: ONE durable handoff for the one tool call.
    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()
    expect(pending!.requestId).toEqual(expect.any(String))
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
    // The turn handed off: processing stopped, the agent was interrupted.
    expect(getManaged(managed.id).isProcessing).toBe(false)

    // MOUNTED RENDERER: the question card state derived from the SAME events.
    expect(renderer.pendingOf(managed.id)?.requestId).toBe(pending!.requestId)

    // Answer → ONE readable message → the session continues.
    const outcome = await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(sm.getPendingQuestion(managed.id)).toBeNull()
    expect(readableAnswerMessages(managed.id, pending!.requestId)).toHaveLength(1)
    expect(events.filter(e => e.type === 'question_resolved' && e.action === 'answer')).toHaveLength(1)
    // The continuation turn ran on the SAME session (single continuation).
    expect((agent as { chatCallCount: number }).chatCallCount).toBe(2)
    // The renderer card cleared through the production pipeline.
    expect(renderer.pendingOf(managed.id)).toBeNull()
  })

  it('claude: cancel through the production turn records ONE skip message and the session does not continue', async () => {
    const managed = seedSession('acc-claude-2')
    const agent = scriptedAgent([
      generation => claudeModelToolCall(managed.id, makeQuestionRequest(managed.id).questions),
      async () => { throw new Error('cancel must NOT resume the agent turn') },
    ])
    ;(agent as { sessionIdForTools: string }).sessionIdForTools = managed.id
    wireAgentQuestionField(managed, agent as Record<string, unknown>)
    registerClaudeCallbackRegistry(agent as Record<string, unknown>)
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent

    await sm.sendMessage(managed.id, 'please ask me what to do', [], [], { invocationSource: 'desktop' })
    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()
    expect(renderer.pendingOf(managed.id)?.requestId).toBe(pending!.requestId)

    const outcome = await sm.respondToQuestion(managed.id, { action: 'cancel', requestId: pending!.requestId })
    expect(outcome).toEqual({ status: 'cancelled' })
    expect(sm.getPendingQuestion(managed.id)).toBeNull()
    const cancelRecords = getManaged(managed.id).messages.filter(
      m => (m as { questionResolution?: { requestId: string } }).questionResolution?.requestId === pending!.requestId,
    )
    expect(cancelRecords).toHaveLength(1)
    // The turn's own user message + the ONE cancel record — nothing else.
    expect(getManaged(managed.id).messages.filter(m => m.role === 'user')).toHaveLength(2)
    expect(getManaged(managed.id).pendingAgentResume).toBeUndefined()
    expect(questionEvents()).toHaveLength(1)
    expect((agent as { chatCallCount: number }).chatCallCount).toBe(1)
    expect(renderer.pendingOf(managed.id)).toBeNull()
  })

  it('claude: the production toolset fails closed — a non-desktop tool assembly does not expose the tool', async () => {
    const managed = seedSession('acc-claude-3')
    const client = await connectClaudeToolset(managed.id, false)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).not.toContain('request_user_input')
    await client.close()
  })

  // -------------------------------------------------------------------------
  // Engine 2: Pi — real turn, production proxy toolset + dispatch.
  // -------------------------------------------------------------------------

  it('pi: a real desktop turn drives the durable handoff through the Pi production dispatch; the renderer observes the question; the answer resumes', async () => {
    const managed = seedSession('acc-pi-1')
    // A REAL PiAgent carries the production toolset builder + dispatch; the
    // turn's chat runs the model behavior through it.
    const pi = new sharedAgent.PiAgent({
      provider: 'pi',
      providerType: 'pi',
      workspace: { id: 'ws_test', name: 'Test Workspace', rootPath: tmpRoot, createdAt: Date.now() },
      session: { id: managed.id, workspaceRootPath: tmpRoot, createdAt: Date.now(), lastUsedAt: Date.now() },
      isHeadless: true,
      miniModel: '',
    } as never)
    const piFields = pi as unknown as {
      allowRequestUserInput: boolean
      buildSessionToolDefs: () => Array<{ name: string }>
      routeToolCall: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>
      chat: unknown
    }
    piFields.allowRequestUserInput = true

    const request = makeQuestionRequest(managed.id)
    // The REAL PiAgent IS the turn's agent — its chat runs the model
    // behavior through the production toolset + dispatch. The agent-field
    // question routing mirrors getOrCreateAgent's production wiring (the
    // stub replaces that method, so the route is wired here 1:1).
    wireAgentQuestionField(managed, pi as unknown as Record<string, unknown>)
    let chatCalls = 0
    piFields.chat = async function* () {
      if (chatCalls === 0) {
        chatCalls++
        // DISCOVERY: the exact toolset `register_tools` installs for the model.
        expect(piFields.buildSessionToolDefs().map(d => d.name)).toContain('mcp__session__request_user_input')
        // The subprocess-forwarded call takes the PRODUCTION dispatch path.
        const dispatched = await piFields.routeToolCall('mcp__session__request_user_input', { questions: request.questions })
        expect(dispatched.isError).toBe(false)
        expect(dispatched.content).toContain('Waiting for user input')
      }
      yield { type: 'complete' as const }
    }
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => pi

    await sm.sendMessage(managed.id, 'please ask me what to do', [], [], { invocationSource: 'desktop' })

    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
    expect(renderer.pendingOf(managed.id)?.requestId).toBe(pending!.requestId)

    const outcome = await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(readableAnswerMessages(managed.id, pending!.requestId)).toHaveLength(1)
    expect(questionEvents()).toHaveLength(1)
    expect(renderer.pendingOf(managed.id)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Engine 3: external Codex — real server process; sendMessage awaits the
  // spawn to full readiness BEFORE the model may start.
  // -------------------------------------------------------------------------

  it('external codex: sendMessage awaits the per-turn server readiness before chat; the real toolset exposes the tool; ONE call makes ONE durable handoff', async () => {
    const managed = seedSession('acc-codex-1')
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    const hostPortBefore = await sm.startSessionMcpHost({ serverEntryPath: serverEntry, nodeRuntimePath: process.execPath })
    expect(hostPortBefore).toBeGreaterThan(0)

    // ISSUE-2 REGRESSION: the model's first turn starts only AFTER the
    // per-turn server is fully ready (host listening + host-owned client
    // connected). The proof runs INSIDE the production chat boundary — no
    // test-side polling.
    let readinessAtChatStart: { childPresent: boolean } = { childPresent: false }
    const agent = scriptedAgent([
      async () => {
        const host = (sm as unknown as { sessionMcpHost: { children: Map<string, { ready: Promise<void> }> } | null }).sessionMcpHost
        const entry = host?.children.get(managed.id)
        readinessAtChatStart = { childPresent: !!entry }
        if (entry) await entry.ready
        // The production host-owned client is the external engine's channel;
        // its first tool call must work immediately at chat start.
        await sm.callSessionMcpRequestUserInput(managed.id, makeQuestionRequest(managed.id).questions)
      },
      async () => { /* continuation turn completes */ },
    ])
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent

    await sm.sendMessage(managed.id, 'please ask me what to do', [], [], { invocationSource: 'desktop' })

    // The chat could only start after the spawn's readiness edge.
    expect(readinessAtChatStart.childPresent).toBe(true)
    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
    expect(renderer.pendingOf(managed.id)?.requestId).toBe(pending!.requestId)

    const outcome = await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(readableAnswerMessages(managed.id, pending!.requestId)).toHaveLength(1)
    expect(renderer.pendingOf(managed.id)).toBeNull()
  }, 60000)

  it('external codex: an out-of-process harness sees the tool in tools/list and its call lands in ONE durable handoff; a non-desktop server fails closed', async () => {
    const managed = seedSession('acc-codex-2')
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    await sm.startSessionMcpHost({ serverEntryPath: serverEntry, nodeRuntimePath: process.execPath })
    // The production spawn boundary (sendMessage awaits it) — driven here on
    // an idle session so the out-of-process client can attach afterwards.
    await sm.spawnSessionMcpServerForTurn(managed.id, 'desktop', managed.processingGeneration)
    const host = (sm as unknown as { sessionMcpHost: { children: Map<string, { ready: Promise<void> }>; callbackPort: number } | null }).sessionMcpHost!
    await host.children.get(managed.id)!.ready

    const externalTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        serverEntry,
        '--session-id', managed.id,
        '--workspace-root', tmpRoot,
        '--plans-folder', join(tmpRoot, 'plans'),
        '--callback-port', String(host.callbackPort),
        '--allow-request-user-input',
        '--turn-generation', String(managed.processingGeneration),
      ],
      stderr: 'pipe',
    })
    const externalClient = new Client({ name: 'external-codex', version: '1.0.0' })
    await externalClient.connect(externalTransport)

    const tools = await externalClient.listTools()
    expect(tools.tools.map(t => t.name)).toContain('request_user_input')

    const request = makeQuestionRequest(managed.id)
    const result = await externalClient.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('Waiting for user input')

    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
    expect(renderer.pendingOf(managed.id)?.requestId).toBe(pending!.requestId)

    const outcome = await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(readableAnswerMessages(managed.id, pending!.requestId)).toHaveLength(1)
    await externalClient.close()
  }, 60000)

  it('external codex: a non-desktop server serves a toolset WITHOUT request_user_input (fail closed)', async () => {
    const managed = seedSession('acc-codex-3')
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    await sm.startSessionMcpHost({ serverEntryPath: serverEntry, nodeRuntimePath: process.execPath })
    await sm.spawnSessionMcpServerForTurn(managed.id, 'messaging', 1)
    const host = (sm as unknown as { sessionMcpHost: { children: Map<string, { ready: Promise<void> }>; callbackPort: number } | null }).sessionMcpHost!
    await host.children.get(managed.id)!.ready

    const externalTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        serverEntry,
        '--session-id', managed.id,
        '--workspace-root', tmpRoot,
        '--plans-folder', join(tmpRoot, 'plans'),
        '--callback-port', String(host.callbackPort),
        '--turn-generation', '1',
      ],
      stderr: 'pipe',
    })
    const externalClient = new Client({ name: 'external-codex', version: '1.0.0' })
    await externalClient.connect(externalTransport)
    const tools = await externalClient.listTools()
    expect(tools.tools.map(t => t.name)).not.toContain('request_user_input')
    const request = makeQuestionRequest(managed.id)
    const result = await externalClient.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
    expect(result.isError).toBe(true)
    expect(sm.getPendingQuestion(managed.id)).toBeNull()
    expect(questionEvents()).toHaveLength(0)
    expect(renderer.pendingOf(managed.id)).toBeNull()
    await externalClient.close()
  }, 60000)

  // -------------------------------------------------------------------------
  // Ownership: one channel per engine, no callback loops, no double delivery.
  // -------------------------------------------------------------------------

  it('one owner per engine: an embedded call never traverses the per-turn stdio child; the child channel serves the external engine', async () => {
    const managed = seedSession('acc-owner-1')
    const request = makeQuestionRequest(managed.id)
    const external = makeQuestionRequest(managed.id)
    // Both engine calls run INSIDE the live turn (the per-turn server is
    // stopped at turn end, so the ownership proof must hold mid-turn).
    const agent = scriptedAgent([
      async generation => {
        const host = (sm as unknown as { sessionMcpHost: { children: Map<string, { toolCalls: number }> } | null }).sessionMcpHost!
        // EMBEDDED call WITH a live child: goes DIRECT to the durable
        // handler — the child's tool call counter stays at zero (no
        // stdio/HTTP loop, exactly one durable handoff).
        await (sm as unknown as {
          routeAgentQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void>
        }).routeAgentQuestionRequested(
          (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(managed.id),
          request.questions,
          generation,
        )
        expect(host.children.get(managed.id)!.toolCalls).toBe(0)
        // EXTERNAL call: the child channel is a DIFFERENT engine's
        // consumption path — a replacement question with its own requestId,
        // still exactly ONE durable handoff per call.
        await sm.callSessionMcpRequestUserInput(managed.id, external.questions)
        expect(host.children.get(managed.id)!.toolCalls).toBe(1)
      },
    ])
    wireAgentQuestionField(managed, agent as Record<string, unknown>)
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    await sm.startSessionMcpHost({ serverEntryPath: serverEntry, nodeRuntimePath: process.execPath })

    // A production turn spawns and awaits the per-turn server, then the
    // scripted model performs both calls mid-turn.
    await sm.sendMessage(managed.id, 'please ask twice', [], [], { invocationSource: 'desktop' })

    expect(questionEvents()).toHaveLength(2)
    // Two DISTINCT requestIds — the external replacement replaced the
    // embedded question; the newest holds the card.
    const ids = questionEvents().map(e => (e as { request: { requestId: string } }).request.requestId)
    expect(new Set(ids).size).toBe(2)
    const pending = sm.getPendingQuestion(managed.id)
    expect(pending!.requestId).toBe(ids[1])
    expect(renderer.pendingOf(managed.id)?.requestId).toBe(pending!.requestId)
    // Settle with ONE resolution; the child served exactly one tool call.
    await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(1)
  }, 60000)

  // -------------------------------------------------------------------------
  // Restart recovery: the persisted pending question survives a restart.
  // -------------------------------------------------------------------------

  it('restart recovery: the persisted pending question is restored and answerable after a cold start; duplicate answers are idempotent', async () => {
    const managed = seedSession('acc-restart-1')
    const agent = scriptedAgent([
      generation => claudeModelToolCall(managed.id, makeQuestionRequest(managed.id).questions),
    ])
    ;(agent as { sessionIdForTools: string }).sessionIdForTools = managed.id
    wireAgentQuestionField(managed, agent as Record<string, unknown>)
    registerClaudeCallbackRegistry(agent as Record<string, unknown>)
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent

    await sm.sendMessage(managed.id, 'please ask me what to do', [], [], { invocationSource: 'desktop' })
    const before = sm.getPendingQuestion(managed.id)
    expect(before).not.toBeNull()
    expect(existsSync(getSessionFilePath(tmpRoot, managed.id))).toBe(true)

    // RESTART: a fresh SessionManager hydrates metadata-only ManagedSessions
    // from disk headers (the startup path).
    const sm2 = new SessionManager()
    sm2.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
      renderer.deliver(event)
    }) as never)
    try {
      const metas = listSessions(tmpRoot)
      for (const meta of metas) {
        ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set(meta.id, createManagedSession(meta, buildWorkspace()))
      }
      const pending = sm2.getPendingQuestion(managed.id)
      expect(pending?.requestId).toBe(before!.requestId)
      const outcome = await sm2.respondToQuestion(managed.id, makeAnswerResolution(pending!))
      expect(outcome).toEqual({ status: 'accepted' })
      const repeat = await sm2.respondToQuestion(managed.id, makeAnswerResolution(pending!))
      expect(repeat).toEqual({ status: 'already_answered' })
      const messages = ((sm2 as unknown as { sessions: Map<string, { messages: Array<Record<string, unknown>> }> })
        .sessions.get(managed.id)!.messages) as Array<Record<string, unknown>>
      const readable = messages.filter(
        m => m.role === 'user' && (m as { questionResponse?: { requestId: string } }).questionResponse?.requestId === pending!.requestId,
      )
      expect(readable).toHaveLength(1)
    } finally {
      const queue = (sm2 as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
      try { queue.cancel(managed.id) } catch { /* ignore */ }
    }
  })
})
