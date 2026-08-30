/**
 * Session MCP / Codex request_user_input parity (review fix round 7, issue B)
 *
 * The session MCP server path must apply the SAME canonical per-turn
 * capability filter as the Claude/Pi paths — desktop turns register
 * request_user_input (list + call routing), non-desktop turns fail closed —
 * and must emit the question handoff callback carrying the initiation-time
 * generation snapshot.
 */
import { describe, expect, it } from 'bun:test'
import { createSessionTools, createCodexContext, buildSessionMcpServerArgs } from '../index.ts'
import { getSessionToolRegistry } from '@polo-ai/session-tools-core'
import { parseSessionMcpCallbackLine, isQuestionRequestedCallback } from '@polo-ai/shared/agent'

const RUI = 'request_user_input'

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

describe('session MCP / Codex request_user_input parity', () => {
  it('desktop turn (allow=true): the tool list and the call registry include request_user_input', () => {
    const tools = createSessionTools(false, true)
    expect(tools.some(t => t.name === RUI)).toBe(true)

    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false, allowRequestUserInput: true })
    expect(registry.get(RUI)?.handler).toBeDefined()
  })

  it('non-desktop turn (allow=false): fail closed — excluded from the tool list AND the call registry', () => {
    const tools = createSessionTools(false, false)
    expect(tools.some(t => t.name === RUI)).toBe(false)

    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false, allowRequestUserInput: false })
    expect(registry.get(RUI)).toBeUndefined()
  })

  it('the list and the registry stay in sync for the same capability bit (no call path without a listed tool)', () => {
    for (const allow of [true, false]) {
      const listed = createSessionTools(false, allow).map(t => t.name)
      const registry = getSessionToolRegistry({ includeDeveloperFeedback: false, allowRequestUserInput: allow })
      expect(listed.includes(RUI)).toBe(registry.has(RUI))
    }
  })

  it('the Codex context emits the question_requested callback carrying the initiation snapshot', () => {
    const ctx = createCodexContext({
      sessionId: 'codex-bind',
      workspaceRootPath: '/tmp/codex-bind',
      plansFolderPath: '/tmp/codex-bind/plans',
      allowRequestUserInput: true,
      turnGeneration: 12,
    })

    const errors: string[] = []
    const originalError = console.error
    console.error = (message: string) => { errors.push(message) }
    try {
      ctx.callbacks.onQuestionRequested?.(validQuestions() as never, 12)
    } finally {
      console.error = originalError
    }

    expect(errors).toHaveLength(1)
    const firstError = errors[0] ?? ''
    expect(firstError.startsWith('__CALLBACK__')).toBe(true)
    const message = JSON.parse(firstError.slice('__CALLBACK__'.length))
    expect(message.__callback__).toBe('question_requested')
    expect(message.sessionId).toBe('codex-bind')
    // The initiation-time snapshot travels with the callback.
    expect(message.generationAtRequest).toBe(12)
    expect(message.questions).toHaveLength(1)
    // The context's generation reader serves the per-spawn turn value.
    expect(ctx.getTurnGeneration!()).toBe(12)
  })

  // ---- Review fix round 8, issue B: production launch wiring ----

  it('launcher: a desktop turn spawn carries the capability flag and the turn generation', () => {
    const args = buildSessionMcpServerArgs({
      sessionId: 's1',
      workspaceRootPath: '/ws',
      plansFolderPath: '/ws/plans',
      allowRequestUserInput: true,
      turnGeneration: 7,
    })
    expect(args).toContain('--allow-request-user-input')
    expect(args.indexOf('--turn-generation')).toBeGreaterThanOrEqual(0)
    expect(args[args.indexOf('--turn-generation') + 1]).toBe('7')
    expect(args).toContain('--session-id')
    expect(args[args.indexOf('--session-id') + 1]).toBe('s1')
  })

  it('launcher: a non-desktop turn spawn omits both (fail closed)', () => {
    const args = buildSessionMcpServerArgs({
      sessionId: 's2',
      workspaceRootPath: '/ws',
      plansFolderPath: '/ws/plans',
    })
    expect(args).not.toContain('--allow-request-user-input')
    expect(args).not.toContain('--turn-generation')
  })

  it('launcher: callback port is passed through when provided', () => {
    const args = buildSessionMcpServerArgs({
      sessionId: 's3',
      workspaceRootPath: '/ws',
      plansFolderPath: '/ws/plans',
      callbackPort: '9377',
    })
    expect(args).toContain('--callback-port')
    expect(args[args.indexOf('--callback-port') + 1]).toBe('9377')
  })

  it('callback parser: a question_requested stderr line parses into the durable-handoff payload; garbage lines are skipped', () => {
    const payload = {
      __callback__: 'question_requested',
      sessionId: 's4',
      questions: validQuestions(),
      generationAtRequest: 7,
    }
    const parsed = parseSessionMcpCallbackLine(`__CALLBACK__${JSON.stringify(payload)}`)
    expect(parsed).not.toBeNull()
    expect(isQuestionRequestedCallback(parsed!)).toBe(true)
    if (isQuestionRequestedCallback(parsed!)) {
      expect(parsed.generationAtRequest).toBe(7)
      expect(parsed.questions).toHaveLength(1)
      expect(parsed.sessionId).toBe('s4')
    }

    // Non-callback log lines and corrupt payloads are skipped, never thrown.
    expect(parseSessionMcpCallbackLine('[session] some regular log')).toBeNull()
    expect(parseSessionMcpCallbackLine('__CALLBACK__not-json')).toBeNull()
  })
})
