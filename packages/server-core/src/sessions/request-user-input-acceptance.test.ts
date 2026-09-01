// OUTSIDE-IN ACCEPTANCE for request_user_input — REAL production agents only.
//
// Every scenario starts from the PUBLIC production entry
// (`SessionManager.createSession` → `SessionManager.sendMessage`) and the
// agent is created by the PRODUCTION factory (`getOrCreateAgent` →
// `createBackendFromResolvedContext`). No scripted agents, no private-method
// invocation, no `getOrCreateAgent` overwrite. The ONLY thing replaced is the
// MODEL at the outermost real boundary of each backend:
//
// - Claude: the real ClaudeAgent.chat → real Claude Agent SDK query loop,
//   with the SDK's outermost subprocess (the native `claude` binary) resolved
//   through the production `claude-agent-sdk-binary` layout to a stub that
//   plays the model over the real stream-json/control protocol. The stub
//   discovers the toolset through a real MCP `tools/list` round-trip and
//   calls request_user_input through a real MCP `tools/call` round-trip —
//   both served by the production in-process session toolset
//   (`getSessionScopedTools`), landing in the unified durable handoff.
// - Pi: the real PiAgent.handlePrompt chain — the production factory spawns
//   the REAL pi-agent-server subprocess; the model is a local OpenAI-
//   compatible endpoint scripted at the HTTP boundary. The turn therefore
//   runs prompt → register_tools → model request (tool list visible to the
//   model) → tool_execute_request/response → agent_end exactly as in
//   production.
// - Pi × Codex OAuth: the SAME Pi backend with a connection configured the
//   way the product stores ChatGPT Plus / Codex OAuth connections
//   (providerType 'pi' + piAuthProvider 'openai-codex' + OAuth auth). The
//   model layer is pointed at the local endpoint for determinism; the tool
//   assembly and dispatch are the Pi production protocol. No independent
//   Codex CLI session exists anywhere on the path (the created backend is a
//   PiAgent).
//
// The MOUNTED RENDERER contract is observed through the production pipeline:
// every server event is delivered through the renderer event processor
// (`processEvent`) into the same pending-question map helpers App.tsx uses.
//
// Each scenario asserts: one tool call → ONE requestId, ONE question_request
// event, pendingQuestion persisted → answer/cancel → ONE readable message →
// the session continues (answer) / does not (cancel).

import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
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

// HERMETIC CONFIG — must be set before the first @polo-ai import (the config
// root is captured at module load). Test connections are injected through the
// production in-memory invocation override (setInvocationLlmConnections).
const configRoot = mkdtempSync(join(tmpdir(), 'sm-acceptance-config-'))
process.env.POLO_AI_CONFIG_DIR = configRoot

const { SessionManager, createManagedSession, setSessionPlatform } = await import('./SessionManager.ts')
const { getSessionFilePath, listSessions } = await import('@polo-ai/shared/sessions')
type StoredSession = import('@polo-ai/shared/sessions').StoredSession
const { buildQuestionFixtures } = await import('./request-user-input-fixtures.ts')
const sharedAgent = await import('@polo-ai/shared/agent')
const { setInvocationLlmConnections } = await import('@polo-ai/shared/config')

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const STUB_CLI_SOURCE = join(import.meta.dir, '__fixtures__', 'claude-stub-cli.mjs')

const ASK_MARKER = 'please ask me what to do'
const ANSWER_MARKER = 'Delete permanently'

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

describe('request_user_input outside-in acceptance (production agents)', () => {
  let tmpRoot: string
  let claudeRoot: string
  let piStagingLayout: string | null = null
  let sm: InstanceType<typeof import('./SessionManager').SessionManager>
  let events: Array<Record<string, unknown>>
  const seededSessionIds = new Set<string>()

  const { makeQuestionRequest, makeAnswerResolution } = buildQuestionFixtures()

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-question-acceptance-'))
    claudeRoot = mkdtempSync(join(tmpdir(), 'sm-acceptance-runtime-'))
    materializeClaudeRuntime(claudeRoot)
    sm = new SessionManager({ workspace: buildWorkspacePre() })
    events = []
    sm.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
      events.push(event)
      renderer.deliver(event)
    }) as never)
  })

  afterEach(async () => {
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.clear()
    const queue = (sm as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
    for (const id of seededSessionIds) {
      try { queue.cancel(id) } catch { /* ignore */ }
    }
    seededSessionIds.clear()
    await new Promise(r => setTimeout(r, 650))
    rmSync(tmpRoot, { recursive: true, force: true })
    rmSync(claudeRoot, { recursive: true, force: true })
  })

  afterAll(() => {
    if (piStagingLayout) {
      rmSync(piStagingLayout, { recursive: true, force: true })
      piStagingLayout = null
    }
    rmSync(configRoot, { recursive: true, force: true })
  })

  function buildWorkspacePre() {
    return {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    } as never
  }

  /**
   * Point the host runtime at `root`: the production binary layout
   * (`node_modules/@anthropic-ai/claude-agent-sdk-binary/claude`) is
   * materialized with the stub CLI, so the factory's runtime bootstrap
   * resolves and stamps the stub exactly like the real native binary.
   */
  function materializeClaudeRuntime(root: string): void {
    const binDir = join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk-binary')
    mkdirSync(binDir, { recursive: true })
    const stub = join(binDir, 'claude')
    copyFileSync(STUB_CLI_SOURCE, stub)
    chmodSync(stub, 0o755)
  }

  /** Host runtime for CLAUDE scenarios (stub binary layout). */
  function useClaudeHostRuntime(): void {
    // Claude scenarios run connection-less (default anthropic provider) —
    // clear any Pi connection override from earlier scenarios.
    setInvocationLlmConnections([], undefined)
    setSessionPlatform(buildPlatform(claudeRoot))
  }

  /**
   * Build the REAL pi-agent-server from the CURRENT HEAD source into a
   * temporary production layout (production build flags, scripts/build/
   * common.ts `buildMcpServers`). The resolver consumes THIS bundle — never
   * the gitignored workspace `dist/` and never a stale artifact from a
   * previous build: the staged bundle is fresh by construction, and the
   * scenario fails loudly if the build fails (the layout shadows the walk-up
   * path at resolution level 0).
   */
  function ensurePiServerStaging(): string {
    if (piStagingLayout) return piStagingLayout
    const layout = mkdtempSync(join(REPO_ROOT, 'node_modules', 'acceptance-pi-runtime-'))
    const outdir = join(layout, 'packages', 'pi-agent-server', 'dist')
    mkdirSync(outdir, { recursive: true })
    const src = join(REPO_ROOT, 'packages', 'pi-agent-server', 'src', 'index.ts')
    if (!existsSync(src)) {
      throw new Error(`acceptance setup: pi-agent-server source not found at ${src}`)
    }
    const build = Bun.spawnSync({
      cmd: [process.execPath, 'build', src, '--outdir', outdir, '--target', 'bun', '--format', 'esm', '--external', 'koffi'],
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const staged = join(outdir, 'index.js')
    if (build.exitCode !== 0 || !existsSync(staged)) {
      throw new Error(
        `acceptance setup: building pi-agent-server from source failed (exit ${build.exitCode})\n${build.stderr?.toString() ?? ''}`,
      )
    }
    piStagingLayout = layout
    return layout
  }

  /** Host runtime for PI scenarios (resolves the freshly staged pi server). */
  function usePiHostRuntime(): void {
    setSessionPlatform(buildPlatform(ensurePiServerStaging()))
  }

  function buildPlatform(appRootPath: string): import('@polo-ai/server-core/runtime').PlatformServices {
    return {
      appRootPath,
      resourcesPath: appRootPath,
      isPackaged: false,
      appVersion: 'test',
      imageProcessor: {
        getMetadata: async () => null,
        process: async (input: Buffer | string) => Buffer.from(input),
      },
      logger: {
        info: (...args: unknown[]) => console.log('[session]', ...args),
        warn: (...args: unknown[]) => console.warn('[session]', ...args),
        error: (...args: unknown[]) => console.error('[session]', ...args),
        debug: (...args: unknown[]) => console.debug('[session:debug]', ...args),
      },
      isDebugMode: false,
    }
  }

  /** Read the stub CLI's model-side trace. */
  function readTrace(tracePath: string): Array<Record<string, unknown>> {
    if (!existsSync(tracePath)) return []
    return readFileSync(tracePath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>)
  }

  function questionEvents(): Array<Record<string, unknown>> {
    return events.filter(e => e.type === 'question_request')
  }

  function readableAnswerMessages(sessionId: string, requestId: string) {
    return getManaged(sessionId).messages.filter(
      m => m.role === 'user' && (m as { questionResponse?: { requestId: string } }).questionResponse?.requestId === requestId,
    )
  }

  function getManaged(sessionId: string) {
    return (sm as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as unknown as {
      pendingQuestion?: { requestId: string } | null
      messages: Array<Record<string, unknown>>
      isProcessing: boolean
      pendingAgentResume?: unknown
      resumeRetryTimer?: ReturnType<typeof setTimeout>
      agent?: unknown
    }
  }

  function managedOf(manager: InstanceType<typeof import('./SessionManager').SessionManager>, sessionId: string) {
    return (manager as unknown as { sessions: Map<string, unknown> }).sessions.get(sessionId) as unknown as {
      pendingQuestion?: { requestId: string } | null
      messages: Array<Record<string, unknown>>
      isProcessing: boolean
      pendingAgentResume?: unknown
      resumeRetryTimer?: ReturnType<typeof setTimeout>
      agent?: unknown
    }
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
  // Local OpenAI-compatible model endpoint: scripts the Pi backend's REAL
  // model traffic at the HTTP boundary and captures what the model was sent.
  // -------------------------------------------------------------------------

  interface CapturedModelRequest {
    model?: string
    toolNames: string[]
    messageTexts: string[]
    finishReasons: string[]
  }

  function startFakeModelServer(handlers: Array<(body: Record<string, unknown>) => 'tool_call' | 'text'>) {
    const captured: CapturedModelRequest[] = []
    let requestIndex = 0
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url)
        if (!url.pathname.endsWith('/chat/completions')) {
          return new Response('not found', { status: 404 })
        }
        const body = await request.json() as Record<string, unknown>
        const toolCalls = (body.tools as Array<{ function?: { name?: string } }> | undefined) ?? []
        const messages = (body.messages as Array<{ content?: unknown }> | undefined) ?? []
        captured.push({
          model: body.model as string | undefined,
          toolNames: toolCalls.map(t => t.function?.name ?? '').filter(Boolean),
          messageTexts: messages.map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)),
          finishReasons: [],
        })
        const handler = handlers[Math.min(requestIndex, handlers.length - 1)]
        requestIndex += 1
        const kind = handler(body)

        const chunks: string[] = []
        const push = (delta: Record<string, unknown>, finish: string | null) => {
          chunks.push(`data: ${JSON.stringify({
            id: 'chatcmpl-stub',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test-model',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`)
        }
        if (kind === 'tool_call') {
          push({
            role: 'assistant',
            tool_calls: [{
              index: 0,
              id: 'call_stub_1',
              type: 'function',
              function: { name: 'mcp__session__request_user_input', arguments: JSON.stringify({ questions: makeQuestionRequest('pi').questions }) },
            }],
          }, null)
          push({}, 'tool_calls')
        } else {
          push({ role: 'assistant', content: 'Continuing with the user’s answer — done.' }, 'stop')
        }
        chunks.push(`data: ${JSON.stringify({
          id: 'chatcmpl-stub',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`)
        chunks.push('data: [DONE]\n\n')
        return new Response(chunks.join(''), {
          headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
        })
      },
    })
    return { server, captured, url: `http://127.0.0.1:${server.port}` }
  }

  /** Register a hermetic Pi connection through the production invocation override. */
  function usePiConnection(options: { slug: string; providerType: 'pi' | 'pi_compat'; piAuthProvider?: string; authType: 'api_key' | 'oauth'; baseUrl: string }) {
    setInvocationLlmConnections([{
      slug: options.slug,
      name: options.slug,
      providerType: options.providerType,
      authType: options.authType,
      ...(options.piAuthProvider ? { piAuthProvider: options.piAuthProvider } : {}),
      baseUrl: options.baseUrl,
      customEndpoint: { api: 'openai-completions' },
      models: ['test-model'],
      defaultModel: 'test-model',
      createdAt: Date.now(),
    }], options.slug)
  }

  async function createSessionViaProduction(name: string, llmConnection?: string): Promise<string> {
    const created = llmConnection
      ? await sm.createSession('ws_test', { name, llmConnection })
      : await sm.createSession('ws_test', { name })
    const id = (created as { id: string }).id
    seededSessionIds.add(id)
    return id
  }

  // -------------------------------------------------------------------------
  // Engine 1: Claude — REAL ClaudeAgent (production factory) + real SDK query
  // loop; only the outermost CLI subprocess is a scripted model.
  // -------------------------------------------------------------------------

  it('claude: a real desktop turn discovers and calls the tool from the production toolset; the renderer question state appears; the answer resumes with ONE readable message', async () => {
    useClaudeHostRuntime()
    const sessionId = await createSessionViaProduction('acc-claude-1')
    const tracePath = join(tmpRoot, 'claude-stub-trace.jsonl')
    process.env.POLO_STUB_TRACE = tracePath
    process.env.POLO_STUB_ASK_MARKER = ASK_MARKER
    process.env.POLO_STUB_QUESTIONS = JSON.stringify(makeQuestionRequest(sessionId).questions)

    try {
      // REAL production turn: public entry → production factory → real
      // ClaudeAgent → real SDK loop → stub model → real toolset → durable handoff.
      await sm.sendMessage(sessionId, ASK_MARKER, [], [], { invocationSource: 'desktop' })

      // The backend is a REAL ClaudeAgent created by the production factory.
      expect(getManaged(sessionId).agent).toBeInstanceOf(sharedAgent.ClaudeAgent)

      // MODEL-SIDE EVIDENCE: the stub discovered request_user_input through
      // the production toolset and called it through the MCP round-trip.
      const trace = readTrace(tracePath)
      expect(trace.filter(e => e.event === 'launch')).toHaveLength(1)
      const discovery = trace.find(e => e.event === 'tools_list') as { names: string[]; hasRequestUserInput: boolean } | undefined
      expect(discovery?.hasRequestUserInput).toBe(true)
      const toolResult = trace.find(e => e.event === 'tool_result') as { textHead: string } | undefined
      expect(toolResult?.textHead).toContain('Waiting for user input')

      // Server state: ONE durable handoff for the one tool call.
      const pending = sm.getPendingQuestion(sessionId)
      expect(pending).not.toBeNull()
      expect(pending!.requestId).toEqual(expect.any(String))
      expect(questionEvents()).toHaveLength(1)
      expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
      expect(getManaged(sessionId).isProcessing).toBe(false)

      // MOUNTED RENDERER: the question card state derived from the SAME events.
      expect(renderer.pendingOf(sessionId)?.requestId).toBe(pending!.requestId)

      // Answer → ONE readable message → the session continues on the SAME agent.
      const outcome = await sm.respondToQuestion(sessionId, makeAnswerResolution(pending!))
      expect(outcome).toEqual({ status: 'accepted' })
      expect(sm.getPendingQuestion(sessionId)).toBeNull()
      expect(readableAnswerMessages(sessionId, pending!.requestId)).toHaveLength(1)
      expect(events.filter(e => e.type === 'question_resolved' && e.action === 'answer')).toHaveLength(1)

      // The continuation ran as a SECOND real model turn (resumed SDK session).
      const traceAfter = readTrace(tracePath)
      const launches = traceAfter.filter(e => e.event === 'launch')
      expect(launches).toHaveLength(2)
      expect((launches[1] as { resume?: boolean }).resume).toBe(true)
      expect(getManaged(sessionId).pendingAgentResume).toBeUndefined()
      // The renderer card cleared through the production pipeline.
      expect(renderer.pendingOf(sessionId)).toBeNull()
    } finally {
      delete process.env.POLO_STUB_TRACE
      delete process.env.POLO_STUB_ASK_MARKER
      delete process.env.POLO_STUB_QUESTIONS
    }
  }, 60000)

  it('claude: cancel through the production turn records ONE skip message and the session does not continue', async () => {
    useClaudeHostRuntime()
    const sessionId = await createSessionViaProduction('acc-claude-2')
    const tracePath = join(tmpRoot, 'claude-stub-trace-cancel.jsonl')
    process.env.POLO_STUB_TRACE = tracePath
    process.env.POLO_STUB_ASK_MARKER = ASK_MARKER
    process.env.POLO_STUB_QUESTIONS = JSON.stringify(makeQuestionRequest(sessionId).questions)

    try {
      await sm.sendMessage(sessionId, ASK_MARKER, [], [], { invocationSource: 'desktop' })
      const pending = sm.getPendingQuestion(sessionId)
      expect(pending).not.toBeNull()
      expect(renderer.pendingOf(sessionId)?.requestId).toBe(pending!.requestId)

      const outcome = await sm.respondToQuestion(sessionId, { action: 'cancel', requestId: pending!.requestId })
      expect(outcome).toEqual({ status: 'cancelled' })
      expect(sm.getPendingQuestion(sessionId)).toBeNull()
      const cancelRecords = getManaged(sessionId).messages.filter(
        m => (m as { questionResolution?: { requestId: string } }).questionResolution?.requestId === pending!.requestId,
      )
      expect(cancelRecords).toHaveLength(1)
      // The turn's own user message + the ONE cancel record — nothing else.
      expect(getManaged(sessionId).messages.filter(m => m.role === 'user')).toHaveLength(2)
      expect(getManaged(sessionId).pendingAgentResume).toBeUndefined()
      expect(questionEvents()).toHaveLength(1)
      // NO continuation: the model was launched exactly once.
      expect(readTrace(tracePath).filter(e => e.event === 'launch')).toHaveLength(1)
      expect(renderer.pendingOf(sessionId)).toBeNull()
    } finally {
      delete process.env.POLO_STUB_TRACE
      delete process.env.POLO_STUB_ASK_MARKER
      delete process.env.POLO_STUB_QUESTIONS
    }
  }, 60000)

  // -------------------------------------------------------------------------
  // Engine 2: Pi — REAL PiAgent (production factory) + REAL pi-agent-server
  // subprocess; prompt → register_tools → tool_execute protocol with the
  // model scripted at the local OpenAI-compatible endpoint.
  // -------------------------------------------------------------------------

  it('pi: a real subprocess turn assembles the toolset for the model and drives the durable handoff through tool_execute; the answer resumes', async () => {
    usePiHostRuntime()
    const fake = startFakeModelServer([() => 'tool_call', () => 'text'])
    usePiConnection({ slug: 'pi-fake-acceptance', providerType: 'pi_compat', authType: 'api_key', baseUrl: fake.url })
    const sessionId = await createSessionViaProduction('acc-pi-1', 'pi-fake-acceptance')

    await sm.sendMessage(sessionId, ASK_MARKER, [], [], { invocationSource: 'desktop' })

    // The backend is a REAL PiAgent created by the production factory.
    expect(getManaged(sessionId).agent).toBeInstanceOf(sharedAgent.PiAgent)

    // MODEL-VISIBLE TOOLSET: the real model request carried the Pi session
    // toolset, including request_user_input (registered via register_tools).
    expect(fake.captured.length).toBeGreaterThanOrEqual(1)
    expect(fake.captured[0]!.toolNames).toContain('mcp__session__request_user_input')

    // ONE tool call → ONE durable handoff.
    const pending = sm.getPendingQuestion(sessionId)
    expect(pending).not.toBeNull()
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
    expect(renderer.pendingOf(sessionId)?.requestId).toBe(pending!.requestId)

    // Answer → ONE readable message → the continuation turn ran.
    const outcome = await sm.respondToQuestion(sessionId, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(readableAnswerMessages(sessionId, pending!.requestId)).toHaveLength(1)
    expect(questionEvents()).toHaveLength(1)
    expect(renderer.pendingOf(sessionId)).toBeNull()
    expect(getManaged(sessionId).pendingAgentResume).toBeUndefined()

    // The continuation prompt reached the model (second model request) with
    // the answer text in the conversation.
    await waitForCondition(() => fake.captured.length >= 2, 30000)
    const continuationText = fake.captured[1]!.messageTexts.join('\n')
    expect(continuationText).toContain(ASK_MARKER)
    expect(continuationText).toContain(ASK_MARKER.length ? ANSWER_MARKER : ANSWER_MARKER)

    fake.server.stop(true)
  }, 240000)

  // -------------------------------------------------------------------------
  // Engine 3: Pi × Codex OAuth — the ChatGPT Plus / Codex connection shape
  // rides the SAME Pi backend (no independent Codex CLI session anywhere).
  // -------------------------------------------------------------------------

  it('pi (Codex OAuth connection): the SAME Pi backend assembles the toolset and drives the durable handoff; no independent Codex CLI session is created', async () => {
    usePiHostRuntime()
    const fake = startFakeModelServer([() => 'tool_call', () => 'text'])
    // The product's Codex connection shape: Pi provider + openai-codex auth.
    // The model layer is pointed at the local endpoint for determinism.
    usePiConnection({
      slug: 'pi-codex-acceptance',
      providerType: 'pi',
      piAuthProvider: 'openai-codex',
      authType: 'oauth',
      baseUrl: fake.url,
    })
    const sessionId = await createSessionViaProduction('acc-pi-codex-1', 'pi-codex-acceptance')

    await sm.sendMessage(sessionId, ASK_MARKER, [], [], { invocationSource: 'desktop' })

    // The Codex-OAuth connection resolved to the PI backend — no separate
    // external engine / Codex CLI lifecycle exists.
    expect(getManaged(sessionId).agent).toBeInstanceOf(sharedAgent.PiAgent)
    expect(getManaged(sessionId).agent).not.toBeInstanceOf(sharedAgent.ClaudeAgent)

    // TOOL ASSEMBLY under the Codex connection: the model-visible toolset is
    // identical to any other Pi connection.
    expect(fake.captured.length).toBeGreaterThanOrEqual(1)
    expect(fake.captured[0]!.toolNames).toContain('mcp__session__request_user_input')

    // ONE tool call → ONE requestId, ONE question_request.
    const pending = sm.getPendingQuestion(sessionId)
    expect(pending).not.toBeNull()
    expect(questionEvents()).toHaveLength(1)
    expect((questionEvents()[0] as { request: { requestId: string } }).request.requestId).toBe(pending!.requestId)
    expect(renderer.pendingOf(sessionId)?.requestId).toBe(pending!.requestId)

    const outcome = await sm.respondToQuestion(sessionId, makeAnswerResolution(pending!))
    expect(outcome).toEqual({ status: 'accepted' })
    expect(readableAnswerMessages(sessionId, pending!.requestId)).toHaveLength(1)
    expect(questionEvents()).toHaveLength(1)
    expect(renderer.pendingOf(sessionId)).toBeNull()
    expect(getManaged(sessionId).pendingAgentResume).toBeUndefined()
    // The continuation ran on the SAME Pi backend (second model request).
    await waitForCondition(() => fake.captured.length >= 2, 30000)

    fake.server.stop(true)
  }, 240000)

  // -------------------------------------------------------------------------
  // Restart recovery: the persisted pending question survives a cold start and
  // the SAME session really CONTINUES — one continuation turn, the durable
  // resume state cleared, and no retry timers left behind (formal lifecycle
  // teardown through the public deleteSession).
  // -------------------------------------------------------------------------

  it('restart recovery: the persisted pending question is restored, answered, and the session CONTINUES on the restarted manager; no resume retries leak', async () => {
    useClaudeHostRuntime()
    const sessionId = await createSessionViaProduction('acc-restart-1')
    const tracePath = join(tmpRoot, 'claude-stub-trace-restart.jsonl')
    process.env.POLO_STUB_TRACE = tracePath
    process.env.POLO_STUB_ASK_MARKER = ASK_MARKER
    process.env.POLO_STUB_QUESTIONS = JSON.stringify(makeQuestionRequest(sessionId).questions)

    try {
      await sm.sendMessage(sessionId, ASK_MARKER, [], [], { invocationSource: 'desktop' })
      const before = sm.getPendingQuestion(sessionId)
      expect(before).not.toBeNull()
      expect(existsSync(getSessionFilePath(tmpRoot, sessionId))).toBe(true)

      // RESTART: a fresh SessionManager hydrates metadata-only ManagedSessions
      // from disk headers (the startup path).
      const sm2 = new SessionManager()
      sm2.setEventSink(((_channel: string, _target: unknown, event: Record<string, unknown>) => {
        events.push(event)
        renderer.deliver(event)
      }) as never)
      const sm2Queue = () => (sm2 as unknown as { sessionStorage: { persistenceQueue: { cancel: (id: string) => void } } }).sessionStorage.persistenceQueue
      try {
        const metas = listSessions(tmpRoot)
        for (const meta of metas) {
          ;(sm2 as unknown as { sessions: Map<string, unknown> }).sessions.set(meta.id, createManagedSession(meta, buildWorkspacePre()))
        }
        const pending = sm2.getPendingQuestion(sessionId)
        expect(pending?.requestId).toBe(before!.requestId)

        // Answer → accepted → the SAME session CONTINUES: the resumed turn is
        // a REAL second model run (launch #2, resumed SDK session).
        const outcome = await sm2.respondToQuestion(sessionId, makeAnswerResolution(pending!))
        expect(outcome).toEqual({ status: 'accepted' })
        const repeat = await sm2.respondToQuestion(sessionId, makeAnswerResolution(pending!))
        expect(repeat).toEqual({ status: 'already_answered' })

        await waitForCondition(() => readTrace(tracePath).filter(e => e.event === 'launch').length >= 2, 30000)
        const resumedManaged = managedOf(sm2, sessionId)
        expect(resumedManaged.pendingAgentResume).toBeUndefined()
        expect(resumedManaged.resumeRetryTimer).toBeUndefined()

        // ONE readable answer message on the persisted session.
        const messages = resumedManaged.messages
        const readable = messages.filter(
          m => m.role === 'user' && (m as { questionResponse?: { requestId: string } }).questionResponse?.requestId === pending!.requestId,
        )
        expect(readable).toHaveLength(1)

        // FORMAL LIFECYCLE TEARDOWN: the public delete API stops the session —
        // no retry timer, no background work, nothing left in the runtime map.
        await sm2.deleteSession(sessionId)
        expect((sm2 as unknown as { sessions: Map<string, unknown> }).sessions.has(sessionId)).toBe(false)
        expect(resumedManaged.resumeRetryTimer).toBeUndefined()
        expect(resumedManaged.pendingAgentResume).toBeUndefined()
      } finally {
        sm2Queue().cancel(sessionId)
      }
    } finally {
      delete process.env.POLO_STUB_TRACE
      delete process.env.POLO_STUB_ASK_MARKER
      delete process.env.POLO_STUB_QUESTIONS
    }
  }, 120000)
})

