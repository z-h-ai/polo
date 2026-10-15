import { expect, test } from 'bun:test'
import { ManagedBillingObservation } from '../managed-billing-observation'

test('generic upstream request IDs are not NewAPI billing evidence', () => {
  const observer = new ManagedBillingObservation({ statusCode: 200, headers: { 'x-request-id': 'unrelated-provider-id', 'content-type': 'text/event-stream' } } as any)
  expect(observer.providerObservation).toEqual({ version: 1, state: 'missing', responseStatus: 200 })
})
test('a generic request header cannot make the real NewAPI request ambiguous', () => {
  const observer = new ManagedBillingObservation({ statusCode: 200, headers: { 'x-oneapi-request-id': 'real-newapi', 'x-request-id': 'generic-id' } } as any)
  expect(observer.providerObservation).toEqual({ version: 1, state: 'observed', providerRequestId: 'real-newapi', responseStatus: 200 })
})
