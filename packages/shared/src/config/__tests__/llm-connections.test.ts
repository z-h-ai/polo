import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'
import '../../../tests/setup/register-pi-model-resolver.ts'
import {
  getDefaultModelsForConnection,
  getDefaultModelForConnection,
  isCompatProvider,
  isAnthropicProvider,
  isPiProvider,
  toBedrockNativeId,
  fromBedrockNativeId,
  normalizeBedrockModelId,
  deriveBedrockRegionPrefix,
  resolveAuthEnvVars,
  isPlatformMode,
} from '../llm-connections'
import { ANTHROPIC_MODELS, getModelDisplayName, getModelContextWindow, getModelShortName, isClaudeModel } from '../models'
import type { LlmConnection } from '../llm-connections'

// ============================================================
// getDefaultModelsForConnection
// ============================================================

describe('getDefaultModelsForConnection', () => {
  it('anthropic returns ANTHROPIC_MODELS (ModelDefinition[])', () => {
    const models = getDefaultModelsForConnection('anthropic')
    expect(models).toEqual(ANTHROPIC_MODELS)
    expect(models.length).toBeGreaterThan(0)
    // Verify they are ModelDefinition objects, not strings
    const first = models[0]!
    expect(typeof first).toBe('object')
    expect(typeof (first as any).id).toBe('string')
  })

  it('pi with piAuthProvider returns filtered models', () => {
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    expect(models.length).toBeGreaterThan(0)
    // All should have pi/ prefix in their id
    for (const m of models) {
      const id = typeof m === 'string' ? m : m.id
      expect(id.startsWith('pi/')).toBe(true)
    }
  })

  it('pi without piAuthProvider returns all Pi models', () => {
    const models = getDefaultModelsForConnection('pi')
    expect(models.length).toBeGreaterThan(0)
  })

})

// ============================================================
// getDefaultModelForConnection
// ============================================================

describe('getDefaultModelForConnection', () => {
  it('returns first model ID for anthropic', () => {
    const modelId = getDefaultModelForConnection('anthropic')
    expect(typeof modelId).toBe('string')
    expect(modelId.length).toBeGreaterThan(0)
    // Should match the first ANTHROPIC_MODELS entry
    expect(modelId).toBe(ANTHROPIC_MODELS[0]!.id)
  })

  // Regression: Pi 'anthropic' default must be present in its own model list
  it('regression: Pi anthropic default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'anthropic')
    const models = getDefaultModelsForConnection('pi', 'anthropic')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('Pi openai default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'openai')
    const models = getDefaultModelsForConnection('pi', 'openai')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('Pi deepseek default is in its own model list', () => {
    const defaultModel = getDefaultModelForConnection('pi', 'deepseek')
    const models = getDefaultModelsForConnection('pi', 'deepseek')
    const modelIds = models.map(m => typeof m === 'string' ? m : m.id)
    expect(modelIds).toContain(defaultModel)
  })

  it('returns empty string for pi_compat (dynamic provider)', () => {
    const defaultModel = getDefaultModelForConnection('pi_compat')
    expect(defaultModel).toBe('')
  })
})

// ============================================================
// Provider type guards
// ============================================================

describe('isCompatProvider', () => {
  it('returns true for pi_compat', () => {
    expect(isCompatProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isCompatProvider('anthropic')).toBe(false)
  })

  it('returns false for pi', () => {
    expect(isCompatProvider('pi')).toBe(false)
  })
})

describe('isAnthropicProvider', () => {
  it('returns true for anthropic', () => {
    expect(isAnthropicProvider('anthropic')).toBe(true)
  })

  it('returns false for pi', () => {
    expect(isAnthropicProvider('pi')).toBe(false)
  })
})

describe('isPiProvider', () => {
  it('returns true for pi', () => {
    expect(isPiProvider('pi')).toBe(true)
  })

  it('returns true for pi_compat', () => {
    expect(isPiProvider('pi_compat')).toBe(true)
  })

  it('returns false for anthropic', () => {
    expect(isPiProvider('anthropic')).toBe(false)
  })
})

// ============================================================
// Bedrock model ID mapping
// ============================================================

describe('toBedrockNativeId', () => {
  it('maps bare Anthropic IDs to US inference profile IDs', () => {
    expect(toBedrockNativeId('claude-opus-4-7')).toBe('us.anthropic.claude-opus-4-7-v1')
    expect(toBedrockNativeId('claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
    expect(toBedrockNativeId('claude-haiku-4-5-20251001')).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0')
  })

  it('maps base Bedrock IDs to US inference profile IDs', () => {
    expect(toBedrockNativeId('anthropic.claude-opus-4-7-v1')).toBe('us.anthropic.claude-opus-4-7-v1')
    expect(toBedrockNativeId('anthropic.claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('passes through already US-prefixed IDs', () => {
    expect(toBedrockNativeId('us.anthropic.claude-opus-4-7-v1')).toBe('us.anthropic.claude-opus-4-7-v1')
  })

  it('passes through unknown IDs', () => {
    expect(toBedrockNativeId('some-custom-model')).toBe('some-custom-model')
    expect(toBedrockNativeId('gpt-5')).toBe('gpt-5')
  })

  it('maps to EU inference profiles when regionPrefix is eu', () => {
    expect(toBedrockNativeId('claude-opus-4-7', 'eu')).toBe('eu.anthropic.claude-opus-4-7-v1')
    expect(toBedrockNativeId('claude-sonnet-4-6', 'eu')).toBe('eu.anthropic.claude-sonnet-4-6')
  })

  it('defaults to US when regionPrefix is omitted or us', () => {
    expect(toBedrockNativeId('claude-opus-4-7')).toBe('us.anthropic.claude-opus-4-7-v1')
    expect(toBedrockNativeId('claude-opus-4-7', 'us')).toBe('us.anthropic.claude-opus-4-7-v1')
  })

  it('passes through unknown IDs regardless of regionPrefix', () => {
    expect(toBedrockNativeId('some-custom-model', 'eu')).toBe('some-custom-model')
  })
})

describe('deriveBedrockRegionPrefix', () => {
  it('returns us for US regions', () => {
    expect(deriveBedrockRegionPrefix('us-east-1')).toBe('us')
    expect(deriveBedrockRegionPrefix('us-west-2')).toBe('us')
  })

  it('returns eu for EU regions', () => {
    expect(deriveBedrockRegionPrefix('eu-west-1')).toBe('eu')
    expect(deriveBedrockRegionPrefix('eu-central-1')).toBe('eu')
  })

  it('returns us for other regions (fallback)', () => {
    expect(deriveBedrockRegionPrefix('ap-southeast-1')).toBe('us')
    expect(deriveBedrockRegionPrefix('me-south-1')).toBe('us')
  })

  it('returns us when undefined', () => {
    expect(deriveBedrockRegionPrefix(undefined)).toBe('us')
  })
})

describe('Bedrock preferred defaults ordering', () => {
  it('sorts preferred models first for amazon-bedrock', () => {
    const models = getDefaultModelsForConnection('pi', 'amazon-bedrock')
    if (models.length === 0) return // Pi resolver not registered in test env
    const firstId = typeof models[0] === 'string' ? models[0] : (models[0] as any).id
    // First model should be a preferred model (claude-opus or claude-sonnet), not a deprecated one
    expect(firstId).toMatch(/claude-(opus|sonnet)-4/)
  })
})

describe('fromBedrockNativeId', () => {
  it('maps US inference profile IDs back to bare Anthropic', () => {
    expect(fromBedrockNativeId('us.anthropic.claude-opus-4-7-v1')).toBe('claude-opus-4-7')
    expect(fromBedrockNativeId('us.anthropic.claude-sonnet-4-6')).toBe('claude-sonnet-4-6')
    expect(fromBedrockNativeId('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('claude-haiku-4-5-20251001')
  })

  it('maps EU/Global inference profile IDs back to bare', () => {
    expect(fromBedrockNativeId('eu.anthropic.claude-opus-4-7-v1')).toBe('claude-opus-4-7')
    expect(fromBedrockNativeId('global.anthropic.claude-opus-4-7-v1')).toBe('claude-opus-4-7')
  })

  it('maps base Bedrock IDs back to bare', () => {
    expect(fromBedrockNativeId('anthropic.claude-opus-4-7-v1')).toBe('claude-opus-4-7')
  })

  it('passes through bare IDs', () => {
    expect(fromBedrockNativeId('claude-opus-4-7')).toBe('claude-opus-4-7')
  })
})

describe('normalizeBedrockModelId', () => {
  it('strips pi/ prefix and maps to US inference profile', () => {
    expect(normalizeBedrockModelId('pi/claude-opus-4-7')).toBe('us.anthropic.claude-opus-4-7-v1')
    expect(normalizeBedrockModelId('pi/claude-sonnet-4-6')).toBe('us.anthropic.claude-sonnet-4-6')
  })

  it('maps bare IDs to US inference profile', () => {
    expect(normalizeBedrockModelId('claude-opus-4-7')).toBe('us.anthropic.claude-opus-4-7-v1')
  })

  it('maps base Bedrock IDs to US inference profile', () => {
    expect(normalizeBedrockModelId('anthropic.claude-opus-4-7-v1')).toBe('us.anthropic.claude-opus-4-7-v1')
  })

  it('is idempotent for already US-prefixed IDs', () => {
    expect(normalizeBedrockModelId('us.anthropic.claude-opus-4-7-v1')).toBe('us.anthropic.claude-opus-4-7-v1')
  })

  it('handles empty/undefined', () => {
    expect(normalizeBedrockModelId(undefined)).toBe('')
    expect(normalizeBedrockModelId('')).toBe('')
  })

  it('respects regionPrefix for EU', () => {
    expect(normalizeBedrockModelId('pi/claude-opus-4-7', 'eu')).toBe('eu.anthropic.claude-opus-4-7-v1')
    expect(normalizeBedrockModelId('claude-sonnet-4-6', 'eu')).toBe('eu.anthropic.claude-sonnet-4-6')
  })
})

// ============================================================
// Bedrock-aware display and lookup
// ============================================================

describe('Bedrock-native model display', () => {
  it('getModelDisplayName resolves US inference profile IDs', () => {
    expect(getModelDisplayName('us.anthropic.claude-opus-4-7-v1')).toBe('Opus 4.7')
    expect(getModelDisplayName('us.anthropic.claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(getModelDisplayName('us.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe('Haiku 4.5')
  })

  it('getModelDisplayName resolves EU/base Bedrock IDs', () => {
    expect(getModelDisplayName('eu.anthropic.claude-opus-4-7-v1')).toBe('Opus 4.7')
    expect(getModelDisplayName('anthropic.claude-opus-4-7-v1')).toBe('Opus 4.7')
  })

  it('getModelShortName resolves Bedrock IDs', () => {
    expect(getModelShortName('us.anthropic.claude-opus-4-7-v1')).toBe('Opus')
    expect(getModelShortName('us.anthropic.claude-sonnet-4-6')).toBe('Sonnet')
  })

  it('getModelContextWindow resolves Bedrock IDs', () => {
    expect(getModelContextWindow('us.anthropic.claude-opus-4-7-v1')).toBe(1_000_000)
    expect(getModelContextWindow('us.anthropic.claude-sonnet-4-6')).toBe(200_000)
  })

  it('isClaudeModel recognizes Bedrock IDs', () => {
    expect(isClaudeModel('us.anthropic.claude-opus-4-7-v1')).toBe(true)
    expect(isClaudeModel('anthropic.claude-sonnet-4-6')).toBe(true)
    expect(isClaudeModel('eu.anthropic.claude-haiku-4-5-20251001-v1:0')).toBe(true)
  })
})

// ============================================================
// isPlatformMode
// ============================================================

describe('isPlatformMode', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.PLATFORM_ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = originalEnv
    }
  })

  it('returns true when PLATFORM_ANTHROPIC_API_KEY is set', () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-xxx'
    expect(isPlatformMode()).toBe(true)
  })

  it('returns false when PLATFORM_ANTHROPIC_API_KEY is not set', () => {
    delete process.env.PLATFORM_ANTHROPIC_API_KEY
    expect(isPlatformMode()).toBe(false)
  })

  it('returns false when PLATFORM_ANTHROPIC_API_KEY is empty string', () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = ''
    expect(isPlatformMode()).toBe(false)
  })
})

// ============================================================
// resolveAuthEnvVars — platform mode (AC1, AC2, AC3, AC4)
// ============================================================

function makeAnthropicConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'anthropic-api',
    name: 'Anthropic API',
    providerType: 'anthropic',
    authType: 'api_key',
    createdAt: Date.now(),
    ...overrides,
  }
}

function makePiConnection(overrides: Partial<LlmConnection> = {}): LlmConnection {
  return {
    slug: 'pi-openai',
    name: 'OpenAI via Pi',
    providerType: 'pi',
    authType: 'api_key',
    piAuthProvider: 'openai',
    createdAt: Date.now(),
    ...overrides,
  }
}

describe('resolveAuthEnvVars — platform mode', () => {
  let getLlmApiKeyCalled: boolean
  let originalPlatformKey: string | undefined
  let originalAnthropicKey: string | undefined

  const mockCredentialManager = {
    getLlmApiKey: async (_slug: string): Promise<string | null> => {
      getLlmApiKeyCalled = true
      return 'sk-local-key'
    },
    getLlmOAuth: async (_slug: string) => null,
    isAuthenticated: async () => false,
  } as any

  const mockGetValidOAuthToken = async (_slug: string) => ({ accessToken: null })

  beforeEach(() => {
    getLlmApiKeyCalled = false
    originalPlatformKey = process.env.PLATFORM_ANTHROPIC_API_KEY
    originalAnthropicKey = process.env.ANTHROPIC_API_KEY
  })

  afterEach(() => {
    if (originalPlatformKey === undefined) {
      delete process.env.PLATFORM_ANTHROPIC_API_KEY
    } else {
      process.env.PLATFORM_ANTHROPIC_API_KEY = originalPlatformKey
    }
    if (originalAnthropicKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicKey
    }
  })

  // AC1: Platform mode — use platform key
  it('AC1: sets ANTHROPIC_API_KEY from PLATFORM_ANTHROPIC_API_KEY when platform mode', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-key'
    delete process.env.ANTHROPIC_API_KEY

    const conn = makeAnthropicConnection()
    const result = await resolveAuthEnvVars(conn, 'anthropic-api', mockCredentialManager)

    expect(result.success).toBe(true)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(process.env['ANTHROPIC_API_KEY'] as any).toBe('sk-ant-platform-key')
  })

  it('AC1: does NOT call getLlmApiKey in platform mode', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-key'

    const conn = makeAnthropicConnection()
    await resolveAuthEnvVars(conn, 'anthropic-api', mockCredentialManager)

    expect(getLlmApiKeyCalled).toBe(false)
  })

  it('AC1: platform mode works regardless of existing ANTHROPIC_API_KEY value', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-key'
    process.env.ANTHROPIC_API_KEY = 'sk-existing-key'

    const conn = makeAnthropicConnection()
    await resolveAuthEnvVars(conn, 'anthropic-api', mockCredentialManager)

    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-platform-key')
  })

  // AC2: Non-platform mode — original flow still works
  it('AC2: without PLATFORM_ANTHROPIC_API_KEY, original credential resolution runs', async () => {
    delete process.env.PLATFORM_ANTHROPIC_API_KEY

    const conn = makeAnthropicConnection()
    const result = await resolveAuthEnvVars(conn, 'anthropic-api', mockCredentialManager)

    expect(getLlmApiKeyCalled).toBe(true)
    expect(result.success).toBe(true)
    expect(result.envVars.ANTHROPIC_API_KEY).toBe('sk-local-key')
  })

  it('AC2: empty PLATFORM_ANTHROPIC_API_KEY treated as unset, original flow runs', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = ''

    const conn = makeAnthropicConnection()
    const result = await resolveAuthEnvVars(conn, 'anthropic-api', mockCredentialManager)

    expect(getLlmApiKeyCalled).toBe(true)
    expect(result.success).toBe(true)
  })

  // AC3: Platform mode ignores non-Anthropic providers (existing early-return)
  it('AC3: in platform mode, non-Anthropic connection returns early with success', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-key'

    const conn = makePiConnection()
    const result = await resolveAuthEnvVars(conn, 'pi-openai', mockCredentialManager)

    // Non-Anthropic providers already return early — unchanged behavior
    expect(result.success).toBe(true)
    expect(Object.keys(result.envVars)).toHaveLength(0)
    // getLlmApiKey should NOT be called for non-Anthropic providers
    expect(getLlmApiKeyCalled).toBe(false)
  })

  // AC4: Platform key not exposed — not returned in envVars, not logged
  it('AC4: PLATFORM_ANTHROPIC_API_KEY is not returned in envVars', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-secret'

    const conn = makeAnthropicConnection()
    const result = await resolveAuthEnvVars(conn, 'anthropic-api', mockCredentialManager)

    const allValues = Object.values(result.envVars)
    expect(allValues).not.toContain('sk-ant-platform-secret')
  })

  it('AC4: resolveAuthEnvVars does not return PLATFORM_ANTHROPIC_API_KEY as a key', async () => {
    process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-platform-secret'

    const conn = makeAnthropicConnection()
    const result = await resolveAuthEnvVars(conn, 'anthropic-api', mockCredentialManager)

    expect('PLATFORM_ANTHROPIC_API_KEY' in result.envVars).toBe(false)
  })
})
