/**
 * BaseAgent stderr lifecycle-line consumption:
 * `handleSessionMcpStderrLine` is the PRODUCTION consumer of the session MCP
 * server's stderr protocol — a `question_requested` line routed through the
 * agent reaches the durable handoff chain (onQuestionRequested) with the
 * initiation-time generation snapshot.
 */
import { describe, expect, it } from 'bun:test'
import { createMockBackendConfig, createMockWorkspace } from './test-utils.ts'

const { PiAgent } = await import('../pi-agent.ts')

function stderrLine(payload: Record<string, unknown>): string {
  return `__CALLBACK__${JSON.stringify(payload)}`
}

function validQuestions(): Array<Record<string, unknown>> {
  return [
    {
      id: 'data-handling',
      header: 'Data',
      question: 'What should happen?',
      options: [
        { id: 'trash', label: 'Move to Trash', description: 'Recoverable' },
        { id: 'delete', label: 'Delete permanently', description: 'Gone' },
      ],
    },
  ]
}

describe('BaseAgent.handleSessionMcpStderrLine routing', () => {
  it('routes a question_requested stderr line into the durable handoff chain with the initiation snapshot', async () => {
    const agent = new PiAgent(createMockBackendConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: 'pi' as any,
      model: '',
      isHeadless: true,
      workspace: createMockWorkspace({ rootPath: '/tmp/stderr-route' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any

    const delivered: Array<{ questions: unknown; generation: number }> = []
    agent.onQuestionRequested = (questions: unknown, generationAtRequest: number) => {
      delivered.push({ questions, generation: generationAtRequest })
    }
    agent.setSessionTurnGeneration(13)

    const handled = agent.handleSessionMcpStderrLine(
      stderrLine({ __callback__: 'question_requested', sessionId: 's', questions: validQuestions(), generationAtRequest: 13 }),
    )
    expect(handled).toBe(true)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.generation).toBe(13)
  })

  it('non-callback stderr lines are ignored (return false)', () => {
    const agent = new PiAgent(createMockBackendConfig({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: 'pi' as any,
      model: '',
      isHeadless: true,
      workspace: createMockWorkspace({ rootPath: '/tmp/stderr-route-2' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    })) as any

    const delivered: unknown[] = []
    agent.onQuestionRequested = (q: unknown) => { delivered.push(q) }
    agent.setSessionTurnGeneration(3)

    expect(agent.handleSessionMcpStderrLine('[session] regular pi protocol log')).toBe(false)
    expect(agent.handleSessionMcpStderrLine('__CALLBACK__not-json')).toBe(false)
    expect(delivered).toHaveLength(0)
  })
})
