import { describe, expect, it } from 'bun:test'
import { ExecEventAdapter } from './exec-event-adapter.ts'

describe('ExecEventAdapter', () => {
  it('emits parseable JSONL and redacts invocation secrets', () => {
    let output = ''
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      const adapter = new ExecEventAdapter({ json: true, secrets: ['secret-value'] })
      adapter.start('thread-1')
      adapter.agentMessage('answer secret-value Authorization: Bearer abc123')
      adapter.completed()
    } finally {
      process.stdout.write = originalWrite
    }

    const events = output.trim().split('\n').map(line => JSON.parse(line))
    expect(events.map(event => event.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.completed',
      'turn.completed',
    ])
    expect(output).not.toContain('secret-value')
    expect(output).not.toContain('Bearer abc123')
  })

  it('maps failed tool results to item.failed without a zero exit code', () => {
    let output = ''
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      const adapter = new ExecEventAdapter({ json: true, secrets: ['secret-value'] })
      adapter.start('thread-1')
      adapter.accept({
        type: 'tool_start',
        sessionId: 'session-1',
        toolUseId: 'tool-1',
        toolName: 'bash',
      })
      adapter.accept({
        type: 'tool_result',
        sessionId: 'session-1',
        toolUseId: 'tool-1',
        result: 'failed with secret-value',
        isError: true,
      })
      adapter.failed(new Error('turn failed'))
    } finally {
      process.stdout.write = originalWrite
    }

    const events = output.trim().split('\n').map(line => JSON.parse(line))
    const failed = events.find(event => event.type === 'item.failed')
    expect(failed.item).toMatchObject({ status: 'failed', exit_code: 1 })
    expect(events.some(event => event.type === 'item.completed' && event.item?.id === 'tool-1')).toBe(false)
    expect(output).not.toContain('secret-value')
  })

  it('maps real session tokenUsage into turn.completed usage', () => {
    let output = ''
    const originalWrite = process.stdout.write
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      const adapter = new ExecEventAdapter({ json: true })
      adapter.start('thread-1')
      adapter.accept({
        type: 'complete',
        sessionId: 'session-1',
        tokenUsage: {
          inputTokens: 120,
          cacheReadTokens: 45,
          outputTokens: 30,
        },
      })
      adapter.completed()
    } finally {
      process.stdout.write = originalWrite
    }

    const events = output.trim().split('\n').map(line => JSON.parse(line))
    expect(events.at(-1)).toEqual({
      type: 'turn.completed',
      usage: {
        input_tokens: 120,
        cached_input_tokens: 45,
        output_tokens: 30,
      },
    })
  })
})
