import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js'

// REACT-MOUNTED outside-in acceptance: every engine drives a REAL production
// turn (SessionManager.sendMessage), the pending question flows through the
// production renderer pipeline (event-processor + pending-question map
// helpers), and the user answers/skips through the MOUNTED QuestionRequest
// component — the same component the desktop input area renders.

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
const { setupI18n, i18n } = await import('@polo-ai/shared/i18n/setupI18n')
setupI18n()

const { cleanup, render, screen, act } = await import('@testing-library/react')
const { I18nextProvider } = await import('react-i18next')
const { createElement } = await import('react')
const { QuestionRequest } = await import('./QuestionRequest')

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..', '..', '..', '..')

const { SessionManager } = await import('@polo-ai/server-core/sessions')
const { getSessionFilePath, writeSessionJsonl } = await import('@polo-ai/shared/sessions')
type StoredSession = import('@polo-ai/shared/sessions').StoredSession
const sharedAgent = await import('@polo-ai/shared/agent')
const rendererEvents: any = await import('../../../../event-processor/processor.ts')
const rendererPending: any = await import('../../../../lib/pending-questions.ts')

describe('request_user_input React-mounted acceptance', () => {
  let tmpRoot: string
  let sm: any
  let events: Array<Record<string, unknown>>
  const seededSessionIds = new Set<string>()

  function makeRequest(sessionId: string): any {
    return {
      requestId: `q-${sessionId}`,
      sessionId,
      createdAt: Date.now(),
      questions: [
        {
          id: 'data',
          header: 'Data',
          question: 'What should happen to related data?',
          options: [
            { id: 'trash', label: 'Move to Trash', description: 'Recoverable', recommended: true },
            { id: 'delete', label: 'Delete permanently', description: 'Immediate' },
          ],
        },
      ],
    }
  }

  function makeAnswer(request: any): any {
    return {
      action: 'answer',
      response: {
        requestId: request.requestId,
        answers: [{ questionId: 'data', selectedOptionIds: ['delete'] }],
      },
    }
  }

  // Production renderer pipeline: events → processEvent → pending map.
  const renderer = (() => {
    const guard = new rendererPending.PendingQuestionTerminalGuard()
    let map = new Map<string, any>()
    const states = new Map<string, any>()
    return {
      pendingOf: (sessionId: string) => map.get(sessionId) ?? null,
      deliver(event: any): void {
        const sessionId = event.sessionId as string
        if (event.type === 'session_deleted') {
          map = rendererPending.clearPendingQuestionForDeletedSession(map, sessionId, guard)
          return
        }
        if (typeof sessionId !== 'string') return
        let state = states.get(sessionId)
        if (!state) {
          state = {
            session: {
              id: sessionId, name: '', createdAt: 0, lastUsedAt: 0, messages: [],
              tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, contextTokens: 0 },
            },
            streaming: null,
          }
          states.set(sessionId, state)
        }
        const { state: nextState, effects } = rendererEvents.processEvent(state, event)
        states.set(sessionId, nextState)
        for (const effect of effects) {
          if (effect.type === 'question_request') {
            map = rendererPending.setPendingQuestionForSession(map, sessionId, effect.request, guard)
          } else if (effect.type === 'question_resolved') {
            map = rendererPending.removePendingQuestionForSession(map, sessionId, effect.requestId, guard)
          }
        }
      },
    }
  })()

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'react-acceptance-'))
    sm = new SessionManager({ workspace: { id: 'ws_test', name: 'WS', slug: 'ws_test', rootPath: tmpRoot, createdAt: Date.now() } })
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
    cleanup()
  })

  async function seedEmbeddedSession(sessionId: string) {
    // PRODUCTION creation path.
    await sm.createSession('ws_test', { name: sessionId })
    // The created session keeps its generated id; rename the map key by
    // reading the created session.
    const created = (sm as unknown as { getSessions: () => Array<{ id: string; name?: string }> }).getSessions()
      .find(s => s.name === sessionId)!
    const managed = (sm as unknown as { sessions: Map<string, any> }).sessions.get(created.id)!
    seededSessionIds.add(created.id)
    return { managed, sessionId: created.id } as { managed: any; sessionId: string }
  }

  /**
   * Mount the REAL QuestionRequest card with the pending question from the
   * renderer pipeline; onSubmit routes into the SessionManager's durable
   * resolution; onCancel skips.
   */
  async function mountQuestionCard(sessionId: string) {
    const pending = renderer.pendingOf(sessionId)
    expect(pending).not.toBeNull()
    let submitted: any = null
    let cancelled: string | null = null
    const view = render(
      createElement(
        I18nextProvider,
        { i18n },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createElement(QuestionRequest as any, {
          request: pending,
          onSubmit: async (response: any) => {
            submitted = response
            await sm.respondToQuestion(sessionId, { action: 'answer', response })
          },
          onCancel: async (requestId: string) => {
            cancelled = requestId
            await sm.respondToQuestion(sessionId, { action: 'cancel', requestId })
          },
        }),
      ),
    )
    return {
      view,
      get submitted() { return submitted },
      get cancelled() { return cancelled },
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

  function readableMessages(sessionId: string, requestId: string) {
    const managed = (sm as unknown as { sessions: Map<string, { messages?: Array<any> }> }).sessions.get(sessionId)
    return (managed?.messages ?? []).filter(
      (m: any) => m.role === 'user' && m.questionResponse?.requestId === requestId,
    )
  }

  // -------------------------------------------------------------------------
  // Claude: real SDK toolset → durable handoff → mounted card → answer.
  // -------------------------------------------------------------------------

  it('claude: the mounted question card answers the durable pending question; ONE readable message; the session continues', async () => {
    const { managed, sessionId } = await seedEmbeddedSession('react-claude-1')
    const request = makeRequest(sessionId)
    // The turn's model behavior: ask via the REAL production SDK toolset.
    let chatCalls = 0
    const agent: Record<string, unknown> = {
      allowRequestUserInput: true,
      interruptForHandoff: () => {},
      forceAbort: () => {},
      setSessionTurnGeneration: () => {},
      get sessionTurnGeneration() { return (managed as unknown as { processingGeneration: number }).processingGeneration },
      onQuestionRequested: null as unknown,
      chat: async function* () {
        // The model asks ONCE (turn 1); the continuation answers from history.
        if (chatCalls === 0) {
          const serverConfig = sharedAgent.getSessionScopedTools(
            sessionId, tmpRoot, 'ws_test', undefined, tmpRoot,
            { allowRequestUserInput: true },
          ) as unknown as { instance: McpServer }
          const client = new Client({ name: 'claude-model-toolset', version: '1.0.0' })
          const [ct, st] = InMemoryTransport.createLinkedPair()
          await Promise.all([serverConfig.instance.connect(st), client.connect(ct)])
          const result = await client.callTool({ name: 'request_user_input', arguments: { questions: request.questions } })
          expect(result.isError).toBeFalsy()
          await client.close()
        }
        chatCalls += 1
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
    }
    managed.agent = agent
    const sessionsMap = (sm as unknown as { sessions: Map<string, unknown> }).sessions
    let mapClears = 0
    ;(sessionsMap as unknown as { clear: () => void }).clear = function () {
      mapClears++
    }
    const realDelete = (sm as unknown as { deleteSession: (id: string) => Promise<void> }).deleteSession.bind(sm)
    ;(sm as unknown as { deleteSession: (id: string) => Promise<void> }).deleteSession = async (id: string) => {
      return realDelete(id)
    }
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent
    agent.onQuestionRequested = (questions: unknown[], generationAtRequest: number) =>
      (sm as unknown as {
        routeAgentQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void>
      }).routeAgentQuestionRequested(managed, questions, generationAtRequest)
    sharedAgent.registerSessionScopedToolCallbacks(sessionId, {
      onQuestionRequested: (questions: unknown[], generationAtRequest: number) =>
        (agent.onQuestionRequested as (q: unknown[], g: number) => Promise<void> | void)(questions, generationAtRequest),
      getTurnGeneration: () => (managed as unknown as { processingGeneration: number }).processingGeneration,
    })

    // REAL production turn.
    await sm.sendMessage(sessionId, 'please ask me', [], [], { invocationSource: 'desktop' })
    const pending = sm.getPendingQuestion(sessionId)
    expect(pending).not.toBeNull()

    // Mount the REAL question card and answer through it.
    const card = await mountQuestionCard(sessionId)
    await act(async () => {
      (screen.getByTestId('question-option-data-delete') as HTMLButtonElement).click()
    })
    await act(async () => {
      (screen.getByTestId('question-confirm') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(card.submitted).not.toBeNull()
    expect(card.submitted.requestId).toBe(pending!.requestId)

    // The durable resolution settles asynchronously (the events trail the
    // in-memory mutation) — wait for the resolution boundary.
    await waitForCondition(
      () => events.some(e => e.type === 'question_resolved' && e.requestId === pending!.requestId),
      15000,
    )
    expect(sm.getPendingQuestion(sessionId)).toBeNull()
    expect(readableMessages(sessionId, pending!.requestId)).toHaveLength(1)
    // ONE durable handoff; the renderer card cleared.
    expect(events.filter(e => e.type === 'question_request')).toHaveLength(1)
    expect(renderer.pendingOf(sessionId)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Pi: real proxy toolset dispatch → mounted card → cancel.
  // -------------------------------------------------------------------------

  it('pi: the mounted question card skips the durable pending question; ONE skip record; the session does not continue', async () => {
    const { managed, sessionId } = await seedEmbeddedSession('react-pi-1')
    const agent: Record<string, unknown> = {
      allowRequestUserInput: true,
      interruptForHandoff: () => {},
      forceAbort: () => {},
      setSessionTurnGeneration: () => {},
      get sessionTurnGeneration() { return (managed as unknown as { processingGeneration: number }).processingGeneration },
      onQuestionRequested: null as unknown,
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
    }
    managed.agent = agent
    const sessionsMap = (sm as unknown as { sessions: Map<string, unknown> }).sessions
    let mapClears = 0
    ;(sessionsMap as unknown as { clear: () => void }).clear = function () {
      mapClears++
    }
    const realDelete = (sm as unknown as { deleteSession: (id: string) => Promise<void> }).deleteSession.bind(sm)
    ;(sm as unknown as { deleteSession: (id: string) => Promise<void> }).deleteSession = async (id: string) => {
      return realDelete(id)
    }
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => agent
    agent.onQuestionRequested = (questions: unknown[], generationAtRequest: number) =>
      (sm as unknown as {
        routeAgentQuestionRequested: (m: unknown, q: unknown[], g: number) => Promise<void>
      }).routeAgentQuestionRequested(managed, questions, generationAtRequest)

    const pi = new sharedAgent.PiAgent({
      provider: 'pi',
      providerType: 'pi',
      workspace: { id: 'ws_test', name: 'WS', rootPath: tmpRoot, createdAt: Date.now() },
      session: { id: sessionId, workspaceRootPath: tmpRoot, createdAt: Date.now(), lastUsedAt: Date.now() },
      isHeadless: true,
      miniModel: '',
    } as never)
    const piFields = pi as unknown as {
      allowRequestUserInput: boolean
      onQuestionRequested: ((q: unknown[], g: number) => Promise<void> | void) | null
      routeToolCall: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>
      chat: (message?: string, attachments?: unknown) => AsyncGenerator<{ type: string }>
    }
    piFields.allowRequestUserInput = true
    // PRODUCTION wiring (getOrCreateAgent mirror): the agent field routes the
    // question into the durable handoff.
    piFields.onQuestionRequested = (questions, generationAtRequest) =>
      (agent.onQuestionRequested as (q: unknown[], g: number) => Promise<void> | void)(questions, generationAtRequest)

    const request = makeRequest(sessionId)
    // The turn's model behavior: ask via the production proxy dispatch.
    let chatCalls = 0
    piFields.chat = async function* () {
      if (chatCalls === 0) {
        chatCalls++
        const dispatched = await piFields.routeToolCall('mcp__session__request_user_input', { questions: request.questions })
        expect(dispatched.isError).toBe(false)
      }
      yield { type: 'complete' as const }
    }
    ;(sm as unknown as { getOrCreateAgent: () => Promise<unknown> }).getOrCreateAgent = async () => pi

    await sm.sendMessage(sessionId, 'please ask me', [], [], { invocationSource: 'desktop' })
    const pending = sm.getPendingQuestion(sessionId)
    expect(pending).not.toBeNull()

    // Mount the REAL card and SKIP through it.
    const card = await mountQuestionCard(sessionId)
    await act(async () => {
      (screen.getByTestId('question-cancel') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(card.cancelled).toBe(pending!.requestId)

    // The durable cancellation settles asynchronously — wait for the
    // resolution boundary.
    await waitForCondition(
      () => events.some(e => e.type === 'question_resolved' && e.requestId === pending!.requestId && e.action === 'cancel'),
      15000,
    )
    expect(sm.getPendingQuestion(sessionId)).toBeNull()
    const managedAfter = (sm as unknown as { sessions: Map<string, { messages: Array<any> }> }).sessions.get(sessionId)!
    const skipRecords = managedAfter.messages.filter((m: any) => m.questionResolution?.requestId === pending!.requestId)
    expect(skipRecords).toHaveLength(1)
    expect(renderer.pendingOf(sessionId)).toBeNull()
  }, 120000)

  // -------------------------------------------------------------------------
  // External Codex: production driver turn → mounted card → answer → the
  // driver's continuation turn completes on the SAME session.
  // -------------------------------------------------------------------------

  it('external codex: the driver runs the model turn; the mounted card answers; the session continues via a NEW driver turn', async () => {
    const serverEntry = join(REPO_ROOT, 'packages', 'session-mcp-server', 'src', 'index.ts')
    await sm.startSessionMcpHost({ serverEntryPath: serverEntry, nodeRuntimePath: process.execPath })
    const created = await sm.createSession('ws_test', { externalEngine: true, name: 'react-codex-1' })
    const sessionId = created.id
    seededSessionIds.add(sessionId)

    const request = makeRequest(sessionId)
    const prompts: string[] = []
    interface CodexModelTurn {
      runModelTurn(input: {
        prompt: string
        listTools: () => Promise<Array<{ name: string }>>
        callTool: (name: string, args: Record<string, unknown>) => Promise<{ isError: boolean; content: unknown }>
      }): Promise<void>
    }
    const modelAdapter: CodexModelTurn = {
      async runModelTurn({ prompt, listTools, callTool }) {
        prompts.push(prompt)
        const tools = await listTools()
        expect(tools.map(t => t.name)).toContain('request_user_input')
        if (prompts.length === 1) {
          await callTool('request_user_input', { questions: request.questions })
        }
        // The continuation turn answers from history.
      },
    }
    sm.setExternalEngineModelAdapter(modelAdapter)

    // PRODUCTION turn launch.
    await sm.sendMessage(sessionId, 'please ask me', [], [], { invocationSource: 'desktop' })
    await waitForCondition(() => sm.getPendingQuestion(sessionId) !== null, 20000)
    const pending = sm.getPendingQuestion(sessionId)!

    // Mount the REAL card and answer through it.
    const card = await mountQuestionCard(sessionId)
    await act(async () => {
      (screen.getByTestId('question-option-data-delete') as HTMLButtonElement).click()
    })
    await act(async () => {
      (screen.getByTestId('question-confirm') as HTMLButtonElement).click()
    })
    await act(async () => {})
    expect(card.submitted).not.toBeNull()

    // The resume launches a NEW driver turn whose prompt IS the answer; it
    // completes through the production boundary.
    await waitForCondition(() => prompts.length >= 2, 15000)
    expect(prompts[1]).toContain('Delete permanently')
    await waitForCondition(() => {
      const m = (sm as unknown as { sessions: Map<string, { isProcessing: boolean }> }).sessions.get(sessionId)!
      return m.isProcessing === false
    }, 15000)
    expect(readableMessages(sessionId, pending.requestId)).toHaveLength(1)
    expect(renderer.pendingOf(sessionId)).toBeNull()
  }, 120000)
})


