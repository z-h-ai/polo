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
})
