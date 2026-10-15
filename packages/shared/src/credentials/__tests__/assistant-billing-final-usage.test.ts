import { expect, test } from 'bun:test'
import { ManagedBillingObservation } from '../managed-billing-observation'

test('usage in an incomplete stream cannot claim provider-final provenance', () => {
  const observer = new ManagedBillingObservation({ statusCode: 200, headers: { 'content-type': 'text/event-stream', 'x-oneapi-request-id': 'original' } } as any, 'deepseek-chat')
  observer.push(Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'))
  expect(observer.result(false)).not.toHaveProperty('provenance')
  expect(observer.result(true)).not.toHaveProperty('provenance')
  observer.push(Buffer.from('data: [DONE]\n\n'), true)
  expect(observer.result(true)).toMatchObject({ provenance: 'provider_final', inputTokens: 10, outputTokens: 2, outputDisposition: 'usable' })
})
