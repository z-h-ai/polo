import { expect, test } from 'bun:test'
import type { LlmConnection } from '@polo-ai/shared/config'

test('managed lease identity survives display/timestamp refresh but binds transport, models and Admin config version', async () => {
  const { managedConnectionFingerprint } = await import('../cli-managed-broker') as any
  const original: LlmConnection = { slug: 'polo-space-test', name: 'Polo', managedBy: 'admin', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', baseUrl: 'https://provider.example/v1', customEndpoint: { api: 'openai-completions' }, models: ['b', 'a'], defaultModel: 'a', adminConfigVersion: 'v1', createdAt: 1 }
  const key = managedConnectionFingerprint(original)
  expect(managedConnectionFingerprint({ ...original, name: 'Renamed', createdAt: 2, lastUsedAt: 3, models: ['a', 'b'] })).toBe(key)
  for (const changed of [{ baseUrl: 'https://other.example/v1' }, { models: ['a'] }, { adminConfigVersion: 'v2' }, { managedBy: undefined }, { defaultModel: 'b' }]) expect(managedConnectionFingerprint({ ...original, ...changed })).not.toBe(key)
})
