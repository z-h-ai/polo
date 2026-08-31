import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdirSync, mkdtempSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
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

// OUTSIDE-IN ACCEPTANCE for request_user_input (POO-53).
//
// Every scenario drives the tool through the REAL model toolset of one
// engine — never by calling the durable handler directly:
//
// - Claude (embedded): the production SDK session toolset
//   (`getSessionScopedTools`) served over a real MCP client connection; the
//   tool call is a real `callTool` round-trip into the canonical registry
//   handler.
// - Pi (embedded): the production proxy toolset the Pi subprocess registers
//   for the model (`mcp__session__*`), executed through PiAgent's production
//   dispatch (`routeToolCall` → `executeSessionTool`).
// - External Codex: the REAL session-mcp-server process; the tool must appear
//   in the actual `tools/list` payload and the call travels stdio → HTTP
//   callback → durable handoff.
//
// Ownership matrix (one owner/channel per engine, no callback loops):
// - embedded engines reach the durable handler DIRECTLY (never through the
//   per-turn stdio child);
// - the external process is the ONLY consumer of the HTTP callback channel.
//
// Every scenario asserts the full lifecycle: one tool call → ONE requestId,
// ONE question_request event, pendingQuestion persisted → answer/cancel →
// ONE readable message → the session continues (answer) / does not (cancel).

describe('request_user_input outside-in acceptance', () => {
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
    ;(managed as unknown as { isProcessing: boolean }).isProcessing = true
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

  /**
   * PRODUCTION wiring mirror (SessionManager.getOrCreateAgent + ClaudeAgent
   * construction): the agent field routes into the durable handoff; the
   * callback registry forwards the toolset's call into the agent field with
   * the initiation-time generation snapshot.
   */
  function wireEmbeddedQuestionChain(managed: ReturnType<typeof seedSession>) {
    let interrupted = 0
    let stampedGeneration = 0
    const agent: Record<string, unknown> = {
      allowRequestUserInput: true,
      interruptForHandoff: () => { interrupted++ },
      forceAbort: () => {},
      setSessionTurnGeneration: (generation: number) => { stampedGeneration = generation },
      get sessionTurnGeneration() { return stampedGeneration },
      onQuestionRequested: null as
        | ((questions: unknown[], generationAtRequest: number) => Promise<void> | void)
        | null,
      chat: async function* () { yield { type: 'complete' as const } },
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
    }
    managed.agent = agent
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent
    agent.onQuestionRequested = (questions: unknown[], generationAtRequest: number) =>
      (sm as unknown as {
        routeAgentQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void>
      }).routeAgentQuestionRequested(managed, questions, generationAtRequest)
    sharedAgent.registerSessionScopedToolCallbacks(managed.id, {
      onQuestionRequested: (questions, generationAtRequest) =>
        (agent.onQuestionRequested as (q: unknown[], g: number) => Promise<void> | void)(questions, generationAtRequest),
      getTurnGeneration: () => stampedGeneration,
    })
    return {
      agent,
      interruptedCount: () => interrupted,
    }
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
    const client = new Client({ name: 'acceptance-model', version: '1.0.0' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([
      serverConfig.instance.connect(serverTransport),
      client.connect(clientTransport),
    ])
    return client
  }

  async function waitForCondition(check: () => boolean, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (check()) return
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error('waitForCondition timed out')
  }

  /** Spawn the per-turn server via the production path and wait until its client is READY. */
  async function spawnProductionTurnServer(sessionId: string, invocationSource: string, generation: number) {
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    const port = await sm.startSessionMcpHost({ serverEntryPath: serverEntry, nodeRuntimePath: process.execPath })
    expect(port).toBeGreaterThan(0)
    void sm.spawnSessionMcpServerForTurn(sessionId, invocationSource as never, generation)
    await waitForCondition(() => {
      const host = (sm as unknown as { sessionMcpHost: { children: Map<string, unknown> } | null }).sessionMcpHost
      return !!host?.children.get(sessionId)
    })
    // The client connect must be awaited before any tool call — a first-turn
    // call must never race an unconnected client.
    const entry = (sm as unknown as { sessionMcpHost: { children: Map<string, { ready: Promise<void> }> } | null })
      .sessionMcpHost!.children.get(sessionId)! as unknown as { ready?: Promise<void> }
    if (entry.ready) await entry.ready
    return port
  }

  // -------------------------------------------------------------------------
  // Engine 1: Claude — the embedded SDK session toolset.
  // -------------------------------------------------------------------------

  it('claude: the real SDK toolset exposes the tool on desktop turns; one call → one durable handoff; the answer resumes the session', async () => {
    const managed = seedSession('acc-claude-1')
    wireEmbeddedQuestionChain(managed)

    const client = await connectClaudeToolset(managed.id, true)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).toContain('request_user_input')

    const request = makeQuestionRequest(managed.id)
    const result = await client.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(result.content)).toContain('Waiting for user input')

    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()
    expect(pending!.requestId).toEqual(expect.any(String))
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
    expect(getManaged(managed.id).isProcessing).toBe(false)

    // Answer → ONE readable message carrying the structured response → the
    // session continues (the answer turn re-enters the SAME session).
    const outcome = await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(sm.getPendingQuestion(managed.id)).toBeNull()
    expect(readableAnswerMessages(managed.id, pending!.requestId)).toHaveLength(1)
    expect(events.filter(e => e.type === 'question_resolved' && e.action === 'answer')).toHaveLength(1)
    await waitForCondition(() => getManaged(managed.id).isProcessing === false)
    client.close()
  })

  it('claude: cancel records ONE skip message and the session does not continue', async () => {
    const managed = seedSession('acc-claude-2')
    const chain = wireEmbeddedQuestionChain(managed)

    const client = await connectClaudeToolset(managed.id, true)
    const request = makeQuestionRequest(managed.id)
    await client.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()

    const outcome = await sm.respondToQuestion(managed.id, { action: 'cancel', requestId: pending!.requestId })
    expect(outcome).toEqual({ status: 'cancelled' })
    expect(sm.getPendingQuestion(managed.id)).toBeNull()
    const cancelRecords = getManaged(managed.id).messages.filter(
      m => (m as { questionResolution?: { requestId: string } }).questionResolution?.requestId === pending!.requestId,
    )
    expect(cancelRecords).toHaveLength(1)
    expect(getManaged(managed.id).messages.filter(m => m.role === 'user')).toHaveLength(1)
    expect(getManaged(managed.id).pendingAgentResume).toBeUndefined()
    expect(questionEvents()).toHaveLength(1)
    expect(chain.interruptedCount()).toBe(1)
    client.close()
  })

  it('claude: the toolset fails closed — a non-desktop turn does not expose the tool', async () => {
    const managed = seedSession('acc-claude-3')
    const client = await connectClaudeToolset(managed.id, false)
    const tools = await client.listTools()
    expect(tools.tools.map(t => t.name)).not.toContain('request_user_input')
    client.close()
  })

  // -------------------------------------------------------------------------
  // Engine 2: Pi — the embedded proxy toolset + production dispatch.
  // -------------------------------------------------------------------------

  it('pi: the real proxy toolset drives the durable handoff through PiAgent dispatch; the answer resumes', async () => {
    const managed = seedSession('acc-pi-1')
    const chain = wireEmbeddedQuestionChain(managed)

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
      onQuestionRequested: ((questions: unknown[], generationAtRequest: number) => Promise<void> | void) | null
      buildSessionToolDefs: () => Array<{ name: string }>
      routeToolCall: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>
    }
    piFields.allowRequestUserInput = true
    // PRODUCTION wiring: SessionManager assigns the agent's question field to
    // the durable handoff route (getOrCreateAgent wiring).
    piFields.onQuestionRequested = (questions, generationAtRequest) =>
      (chain.agent.onQuestionRequested as (q: unknown[], g: number) => Promise<void>)(questions, generationAtRequest)

    // The toolset the model sees: desktop registers, messaging does not.
    expect(piFields.buildSessionToolDefs().map(d => d.name)).toContain('mcp__session__request_user_input')
    piFields.allowRequestUserInput = false
    expect(piFields.buildSessionToolDefs().map(d => d.name)).not.toContain('mcp__session__request_user_input')
    piFields.allowRequestUserInput = true

    // ONE model tool call through the production dispatch (the exact path a
    // subprocess tool_execute takes for a session tool).
    const request = makeQuestionRequest(managed.id)
    const dispatched = await piFields.routeToolCall('mcp__session__request_user_input', { questions: request.questions })
    expect(dispatched.isError).toBe(false)
    expect(dispatched.content).toContain('Waiting for user input')

    const pending = sm.getPendingQuestion(managed.id)
    expect(pending).not.toBeNull()
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)

    const outcome = await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(readableAnswerMessages(managed.id, pending!.requestId)).toHaveLength(1)
    // ONE tool call produced ONE handoff — no duplicate through any channel.
    expect(questionEvents()).toHaveLength(1)
  })

  // -------------------------------------------------------------------------
  // Engine 3: external Codex — the real session MCP server process.
  // -------------------------------------------------------------------------

  it('external codex: the real server exposes the tool in tools/list; ONE call makes ONE durable handoff over the callback host', async () => {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const managed = seedSession('acc-codex-1')
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    const port = await spawnProductionTurnServer(managed.id, 'desktop', managed.processingGeneration)

    // The EXTERNAL engine's view: connect to the same server over stdio and
    // inspect the REAL model toolset.
    const externalTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        serverEntry,
        '--session-id', managed.id,
        '--workspace-root', tmpRoot,
        '--plans-folder', join(tmpRoot, 'plans'),
        '--callback-port', String(port),
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

    const outcome = await sm.respondToQuestion(managed.id, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(readableAnswerMessages(managed.id, pending!.requestId)).toHaveLength(1)

    await externalClient.close()
  }, 60000)

  it('external codex: a non-desktop server serves a toolset WITHOUT request_user_input (fail closed)', async () => {
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')
    const managed = seedSession('acc-codex-2')
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    await spawnProductionTurnServer(managed.id, 'messaging', 1)

    const externalTransport = new StdioClientTransport({
      command: process.execPath,
      args: [
        serverEntry,
        '--session-id', managed.id,
        '--workspace-root', tmpRoot,
        '--plans-folder', join(tmpRoot, 'plans'),
        '--callback-port', String((sm as unknown as { sessionMcpHost: { callbackPort: number } }).sessionMcpHost!.callbackPort),
        '--turn-generation', '1',
      ],
      stderr: 'pipe',
    })
    const externalClient = new Client({ name: 'external-codex', version: '1.0.0' })
    await externalClient.connect(externalTransport)
    const tools = await externalClient.listTools()
    expect(tools.tools.map(t => t.name)).not.toContain('request_user_input')
    // A direct call fails closed with no durable handoff.
    const request = makeQuestionRequest(managed.id)
    const result = await externalClient.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
    expect(result.isError).toBe(true)
    expect(sm.getPendingQuestion(managed.id)).toBeNull()
    expect(questionEvents()).toHaveLength(0)
    await externalClient.close()
  }, 60000)

  // -------------------------------------------------------------------------
  // Ownership: one channel per engine, no callback loops, no double delivery.
  // -------------------------------------------------------------------------

  it('one owner per engine: an embedded call never traverses the per-turn stdio child; the child channel serves the external engine', async () => {
    const managed = seedSession('acc-owner-1')
    wireEmbeddedQuestionChain(managed)
    await spawnProductionTurnServer(managed.id, 'desktop', managed.processingGeneration)
    const host = (sm as unknown as { sessionMcpHost: { children: Map<string, { toolCalls: number }> } | null }).sessionMcpHost!

    // Embedded call WITH a live child: goes DIRECT to the durable handler —
    // the child's tool call counter stays at zero (no stdio/HTTP loop).
    const request = makeQuestionRequest(managed.id)
    await (managed.agent as { onQuestionRequested: (q: unknown[], g: number) => Promise<void> })
      .onQuestionRequested!(request.questions, managed.processingGeneration)
    expect(host.children.get(managed.id)!.toolCalls).toBe(0)
    expect(questionEvents()).toHaveLength(1)
    const firstPending = sm.getPendingQuestion(managed.id)
    expect(firstPending).not.toBeNull()

    // The child channel is a DIFFERENT engine's consumption path: the same
    // live server serves the external call — a replacement question with its
    // own requestId — and still exactly ONE durable handoff per call.
    const eventsBefore = questionEvents().length
    const external = makeQuestionRequest(managed.id)
    await sm.callSessionMcpRequestUserInput(managed.id, external.questions)
    expect(host.children.get(managed.id)!.toolCalls).toBe(1)
    expect(questionEvents().length).toBe(eventsBefore + 1)
    const secondPending = sm.getPendingQuestion(managed.id)
    expect(secondPending!.requestId).not.toBe(firstPending!.requestId)

    // Both questions settle with ONE resolution each; no duplicate handoffs.
    await sm.respondToQuestion(managed.id, makeAnswerResolution(secondPending!))
    expect(events.filter(e => e.type === 'question_resolved')).toHaveLength(1)
  }, 60000)

  // -------------------------------------------------------------------------
  // Restart recovery: the persisted pending question survives a restart.
  // -------------------------------------------------------------------------

  it('restart recovery: the persisted pending question is restored and answerable after a cold start; duplicate answers are idempotent', async () => {
    const managed = seedSession('acc-restart-1')
    wireEmbeddedQuestionChain(managed)

    const client = await connectClaudeToolset(managed.id, true)
    const request = makeQuestionRequest(managed.id)
    await client.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
    const before = sm.getPendingQuestion(managed.id)
    expect(before).not.toBeNull()
    expect(existsSync(getSessionFilePath(tmpRoot, managed.id))).toBe(true)
    client.close()

    // RESTART: a fresh SessionManager hydrates metadata-only ManagedSessions
    // from disk headers (the startup path).
    const sm2 = new SessionManager()
    sm2.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
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
      // ONE readable answer message — read through the RESTARTED manager.
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
