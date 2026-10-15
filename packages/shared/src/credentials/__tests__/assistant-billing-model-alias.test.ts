import { expect, test } from 'bun:test'
import { ManagedBillingObservation } from '../managed-billing-observation'

test('metering model is the actual HTTP request model; provider version label cannot replace the admitted alias', () => {
  const observer = new ManagedBillingObservation({ statusCode: 200, headers: { 'x-oneapi-request-id': 'original', 'content-type': 'application/json' } } as any, 'gpt-4o')
  observer.push(Buffer.from(JSON.stringify({ model: 'gpt-4o-2024-08-06', choices: [{ message: { content: 'OK' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } })), true)
  expect(observer.result(true)).toMatchObject({ actualModel: 'gpt-4o', inputTokens: 10, outputTokens: 2, outputDisposition: 'usable', provenance: 'provider_final' })
})
