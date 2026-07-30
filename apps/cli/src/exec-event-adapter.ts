interface Usage {
  input_tokens: number
  cached_input_tokens: number
  output_tokens: number
}

export interface InternalSessionEvent {
  type: string
  sessionId: string
  delta?: string
  toolName?: string
  toolIntent?: string
  toolUseId?: string
  result?: unknown
  isError?: boolean
  error?: unknown
  usage?: {
    inputTokens?: number
    cacheReadInputTokens?: number
    outputTokens?: number
  }
}

export class ExecEventAdapter {
  private readonly json: boolean
  private readonly secrets: string[]
  private readonly activeItems = new Map<string, { id: string; command: string }>()
  private usage: Usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }
  private protocolStarted = false

  constructor(options: { json: boolean; secrets?: Array<string | undefined> }) {
    this.json = options.json
    this.secrets = (options.secrets ?? []).filter((value): value is string => !!value)
  }

  get started(): boolean {
    return this.protocolStarted
  }

  start(threadId: string): void {
    this.protocolStarted = true
    this.emit({ type: 'thread.started', thread_id: threadId })
    this.emit({ type: 'turn.started' })
  }

  accept(event: InternalSessionEvent): void {
    if (event.usage) {
      this.usage = {
        input_tokens: event.usage.inputTokens ?? this.usage.input_tokens,
        cached_input_tokens: event.usage.cacheReadInputTokens ?? this.usage.cached_input_tokens,
        output_tokens: event.usage.outputTokens ?? this.usage.output_tokens,
      }
    }

    if (!this.json) return
    if (event.type === 'tool_start') {
      const key = event.toolUseId || crypto.randomUUID()
      const item = {
        id: key,
        command: this.redact(event.toolIntent || event.toolName || 'tool'),
      }
      this.activeItems.set(key, item)
      this.emit({
        type: 'item.started',
        item: {
          id: item.id,
          type: 'command_execution',
          command: item.command,
          status: 'in_progress',
        },
      })
      return
    }

    if (event.type === 'tool_result') {
      const key = event.toolUseId || [...this.activeItems.keys()].at(-1)
      if (!key) return
      const item = this.activeItems.get(key) ?? { id: key, command: event.toolName || 'tool' }
      this.activeItems.delete(key)
      const failed = event.isError === true
      this.emit({
        type: failed ? 'item.failed' : 'item.completed',
        item: {
          id: item.id,
          type: 'command_execution',
          command: this.redact(item.command),
          status: failed ? 'failed' : 'completed',
          exit_code: failed ? 1 : 0,
          ...(failed && event.result !== undefined
            ? { error: this.redact(String(event.result)) }
            : {}),
        },
      })
    }
  }

  agentMessage(text: string): void {
    this.emit({
      type: 'item.completed',
      item: {
        id: crypto.randomUUID(),
        type: 'agent_message',
        text: this.redact(text),
      },
    })
  }

  completed(): void {
    this.emit({ type: 'turn.completed', usage: this.usage })
  }

  failed(error: unknown, signal?: string): void {
    const message = this.redact(error instanceof Error ? error.message : String(error))
    this.emit({ type: 'error', message })
    this.emit({
      type: 'turn.failed',
      error: {
        message,
        ...(signal ? { signal } : {}),
      },
    })
  }

  redact(value: string): string {
    let output = value
    for (const secret of this.secrets) output = output.split(secret).join('[REDACTED]')
    output = output.replace(/Authorization\s*:\s*(?:Bearer|Basic)\s+\S+/gi, 'Authorization: [REDACTED]')
    output = output.replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    return output
  }

  private emit(event: unknown): void {
    if (!this.json) return
    process.stdout.write(`${JSON.stringify(event)}\n`)
  }
}
