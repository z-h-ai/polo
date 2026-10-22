import { expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import type { LlmConnection } from '../../../config/llm-connections'
import { adminNewApiConnection } from '../../../config/__fixtures__/admin-newapi'
import { createHostDescriptor, resolveExecutablePolicy } from '../host-executor-factory'

const { apiKey: _key, ...payload } = adminNewApiConnection('same-admin-payload', 'https://newapi.example.invalid/v1')
const connection: LlmConnection = { ...payload, managedBy: 'admin', createdAt: 1 }

test('Admin NewAPI object models and bare default keep an explicit custom Host route', () => {
  const resolved = resolveExecutablePolicy(connection)
  expect(resolved.ok).toBe(true)
  if (!resolved.ok) throw new Error('NewAPI route rejected')
  const descriptor = createHostDescriptor(connection, resolved.policy, { type: 'api_key', value: 'offline-key' })!
  try {
    expect(descriptor.wireRoute).toEqual({ kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: connection.baseUrl! })
  } finally { rmSync(descriptor.privateHome, { recursive: true, force: true }) }
})

for (const [name, overrides] of Object.entries({
  'legacy pi custom endpoint': { providerType: 'pi', authType: 'api_key', piAuthProvider: 'openai' },
  'legacy pi OAuth custom endpoint': { providerType: 'pi', authType: 'oauth', piAuthProvider: 'openai-codex' },
  'unknown protocol': { customEndpoint: { api: 'openai-responses' } },
  'unknown keyless protocol': { authType: 'none', baseUrl: 'http://127.0.0.1/v1', customEndpoint: { api: 'openai-responses' } },
  'missing protocol': { customEndpoint: undefined },
  'wrong auth': { authType: 'api_key' },
  'OAuth auth': { authType: 'oauth' },
  'remote keyless': { authType: 'none' },
  'invalid URL protocol': { baseUrl: 'ftp://127.0.0.1/v1' },
  'URL credentials': { baseUrl: 'https://user:pass@example.invalid/v1' },
})) test(`Host rejects ${name} without falling back to an official provider`, () => {
  expect(resolveExecutablePolicy({ ...connection, ...overrides } as LlmConnection)).toEqual({ ok: false })
})
