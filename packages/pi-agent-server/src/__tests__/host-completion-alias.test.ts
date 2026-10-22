import { describe, expect, it } from 'bun:test'
import { createHostStreamTracker } from '../host-completion-stream'
import type { AssistantMessageEvent } from '@mariozechner/pi-ai'

const observation = { attempts: 1, status: 200, networkFailure: false, retryBlocked: false, sdkException: false }
const custom = { kind: 'custom', api: 'openai-completions' } as const
function finish(route = custom as { kind: string; api?: string }, extra: Record<string, unknown> = {}, text = '{"currency":"CNY","items":[]}', usage = { input: 201, output: 58, cacheRead: 0, cacheWrite: 0, totalTokens: 259 }) {
  const claims: string[] = []
  const options = { expectedModel: 'deepseek-chat', maxOutputTokens: 4096, jsonOutput: true, bedrock: false, claim: (kind: string) => claims.push(kind), route }
  const tracker = createHostStreamTracker(options)
  tracker.onEvent({ type: 'done', reason: 'stop', message: { role: 'assistant', content: [{ type: 'text', text }], api: 'openai-completions', provider: 'openai', model: 'deepseek-chat', responseModel: 'deepseek-flash', stopReason: 'stop', timestamp: 1, usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, ...extra } } as AssistantMessageEvent)
  return { claims, verdict: tracker.finish(observation, false) }
}
describe('custom OpenAI response labels preserve the authorized sent model', () => {
  it('accepts an alias label and retains its true reported metadata and final usage', () => {
    expect(finish()).toMatchObject({ claims: [], verdict: { kind: 'release', status: 'completed', usage: { reportedModel: 'deepseek-flash', inputTokens: 201, outputTokens: 58, terminalReason: 'stop', provenance: 'provider_final' } } })
  })
  it('still rejects a different sent model even when the response label matches the admission', () => {
    expect(finish(custom, { model: 'not-admitted', responseModel: 'deepseek-chat' }).verdict).toMatchObject({ kind: 'failure', failure: 'unexpected_terminal' })
  })
  it('keeps strict response-label checks for catalog and custom Anthropic routes', () => {
    for (const route of [{ kind: 'catalog' }, { kind: 'custom', api: 'anthropic-messages' }]) expect(finish(route).verdict).toMatchObject({ kind: 'failure', failure: 'unexpected_terminal' })
  })
  it('does not allow an alias to bypass JSON or usage validation', () => {
    expect(finish(custom, {}, 'not JSON').verdict).toMatchObject({ kind: 'failure', failure: 'json_object_required', usage: { reportedModel: 'deepseek-flash' } })
    expect(finish(custom, {}, '{}', { input: 201, output: 58, cacheRead: 0, cacheWrite: 0, totalTokens: 1 }).verdict).toMatchObject({ kind: 'failure', failure: 'provider_usage_invalid' })
  })
})
