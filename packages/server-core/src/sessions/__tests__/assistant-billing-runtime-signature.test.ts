import { expect, test } from 'bun:test'
import { buildBackendRuntimeSignature, buildRestartRequiredSignature } from '../runtime-config'

test('changing a connection to managed billing requires a fresh Host-owned runtime', () => {
  const local: any = { connection: { slug: 'same', providerType: 'pi_compat', authType: 'api_key', baseUrl: 'https://provider.example/v1' }, provider: 'pi', authType: 'api_key', resolvedModel: 'deepseek-chat' }
  const managed = { ...local, connection: { ...local.connection, managedBy: 'admin' } }
  expect(buildBackendRuntimeSignature(local)).not.toBe(buildBackendRuntimeSignature(managed))
  expect(buildRestartRequiredSignature(local)).not.toBe(buildRestartRequiredSignature(managed))
})
