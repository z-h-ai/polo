import type { AssistantMessageEvent } from '@mariozechner/pi-ai'
import { classifyTransportFailure, type TransportObservation } from './host-completion-policy.ts'
import { type HostFailureKind, type HostResultUsage } from './host-completion-protocol.ts'
import { createContentMeter, type SafeTerminalSnapshot } from './host-completion-content-meter.ts'
// Remaining responsibilities (R12 §6.7): receive safe observations from the content meter, keep the
// fixed claim order, hold the immutable terminal winner, validate usage/model/JSON policy and
// produce the final StreamVerdict. This file never reads provider-controlled objects directly —
// the meter's immutable snapshot is the only view of the terminal message.
export type StreamVerdict = { kind: 'release'; status: 'completed' | 'partial'; text: string; usage: HostResultUsage } | { kind: 'failure'; failure: HostFailureKind; usage?: HostResultUsage }
export function createHostStreamTracker(opts: {
  expectedModel: string; maxOutputTokens: number; jsonOutput: boolean; bedrock: boolean
  claim: (kind: HostFailureKind) => void
}) {
  const meter = createContentMeter()
  // Terminal winner: `null` until the first done/error event completes metering; any later event
  // is a duplicate or post-terminal event and claims unexpected_terminal (monotonic winner).
  let terminal: { type: 'done'; reason: string; snapshot: SafeTerminalSnapshot | null } | { type: 'error'; aborted: boolean } | null = null
  const fail = (failure: HostFailureKind, usage?: HostResultUsage): StreamVerdict => ({ kind: 'failure', failure, ...(usage ? { usage } : {}) })
  const classified = (observation: Readonly<TransportObservation>): HostFailureKind => classifyTransportFailure(observation, { deadlineExpired: false, providerFailed: true }) ?? 'provider_error_terminal'
  // Claim priority invariant: a content resource violation (result_too_large) beats a latched
  // snapshot inconsistency, which beats tool rejection, which beats duplicate/post-terminal
  // events. The deadline claims through the worker settle; the winner is monotonic and failures
  // never release text.
  function onEvent(event: AssistantMessageEvent): void {
    meter.onEvent(event)
    if (meter.isBodyOverLimit()) return opts.claim('result_too_large')
    if (meter.isSnapshotInconsistent()) return opts.claim('unexpected_terminal')
    if (meter.hasToolContent()) return opts.claim('unexpected_terminal')
    if (terminal !== null) return opts.claim('unexpected_terminal')
    if (event.type === 'done') terminal = { type: 'done', reason: event.reason, snapshot: meter.snapshotTerminal() }
    else if (event.type === 'error') terminal = { type: 'error', aborted: event.reason === 'aborted' }
  }
  function finish(observation: Readonly<TransportObservation>, deadlineExpired: boolean): StreamVerdict {
    if (deadlineExpired) return fail('deadline_exceeded')
    if (meter.flushPendingSurrogatesToLimit()) return fail('result_too_large')
    if (!terminal) return fail('unexpected_terminal')
    if (terminal.type === 'error' && terminal.aborted) return fail('provider_aborted')
    if (terminal.type === 'error' || observation.attempts !== 1) return fail(classified(observation))
    if (terminal.reason !== 'stop' && terminal.reason !== 'length') return fail('unexpected_terminal')
    const snapshot = terminal.snapshot
    const text = snapshot === null ? '' : snapshot.text
    if (!text.trim()) return fail('empty_text')
    if (snapshot === null || snapshot.usage === null) return fail('provider_usage_invalid')
    const pick = (value: number): number => (Number.isInteger(value) && value >= 0 ? value : -1)
    const rawInput = pick(snapshot.usage.input), output = pick(snapshot.usage.output), cacheRead = pick(snapshot.usage.cacheRead), cacheWrite = pick(snapshot.usage.cacheWrite), total = pick(snapshot.usage.totalTokens)
    const reportedModel = snapshot.responseModel.trim() || snapshot.model.trim()
    const input = opts.bedrock ? rawInput - cacheRead - cacheWrite : rawInput
    if (Math.min(rawInput, output, cacheRead, cacheWrite, total) < 0 || input < 0 || input + cacheRead <= 0 || total !== input + output + cacheRead + cacheWrite || output > opts.maxOutputTokens) return fail('provider_usage_invalid')
    if (reportedModel !== opts.expectedModel) return fail('unexpected_terminal')
    const usage: HostResultUsage = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, totalTokens: total,
      reportedModel, terminalReason: terminal.reason as 'stop' | 'length', provenance: 'provider_final' }
    if (opts.jsonOutput) {
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { return fail('json_object_required', usage) }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return fail('json_object_required', usage)
    }
    return { kind: 'release', status: terminal.reason === 'stop' ? 'completed' : 'partial', text, usage }
  }
  return { onEvent, finish }
}
