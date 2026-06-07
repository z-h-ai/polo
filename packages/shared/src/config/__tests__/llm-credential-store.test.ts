import { beforeEach, describe, expect, it, mock } from 'bun:test'
import type { CredentialId, StoredCredential } from '../../credentials/types.ts'
import type { StoredConfig } from '../storage.ts'
import {
  cleanupLlmCredentials,
  getCachedConfigVersion,
  storeDecryptedLlmConnections,
  type DecryptedAdminLlmConnection,
} from '../llm-credential-store.ts'

type MockCredentialManager = {
  get: ReturnType<typeof mock<(id: CredentialId) => Promise<StoredCredential | null>>>
  set: ReturnType<typeof mock<(id: CredentialId, credential: StoredCredential) => Promise<void>>>
  delete: ReturnType<typeof mock<(id: CredentialId) => Promise<boolean>>>
  list: ReturnType<typeof mock<(filter?: Partial<CredentialId>) => Promise<CredentialId[]>>>
}

const NOW = 1_771_000_000_000

function anthropicConnection(overrides: Partial<DecryptedAdminLlmConnection> = {}): DecryptedAdminLlmConnection {
  return {
    slug: 'anthropic-api',
    name: 'Anthropic API',
    providerType: 'anthropic',
    authType: 'api_key',
    models: [
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', tier: 'standard' },
      { id: 'claude-haiku-4-5', name: 'Haiku 4.5', tier: 'fast' },
    ],
    defaultModel: 'claude-sonnet-4-6',
    apiKey: 'sk-ant-123',
    ...overrides,
  }
}

function piConnection(overrides: Partial<DecryptedAdminLlmConnection> = {}): DecryptedAdminLlmConnection {
  return {
    slug: 'pi-openai',
    name: 'Pi OpenAI',
    providerType: 'pi',
    authType: 'bearer_token',
    models: [{ id: 'pi/gpt-5.1', name: 'GPT 5.1', tier: 'premium' }],
    defaultModel: 'pi/gpt-5.1',
    apiKey: 'bearer-token-123',
    piAuthProvider: 'openai',
    midStreamBehavior: 'steer',
    ...overrides,
  }
}

function makeStoredConfig(overrides: Partial<StoredConfig> = {}): StoredConfig {
  return {
    workspaces: [],
    activeWorkspaceId: null,
    activeSessionId: null,
    ...overrides,
  }
}

function makeHarness(initialConfig: StoredConfig | null = makeStoredConfig()) {
  let storedConfig = initialConfig
  const credentials = new Map<string, StoredCredential>()
  const ids = new Map<string, CredentialId>()

  const keyFor = (id: CredentialId) => `${id.type}::${id.connectionSlug ?? 'global'}`

  const manager: MockCredentialManager = {
    get: mock(async (id: CredentialId) => credentials.get(keyFor(id)) ?? null),
    set: mock(async (id: CredentialId, credential: StoredCredential) => {
      credentials.set(keyFor(id), credential)
      ids.set(keyFor(id), { ...id })
    }),
    delete: mock(async (id: CredentialId) => {
      const existed = credentials.delete(keyFor(id))
      ids.delete(keyFor(id))
      return existed
    }),
    list: mock(async (filter?: Partial<CredentialId>) => {
      return [...ids.values()].filter((id) => {
        if (filter?.type && id.type !== filter.type) return false
        if (filter?.connectionSlug && id.connectionSlug !== filter.connectionSlug) return false
        return true
      })
    }),
  }

  const saveConfig = mock((config: StoredConfig) => {
    storedConfig = structuredClone(config)
  })

  const deps = {
    credentialManager: manager,
    loadStoredConfig: () => storedConfig,
    saveConfig,
    now: () => NOW,
  }

  return {
    deps,
    manager,
    credentials,
    ids,
    saveConfig,
    get storedConfig() {
      return storedConfig
    },
    seedCredential(id: CredentialId, credential: StoredCredential) {
      credentials.set(keyFor(id), credential)
      ids.set(keyFor(id), { ...id })
    },
  }
}

describe('storeDecryptedLlmConnections', () => {
  it('writes decrypted API keys to CredentialManager with typed llm_api_key ids', async () => {
    const harness = makeHarness()

    await storeDecryptedLlmConnections({
      configVersion: 'cv_001',
      defaultConnection: 'anthropic-api',
      connections: [anthropicConnection()],
    }, harness.deps)

    expect(harness.manager.set).toHaveBeenCalledWith(
      { type: 'llm_api_key', connectionSlug: 'anthropic-api' },
      { value: 'sk-ant-123' },
    )
  })

  it('stores multiple credentials and maps Admin connections into StoredConfig', async () => {
    const harness = makeHarness()

    await storeDecryptedLlmConnections({
      configVersion: 'cv_002',
      defaultConnection: 'anthropic-api',
      connections: [
        anthropicConnection({ baseUrl: 'https://custom.api' }),
        piConnection(),
      ],
    }, harness.deps)

    expect(harness.manager.set).toHaveBeenCalledTimes(2)
    expect(harness.manager.set).toHaveBeenCalledWith(
      { type: 'llm_api_key', connectionSlug: 'pi-openai' },
      { value: 'bearer-token-123' },
    )
    expect(harness.storedConfig?.llmConnections).toHaveLength(2)
    expect(harness.storedConfig?.llmConnections?.[0]).toMatchObject({
      slug: 'anthropic-api',
      name: 'Anthropic API',
      providerType: 'anthropic',
      authType: 'api_key',
      baseUrl: 'https://custom.api',
      defaultModel: 'claude-sonnet-4-6',
      modelSelectionMode: 'userDefined3Tier',
      createdAt: NOW,
    })
    expect(harness.storedConfig?.llmConnections?.[0]?.models).toEqual([
      expect.objectContaining({ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6', tier: 'standard' }),
      expect.objectContaining({ id: 'claude-haiku-4-5', name: 'Haiku 4.5', tier: 'fast' }),
    ])
    expect(harness.storedConfig?.llmConnections?.[1]).toMatchObject({
      slug: 'pi-openai',
      providerType: 'pi',
      authType: 'bearer_token',
      piAuthProvider: 'openai',
      midStreamBehavior: 'steer',
      modelSelectionMode: 'userDefined3Tier',
    })
    expect(harness.storedConfig?.defaultLlmConnection).toBe('anthropic-api')
    expect(harness.storedConfig?.configVersion).toBe('cv_002')
  })

  it('stores empty connection arrays without touching credentials', async () => {
    const harness = makeHarness(makeStoredConfig({
      llmConnections: [anthropicConnection() as any],
      defaultLlmConnection: 'anthropic-api',
      configVersion: 'old',
    }))

    await storeDecryptedLlmConnections({
      configVersion: 'cv_empty',
      defaultConnection: null,
      connections: [],
    }, harness.deps)

    expect(harness.manager.list).not.toHaveBeenCalled()
    expect(harness.manager.set).not.toHaveBeenCalled()
    expect(harness.manager.delete).not.toHaveBeenCalled()
    expect(harness.storedConfig?.llmConnections).toEqual([])
    expect(harness.storedConfig?.defaultLlmConnection).toBeUndefined()
    expect(harness.storedConfig?.configVersion).toBe('cv_empty')
  })

  it('does not store a credential for environment auth but still maps the connection', async () => {
    const harness = makeHarness()

    await storeDecryptedLlmConnections({
      configVersion: 'cv_env',
      defaultConnection: 'env-anthropic',
      connections: [
        anthropicConnection({
          slug: 'env-anthropic',
          authType: 'environment',
          apiKey: '',
        }),
      ],
    }, harness.deps)

    expect(harness.manager.set).not.toHaveBeenCalled()
    expect(harness.storedConfig?.llmConnections?.[0]).toMatchObject({
      slug: 'env-anthropic',
      authType: 'environment',
    })
  })

  it('handles api_key_with_endpoint auth by storing the key and mapping baseUrl', async () => {
    const harness = makeHarness()

    await storeDecryptedLlmConnections({
      configVersion: 'cv_endpoint',
      defaultConnection: 'custom-anthropic',
      connections: [
        anthropicConnection({
          slug: 'custom-anthropic',
          authType: 'api_key_with_endpoint',
          apiKey: 'endpoint-key',
          baseUrl: 'https://custom.api',
        }),
      ],
    }, harness.deps)

    expect(harness.manager.set).toHaveBeenCalledWith(
      { type: 'llm_api_key', connectionSlug: 'custom-anthropic' },
      { value: 'endpoint-key' },
    )
    expect(harness.storedConfig?.llmConnections?.[0]).toMatchObject({
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://custom.api',
    })
  })

  it('returns the cached configVersion from StoredConfig', async () => {
    const harness = makeHarness()

    await storeDecryptedLlmConnections({
      configVersion: 'cv_001',
      defaultConnection: 'anthropic-api',
      connections: [anthropicConnection()],
    }, harness.deps)

    expect(getCachedConfigVersion(harness.deps)).toBe('cv_001')
  })

  it('overwrites old connections and removes obsolete llm_api_key credentials', async () => {
    const harness = makeHarness(makeStoredConfig({
      configVersion: 'old',
      llmConnections: [
        anthropicConnection() as any,
        piConnection({ slug: 'old-extra' }) as any,
      ],
    }))
    harness.seedCredential({ type: 'llm_api_key', connectionSlug: 'anthropic-api' }, { value: 'old-key' })
    harness.seedCredential({ type: 'llm_api_key', connectionSlug: 'old-extra' }, { value: 'old-extra-key' })

    await storeDecryptedLlmConnections({
      configVersion: 'cv_refresh',
      defaultConnection: 'anthropic-api',
      connections: [anthropicConnection({ apiKey: 'new-key' })],
    }, harness.deps)

    expect(harness.storedConfig?.llmConnections?.map(c => c.slug)).toEqual(['anthropic-api'])
    expect(harness.credentials.get('llm_api_key::anthropic-api')).toEqual({ value: 'new-key' })
    expect(harness.credentials.has('llm_api_key::old-extra')).toBe(false)
    expect(harness.manager.delete).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'old-extra' })
  })

  it('rolls back credentials already written when a later credential write fails', async () => {
    const harness = makeHarness()
    harness.manager.set = mock(async (id: CredentialId, credential: StoredCredential) => {
      if (id.connectionSlug === 'pi-openai') {
        throw new Error('set failed')
      }
      harness.credentials.set(`llm_api_key::${id.connectionSlug}`, credential)
      harness.ids.set(`llm_api_key::${id.connectionSlug}`, { ...id })
    })

    await expect(storeDecryptedLlmConnections({
      configVersion: 'cv_fail',
      defaultConnection: 'anthropic-api',
      connections: [anthropicConnection(), piConnection()],
    }, harness.deps)).rejects.toThrow('set failed')

    expect(harness.manager.delete).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'anthropic-api' })
    expect(harness.credentials.has('llm_api_key::anthropic-api')).toBe(false)
    expect(harness.saveConfig).not.toHaveBeenCalled()
  })

  it('rolls back credentials written in the batch when StoredConfig write fails', async () => {
    const harness = makeHarness()
    const saveError = new Error('save failed')
    harness.deps.saveConfig = mock(() => {
      throw saveError
    })

    await expect(storeDecryptedLlmConnections({
      configVersion: 'cv_fail',
      defaultConnection: 'anthropic-api',
      connections: [anthropicConnection()],
    }, harness.deps)).rejects.toThrow(saveError)

    expect(harness.manager.delete).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'anthropic-api' })
    expect(harness.credentials.has('llm_api_key::anthropic-api')).toBe(false)
  })
})

describe('cleanupLlmCredentials', () => {
  it('deletes all llm_api_key entries and clears StoredConfig LLM cache', async () => {
    const harness = makeHarness(makeStoredConfig({
      configVersion: 'cv_001',
      defaultLlmConnection: 'anthropic-api',
      llmConnections: [anthropicConnection() as any],
    }))
    harness.seedCredential({ type: 'llm_api_key', connectionSlug: 'anthropic-api' }, { value: 'key' })
    harness.seedCredential({ type: 'llm_api_key', connectionSlug: 'pi-openai' }, { value: 'token' })

    await cleanupLlmCredentials(harness.deps)

    expect(harness.manager.list).toHaveBeenCalledWith({ type: 'llm_api_key' })
    expect(harness.manager.delete).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'anthropic-api' })
    expect(harness.manager.delete).toHaveBeenCalledWith({ type: 'llm_api_key', connectionSlug: 'pi-openai' })
    expect(harness.storedConfig?.llmConnections).toEqual([])
    expect(harness.storedConfig?.defaultLlmConnection).toBeUndefined()
    expect(getCachedConfigVersion(harness.deps)).toBe(null)
  })

  it('succeeds when no llm_api_key entries exist', async () => {
    const harness = makeHarness()

    await expect(cleanupLlmCredentials(harness.deps)).resolves.toBeUndefined()

    expect(harness.manager.delete).not.toHaveBeenCalled()
    expect(harness.storedConfig?.llmConnections).toEqual([])
  })
})
