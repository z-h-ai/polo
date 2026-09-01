/**
 * request_user_input generation binding
 *
 * The issuing turn's processing generation must be bound IMMUTABLY at
 * tool-call initiation on every callback path — never re-read from the
 * mutable agent field at execution time:
 *
 * 1. tool-handler entry (ctx chain source — covers Claude registry and the
 *    Pi cached SessionToolContext, both of which FORWARD the value),
 * 2. Pi cached SessionToolContext (forwards the handler snapshot),
 * 3. Pi per-turn registry merge (closure binds the merge-time generation),
 * 4. Claude registry registration (forwards the handler snapshot),
 * 5. legacy BaseAgent fire-and-forget completion (field read at the
 *    completion boundary — the earliest point on that path).
 *
 * Each test creates/binds the callback, THEN bumps the generation, THEN lets
 * the callback deliver — the delivered value must be the binding-time one.
 */
import { describe, expect, it } from 'bun:test'
import { createMockBackendConfig, createMockWorkspace } from './test-utils.ts'

const { handleRequestUserInput } = await import('@polo-ai/session-tools-core')
const { getSessionScopedToolCallbacks, unregisterSessionScopedToolCallbacks } = await import('../session-scoped-tool-callback-registry.ts')

function validQuestions(): Array<Record<string, unknown>> {
  return [
    {
      id: 'data-handling',
      header: 'Data',
      question: 'What should happen to related data?',
      options: [
        { id: 'trash', label: 'Move to Trash', description: 'Recoverable for 30 days' },
        { id: 'delete', label: 'Delete permanently', description: 'Immediate, unrecoverable' },
      ],
    },
  ]
}

describe('request_user_input callback generation binding (immutable closure)', () => {
  // PATH 1 — tool-handler entry: the snapshot is the handler's FIRST
  // synchronous act. A generation bump that happens after initiation (while
  // the callback is queued/in flight) can never change the delivered value.
  it('handleRequestUserInput binds the generation at initiation; a post-dispatch bump does not leak into the callback', async () => {
    let generation = 3
    let delivered: number | undefined
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const ctx = {
      sessionId: 'bind-handler',
      workspacePath: '/tmp/bind-handler',
      getTurnGeneration: () => generation,
      callbacks: {
        onPlanSubmitted: () => {},
        onAuthRequest: () => {},
        onQuestionRequested: async (_questions: unknown[], generationAtRequest: number) => {
          delivered = generationAtRequest
          await gate
        },
      },
    }

    const handlerPromise = handleRequestUserInput(ctx as never, { questions: validQuestions() as never })
    // The turn ends and a NEW turn claims generation 4 while the callback is
    // still in flight.
    generation = 4
    release()
    const result = await handlerPromise

    expect(result.isError).toBeFalsy()
    // The delivered value is the INITIATION snapshot (3), never the bumped 4.
    expect(delivered).toBe(3)
  })

  // PATH 2 — Pi cached SessionToolContext (created once, reused across
  // turns): it must FORWARD the handler snapshot, never re-read the mutable
  // field that a newer turn may already have re-stamped.
  it('Pi cached SessionToolContext forwards the snapshotted generation (no field re-read)', async () => {
    const { PiAgent } = await import('../pi-agent.ts')
    const sessionId = 'pi-bind-ctx'
    const agent = new PiAgent(createMockBackendConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: 'pi' as any,
      model: '',
      isHeadless: true,
      workspace: createMockWorkspace({ rootPath: '/tmp/pi-bind-ctx' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { id: sessionId } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any

    try {
      const delivered: Array<number | undefined> = []
      agent.onQuestionRequested = (_questions: unknown[], generationAtRequest: number) => {
        delivered.push(generationAtRequest)
      }
      agent.setSessionTurnGeneration(5)
      const ctx = agent.getSessionToolContext()

      // The handler snapshotted 5 at initiation; a newer turn then re-stamped
      // the field to 6 BEFORE the callback executes.
      agent.setSessionTurnGeneration(6)
      ctx.callbacks.onQuestionRequested!(validQuestions() as never, 5)

      expect(delivered).toEqual([5])
    } finally {
      unregisterSessionScopedToolCallbacks(sessionId)
    }
  })

  // PATH 3 — Pi per-turn registry merge: the merge runs at TURN START and the
  // registration closure binds THAT turn's generation. A proxy-forwarded
  // callback invoked after a newer turn re-stamped the field still carries
  // the merge-time value.
  it('Pi per-turn registry merge binds the merge-time generation into its closure', async () => {
    const { PiAgent } = await import('../pi-agent.ts')
    const sessionId = 'pi-bind-merge'
    const agent = new PiAgent(createMockBackendConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: 'pi' as any,
      model: '',
      isHeadless: true,
      workspace: createMockWorkspace({ rootPath: '/tmp/pi-bind-merge' }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { id: sessionId } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any

    try {
      agent.setSessionTurnGeneration(9)
      // Drive the chat generator's synchronous prologue — the per-turn merge
      // executes before its first real await (subprocess spawn), which we cut
      // off by closing the generator.
      const chat = agent.chatImpl('hello')
      await Promise.race([
        chat.next().catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 300)),
      ])
      await chat.return(undefined as never).catch(() => {})

      const delivered: Array<number | undefined> = []
      agent.onQuestionRequested = (_questions: unknown[], generationAtRequest: number) => {
        delivered.push(generationAtRequest)
      }
      // A NEWER turn re-stamps the field after the merge bound its closure.
      agent.setSessionTurnGeneration(10)

      const callbacks = getSessionScopedToolCallbacks(sessionId)
      expect(callbacks?.onQuestionRequested).toBeDefined()
      callbacks!.onQuestionRequested!(validQuestions() as never, 9)

      // The merge-time closure value (9) — never the re-stamped 10.
      expect(delivered).toEqual([9])
    } finally {
      unregisterSessionScopedToolCallbacks(sessionId)
    }
  })

  // PATH 4 — Claude registry registration: forwards the handler snapshot.
  it('Claude registry registration forwards the snapshotted generation (no field re-read)', async () => {
    const { ClaudeAgent } = await import('../claude-agent.ts')
    const sessionId = 'claude-bind-fwd'
    const agent = new ClaudeAgent({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(createMockBackendConfig({ provider: 'anthropic' as any, model: 'test-model', isHeadless: true, workspace: createMockWorkspace({ rootPath: '/tmp/claude-bind' }) }) as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      session: { id: sessionId } as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any

    try {
      const delivered: Array<number | undefined> = []
      agent.onQuestionRequested = (_questions: unknown[], generationAtRequest: number) => {
        delivered.push(generationAtRequest)
      }
      agent.setSessionTurnGeneration(4)

      const callbacks = getSessionScopedToolCallbacks(sessionId)
      expect(callbacks?.onQuestionRequested).toBeDefined()
      // The handler snapshotted 4; a newer turn re-stamps to 5 before the
      // registration delivers.
      agent.setSessionTurnGeneration(5)
      callbacks!.onQuestionRequested!(validQuestions() as never, 4)

      expect(delivered).toEqual([4])
    } finally {
      unregisterSessionScopedToolCallbacks(sessionId)
    }
  })
})
