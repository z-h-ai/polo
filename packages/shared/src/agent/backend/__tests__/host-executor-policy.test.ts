import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'

import {
  resolveExecutablePolicy,
  selectExactModel,
  readCredentialSnapshot,
  createHostDescriptor,
  computeFingerprint,
} from '../host-executor-factory.ts'
import {
  copilotTransportHref,
  bedrockTransportHref,
  normalizeCustomTransportHref,
  validateWorkerResult,
  WIRE_RESULT_ROWS,
  PUBLIC_ERROR_MESSAGES,
  HOST_PARENT_MARKER,
  ID_LIMIT,
  TEXT_LIMIT,
} from '../../host-llm-contract.ts'
import {
  setInvocationLlmConnections,
  clearInvocationLlmConnections,
} from '../../../config/storage.ts'
import {
  setInvocationCredential,
  clearInvocationCredentials,
} from '../../../credentials/index.ts'
import type { LlmConnection } from '../../../config/llm-connections.ts'

// ─── helpers ─────────────────────────────────────────────────────────

function makeConn(overrides: Partial<LlmConnection> & { slug: string }): LlmConnection {
  return {
    name: overrides.slug,
    providerType: 'pi',
    authType: 'api_key',
    createdAt: Date.now(),
    ...overrides,
  }
}

const API_KEY_CATALOG_PROVIDERS = [
  'anthropic', 'google', 'openai', 'cerebras', 'deepseek', 'fireworks', 'groq', 'huggingface',
  'kimi-coding', 'minimax', 'minimax-cn', 'mistral', 'moonshotai', 'moonshotai-cn', 'opencode',
  'opencode-go', 'openrouter', 'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai',
]

const CATALOG_TRANSPORT_HREFS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/',
  google: 'https://generativelanguage.googleapis.com/v1beta',
  openai: 'https://api.openai.com/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  deepseek: 'https://api.deepseek.com/',
  fireworks: 'https://api.fireworks.ai/inference',
  groq: 'https://api.groq.com/openai/v1',
  huggingface: 'https://router.huggingface.co/v1',
  'kimi-coding': 'https://api.kimi.com/coding',
  minimax: 'https://api.minimax.io/anthropic',
  'minimax-cn': 'https://api.minimaxi.com/anthropic',
  mistral: 'https://api.mistral.ai/',
  moonshotai: 'https://api.moonshot.ai/v1',
  'moonshotai-cn': 'https://api.moonshot.cn/v1',
  opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'vercel-ai-gateway': 'https://ai-gateway.vercel.sh/',
  xai: 'https://api.x.ai/v1',
  xiaomi: 'https://api.xiaomimimo.com/anthropic',
  'xiaomi-token-plan-ams': 'https://token-plan-ams.xiaomimimo.com/anthropic',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/anthropic',
  'xiaomi-token-plan-sgp': 'https://token-plan-sgp.xiaomimimo.com/anthropic',
  zai: 'https://api.z.ai/api/coding/paas/v4',
  'openai-codex': 'https://chatgpt.com/backend-api',
}

const OAUTH_CATALOG_PROVIDERS = ['anthropic', 'openai-codex', 'github-copilot']

const createdPrivateHomes: string[] = []

function trackDescriptor(desc: ReturnType<typeof createHostDescriptor>): ReturnType<typeof createHostDescriptor> {
  createdPrivateHomes.push(desc.privateHome)
  return desc
}

beforeEach(() => {
  clearInvocationCredentials()
  clearInvocationLlmConnections()
})

afterEach(() => {
  for (const home of createdPrivateHomes) {
    try { rmSync(home, { recursive: true, force: true }) } catch {}
  }
  createdPrivateHomes.length = 0
  clearInvocationCredentials()
  clearInvocationLlmConnections()
})

// ─── 1. F.1 Executable provider/auth policy matrix ───────────────────

describe('resolveExecutablePolicy — executable combinations', () => {
  describe('api_key catalog (24 providers)', () => {
    for (const provider of API_KEY_CATALOG_PROVIDERS) {
      it(`pi + api_key + ${provider} → ok catalog policy`, () => {
        const conn = makeConn({ slug: `test-${provider}`, providerType: 'pi', authType: 'api_key', piAuthProvider: provider })
        const result = resolveExecutablePolicy(conn)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        const p = result.policy
        expect(p.routeKind).toBe('catalog')
        expect(p.provider).toBe(provider)
        expect(p.credentialType).toBe('api_key')
        expect(p.isCopilot).toBe(false)
        expect(p.isBedrock).toBe(false)
        expect(p.staticHref).toBe(CATALOG_TRANSPORT_HREFS[provider])
      })
    }
  })

  describe('anthropic direct', () => {
    it('anthropic + api_key → ok', () => {
      const conn = makeConn({ slug: 'anthropic-api', providerType: 'anthropic', authType: 'api_key' })
      const result = resolveExecutablePolicy(conn)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.policy.provider).toBe('anthropic')
      expect(result.policy.credentialType).toBe('api_key')
      expect(result.policy.staticHref).toBe('https://api.anthropic.com/')
      expect(result.policy.isCopilot).toBe(false)
      expect(result.policy.isBedrock).toBe(false)
    })

    it('anthropic + oauth → ok', () => {
      const conn = makeConn({ slug: 'claude-max', providerType: 'anthropic', authType: 'oauth' })
      const result = resolveExecutablePolicy(conn)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.policy.provider).toBe('anthropic')
      expect(result.policy.credentialType).toBe('oauth_access')
      expect(result.policy.staticHref).toBe('https://api.anthropic.com/')
      expect(result.policy.isCopilot).toBe(false)
      expect(result.policy.isBedrock).toBe(false)
    })
  })

  describe('oauth catalog (3 providers)', () => {
    for (const provider of OAUTH_CATALOG_PROVIDERS) {
      it(`pi + oauth + ${provider} → ok catalog policy`, () => {
        const conn = makeConn({ slug: `oauth-${provider}`, providerType: 'pi', authType: 'oauth', piAuthProvider: provider })
        const result = resolveExecutablePolicy(conn)
        expect(result.ok).toBe(true)
        if (!result.ok) return
        const p = result.policy
        expect(p.routeKind).toBe('catalog')
        expect(p.provider).toBe(provider)
        expect(p.credentialType).toBe('oauth_access')
        if (provider === 'github-copilot') {
          expect(p.isCopilot).toBe(true)
          expect(p.staticHref).toBeUndefined()
        } else {
          expect(p.isCopilot).toBe(false)
          expect(p.staticHref).toBe(CATALOG_TRANSPORT_HREFS[provider])
        }
        expect(p.isBedrock).toBe(false)
      })
    }
  })

  it('amazon-bedrock + iam_credentials → ok', () => {
    const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('amazon-bedrock')
    expect(result.policy.credentialType).toBe('iam')
    expect(result.policy.isCopilot).toBe(false)
    expect(result.policy.isBedrock).toBe(true)
    expect(result.policy.staticHref).toBeUndefined()
  })

  it('pi_compat + api_key_with_endpoint + openai-completions → ok custom', () => {
    const conn = makeConn({
      slug: 'custom-oai',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.example.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const p = result.policy
    expect(p.routeKind).toBe('custom')
    expect(p.provider).toBe('openai')
    expect(p.api).toBe('openai-completions')
    expect(p.credentialType).toBe('api_key')
    expect(p.staticHref).toBe('https://api.example.com/v1')
    expect(p.isCopilot).toBe(false)
    expect(p.isBedrock).toBe(false)
  })

  it('pi_compat + api_key_with_endpoint + anthropic-messages → ok custom', () => {
    const conn = makeConn({
      slug: 'custom-ant',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.anthropic.example.com/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('anthropic')
    expect(result.policy.api).toBe('anthropic-messages')
  })

  it('pi_compat + none + loopback baseUrl → ok keyless custom', () => {
    const conn = makeConn({
      slug: 'local-llm',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: 'http://localhost:8080/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.credentialType).toBe('none')
    expect(result.policy.provider).toBe('openai')
    expect(result.policy.staticHref).toBe('http://localhost:8080/v1')
  })

  it('pi_compat + none + 127.0.0.1 baseUrl → ok', () => {
    const conn = makeConn({
      slug: 'local-127',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: 'http://127.0.0.1:11434/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    expect(resolveExecutablePolicy(conn).ok).toBe(true)
  })
})

describe('resolveExecutablePolicy — non-executable combinations (P5)', () => {
  it('environment auth → not ok', () => {
    const conn = makeConn({ slug: 'env', providerType: 'pi', authType: 'environment', piAuthProvider: 'openai' })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })

  it('bearer_token auth → not ok', () => {
    const conn = makeConn({ slug: 'bearer', providerType: 'pi', authType: 'bearer_token', piAuthProvider: 'openai' })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })

  it('service_account_file auth → not ok', () => {
    const conn = makeConn({ slug: 'sa', providerType: 'pi', authType: 'service_account_file', piAuthProvider: 'google' })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })

  it('pi_compat + api_key (without endpoint) → not ok', () => {
    const conn = makeConn({ slug: 'bad-compat', providerType: 'pi_compat', authType: 'api_key' })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })

  it('pi_compat + none + non-loopback baseUrl → not ok', () => {
    const conn = makeConn({
      slug: 'evil-none',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: 'http://evil.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })

  it('pi_compat + api_key_with_endpoint + invalid baseUrl (ftp) → not ok', () => {
    const conn = makeConn({
      slug: 'ftp-compat',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'ftp://bad.example.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })

  it('pi + api_key + unknown provider → not ok', () => {
    const conn = makeConn({ slug: 'unknown', providerType: 'pi', authType: 'api_key', piAuthProvider: 'unknown-provider' })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })

  it('pi + oauth + unknown provider → not ok', () => {
    const conn = makeConn({ slug: 'unknown-oauth', providerType: 'pi', authType: 'oauth', piAuthProvider: 'unknown-provider' })
    expect(resolveExecutablePolicy(conn).ok).toBe(false)
  })
})

// ─── 2. anthropic two production connections ─────────────────────────

describe('anthropic two production connections', () => {
  it('anthropic-api (api_key) → provider=anthropic, credentialType=api_key, staticHref correct', () => {
    const conn = makeConn({
      slug: 'anthropic-api',
      name: 'Anthropic (API Key)',
      providerType: 'anthropic',
      authType: 'api_key',
      defaultModel: 'claude-sonnet-4-6',
      models: ['claude-sonnet-4-6'],
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('anthropic')
    expect(result.policy.credentialType).toBe('api_key')
    expect(result.policy.staticHref).toBe('https://api.anthropic.com/')
  })

  it('claude-max (oauth) → provider=anthropic, credentialType=oauth_access, staticHref correct', () => {
    const conn = makeConn({
      slug: 'claude-max',
      name: 'Claude Max',
      providerType: 'anthropic',
      authType: 'oauth',
      defaultModel: 'claude-sonnet-4-6',
      models: ['claude-sonnet-4-6'],
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('anthropic')
    expect(result.policy.credentialType).toBe('oauth_access')
    expect(result.policy.staticHref).toBe('https://api.anthropic.com/')
  })
})

// ─── 3. selectExactModel ─────────────────────────────────────────────

describe('selectExactModel', () => {
  it('requested model wins over default', () => {
    const conn = makeConn({ slug: 'm', defaultModel: 'model-b', models: ['model-a', 'model-b'] })
    const r = selectExactModel(conn, 'model-a')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe('model-a')
  })

  it('default model used when no requested model', () => {
    const conn = makeConn({ slug: 'm', defaultModel: 'model-b', models: ['model-a', 'model-b'] })
    const r = selectExactModel(conn, undefined)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe('model-b')
  })

  it('no model at all → default_model_missing', () => {
    const conn = makeConn({ slug: 'm' })
    const r = selectExactModel(conn, undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('default_model_missing')
  })

  it('requested model not in connection.models → model_not_in_connection', () => {
    const conn = makeConn({ slug: 'm', defaultModel: 'model-a', models: ['model-a'] })
    const r = selectExactModel(conn, 'model-x')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('model_not_in_connection')
  })

  it('no models list → pass through any model', () => {
    const conn = makeConn({ slug: 'm', defaultModel: 'default-model' })
    const r = selectExactModel(conn, 'any-model')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe('any-model')
  })

  it('empty models list → pass through any model', () => {
    const conn = makeConn({ slug: 'm', defaultModel: 'default-model', models: [] })
    const r = selectExactModel(conn, 'any-model')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.model).toBe('any-model')
  })

  it('default model not in models list → model_not_in_connection', () => {
    const conn = makeConn({ slug: 'm', defaultModel: 'missing-model', models: ['model-a'] })
    const r = selectExactModel(conn, undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('model_not_in_connection')
  })

  it('adjacent provider same ID: each connection only hits its own models', () => {
    const conn1 = makeConn({ slug: 'c1', defaultModel: 'shared-model', models: ['shared-model'] })
    const conn2 = makeConn({ slug: 'c2', defaultModel: 'shared-model', models: ['shared-model', 'other-model'] })
    expect(selectExactModel(conn1, 'shared-model').ok).toBe(true)
    expect(selectExactModel(conn2, 'shared-model').ok).toBe(true)
    expect(selectExactModel(conn1, 'other-model').ok).toBe(false)
    expect(selectExactModel(conn2, 'other-model').ok).toBe(true)
  })
})

// ─── 4. readCredentialSnapshot ───────────────────────────────────────

describe('readCredentialSnapshot', () => {
  const TIMEOUT_MS = 30_000

  describe('api_key', () => {
    it('credential present → ok with {type:api_key, value}', async () => {
      const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'api_key' })
      setInvocationCredential({ type: 'llm_api_key', connectionSlug: 'test' }, { value: 'test-key' })
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.credential.type).toBe('api_key')
        expect((r.credential as { value: string }).value).toBe('test-key')
      }
    })

    it('credential missing → credential_missing', async () => {
      const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'api_key' })
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_missing')
    })
  })

  describe('api_key_with_endpoint (custom api_key)', () => {
    it('credential present → ok', async () => {
      const conn = makeConn({
        slug: 'custom',
        providerType: 'pi_compat',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://api.example.com/v1',
        customEndpoint: { api: 'openai-completions' },
      })
      setInvocationCredential({ type: 'llm_api_key', connectionSlug: 'custom' }, { value: 'custom-key' })
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.credential.type).toBe('api_key')
    })

    it('credential missing → credential_missing', async () => {
      const conn = makeConn({
        slug: 'custom',
        providerType: 'pi_compat',
        authType: 'api_key_with_endpoint',
        baseUrl: 'https://api.example.com/v1',
        customEndpoint: { api: 'openai-completions' },
      })
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_missing')
    })
  })

  describe('oauth', () => {
    it('expiresAt > now + timeoutMs + 300000 → ok', async () => {
      const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'oauth' })
      const expiresAt = Date.now() + TIMEOUT_MS + 300_000 + 60_000
      setInvocationCredential(
        { type: 'llm_oauth', connectionSlug: 'test' },
        { value: 'test-token', expiresAt },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.credential.type).toBe('oauth_access')
        expect((r.credential as { value: string }).value).toBe('test-token')
      }
    })

    it('no expiresAt → credential_expired', async () => {
      const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'oauth' })
      setInvocationCredential(
        { type: 'llm_oauth', connectionSlug: 'test' },
        { value: 'test-token' },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_expired')
    })

    it('expiresAt <= now → credential_expired', async () => {
      const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'oauth' })
      setInvocationCredential(
        { type: 'llm_oauth', connectionSlug: 'test' },
        { value: 'test-token', expiresAt: Date.now() - 1000 },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_expired')
    })

    it('now < expiresAt <= now + timeoutMs + 300000 → credential_expired', async () => {
      const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'oauth' })
      const expiresAt = Date.now() + TIMEOUT_MS + 100_000
      setInvocationCredential(
        { type: 'llm_oauth', connectionSlug: 'test' },
        { value: 'test-token', expiresAt },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_expired')
    })

    it('credential missing → credential_missing', async () => {
      const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'oauth' })
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_missing')
    })
  })

  describe('iam_credentials', () => {
    it('valid IAM credential with region → ok', async () => {
      const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
      setInvocationCredential(
        { type: 'llm_iam', connectionSlug: 'bedrock' },
        { value: 'test-secret', awsAccessKeyId: 'test-ak', awsRegion: 'us-east-1' },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(true)
      if (r.ok) {
        const c = r.credential as { type: string; accessKeyId: string; secretAccessKey: string; region: string }
        expect(c.type).toBe('iam')
        expect(c.accessKeyId).toBe('test-ak')
        expect(c.secretAccessKey).toBe('test-secret')
        expect(c.region).toBe('us-east-1')
      }
    })

    it('IAM credential with sessionToken → ok with sessionToken', async () => {
      const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
      setInvocationCredential(
        { type: 'llm_iam', connectionSlug: 'bedrock' },
        { value: 'test-secret', awsAccessKeyId: 'test-ak', awsRegion: 'us-east-1', awsSessionToken: 'session-token' },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(true)
      if (r.ok) {
        const c = r.credential as { type: string; sessionToken?: string }
        expect(c.sessionToken).toBe('session-token')
      }
    })

    it('IAM credential without region → credential_missing', async () => {
      const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
      setInvocationCredential(
        { type: 'llm_iam', connectionSlug: 'bedrock' },
        { value: 'test-secret', awsAccessKeyId: 'test-ak' },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_missing')
    })

    it('IAM credential with invalid region → credential_missing', async () => {
      const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
      setInvocationCredential(
        { type: 'llm_iam', connectionSlug: 'bedrock' },
        { value: 'test-secret', awsAccessKeyId: 'test-ak', awsRegion: 'INVALID_REGION!' },
      )
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_missing')
    })

    it('IAM credential missing entirely → credential_missing', async () => {
      const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toBe('credential_missing')
    })
  })

  describe('none (keyless)', () => {
    it('no credential read → {type:none}', async () => {
      const conn = makeConn({
        slug: 'local',
        providerType: 'pi_compat',
        authType: 'none',
        baseUrl: 'http://localhost:8080/v1',
        customEndpoint: { api: 'openai-completions' },
      })
      const r = await readCredentialSnapshot(conn, TIMEOUT_MS)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.credential.type).toBe('none')
    })
  })
})

// ─── 5. computeFingerprint ───────────────────────────────────────────

describe('computeFingerprint', () => {
  const baseConn: LlmConnection = {
    slug: 'test',
    name: 'Test',
    providerType: 'anthropic',
    authType: 'api_key',
    defaultModel: 'claude-sonnet-4-6',
    models: ['claude-sonnet-4-6', 'claude-haiku-4-5'],
    createdAt: 1000,
  }

  it('same connection → same fingerprint', () => {
    const c1 = { ...baseConn }
    const c2 = { ...baseConn }
    expect(computeFingerprint(c1)).toBe(computeFingerprint(c2))
  })

  it('different slug → different fingerprint', () => {
    const c1 = { ...baseConn }
    const c2 = { ...baseConn, slug: 'other' }
    expect(computeFingerprint(c1)).not.toBe(computeFingerprint(c2))
  })

  it('different providerType → different fingerprint', () => {
    const c1 = { ...baseConn }
    const c2 = { ...baseConn, providerType: 'pi' as const }
    expect(computeFingerprint(c1)).not.toBe(computeFingerprint(c2))
  })

  it('different authType → different fingerprint', () => {
    const c1 = { ...baseConn }
    const c2 = { ...baseConn, authType: 'oauth' as const }
    expect(computeFingerprint(c1)).not.toBe(computeFingerprint(c2))
  })

  it('different piAuthProvider → different fingerprint', () => {
    const c1 = { ...baseConn, providerType: 'pi' as const, piAuthProvider: 'openai' }
    const c2 = { ...baseConn, providerType: 'pi' as const, piAuthProvider: 'google' }
    expect(computeFingerprint(c1)).not.toBe(computeFingerprint(c2))
  })

  it('different baseUrl → different fingerprint', () => {
    const c1 = { ...baseConn }
    const c2 = { ...baseConn, baseUrl: 'https://other.example.com' }
    expect(computeFingerprint(c1)).not.toBe(computeFingerprint(c2))
  })

  it('different models → different fingerprint (modelIds)', () => {
    const c1 = { ...baseConn, models: ['model-a'] }
    const c2 = { ...baseConn, models: ['model-b'] }
    expect(computeFingerprint(c1)).not.toBe(computeFingerprint(c2))
  })

  it('different model order → different fingerprint', () => {
    const c1 = { ...baseConn, models: ['model-a', 'model-b'] }
    const c2 = { ...baseConn, models: ['model-b', 'model-a'] }
    expect(computeFingerprint(c1)).not.toBe(computeFingerprint(c2))
  })

  it('same fields, different property assignment order → same fingerprint', () => {
    const c1: LlmConnection = { slug: 'test', name: 'Test', providerType: 'anthropic', authType: 'api_key', createdAt: 1000 }
    const c2: LlmConnection = { name: 'Test', authType: 'api_key', slug: 'test', providerType: 'anthropic', createdAt: 1000 }
    expect(computeFingerprint(c1)).toBe(computeFingerprint(c2))
  })

  it('missing models → empty modelIds in fingerprint', () => {
    const c = { ...baseConn, models: undefined }
    const fp = computeFingerprint(c)
    expect(fp).toContain('"modelIds":[]')
  })
})

// ─── 6. createHostDescriptor ─────────────────────────────────────────

describe('createHostDescriptor', () => {
  it('catalog api_key → wireRoute with transportBaseUrl', () => {
    const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'api_key' })
    const policy = resolveExecutablePolicy(conn)!
    if (!policy.ok) return
    const credential = { type: 'api_key' as const, value: 'test-key' }
    const desc = trackDescriptor(createHostDescriptor(conn, policy.policy, credential))
    expect(desc.wireRoute).toEqual({
      kind: 'catalog',
      provider: 'anthropic',
      transportBaseUrl: 'https://api.anthropic.com/',
    })
    expect(desc.wireCredential).toEqual(credential)
    expect(desc.provider).toBe('anthropic')
    expect(desc.env['HOME']).toBe(desc.privateHome)
    expect(existsSync(desc.privateHome)).toBe(true)
  })

  it('catalog oauth copilot → wireRoute with copilotTransportHref', () => {
    const conn = makeConn({ slug: 'copilot', providerType: 'pi', authType: 'oauth', piAuthProvider: 'github-copilot' })
    const policy = resolveExecutablePolicy(conn)!
    if (!policy.ok) return
    const token = 'proxy-ep=proxy.example.com;foo'
    const credential = { type: 'oauth_access' as const, value: token }
    const desc = trackDescriptor(createHostDescriptor(conn, policy.policy, credential))
    const expectedHref = copilotTransportHref(token)
    expect(desc.wireRoute).toEqual({
      kind: 'catalog',
      provider: 'github-copilot',
      transportBaseUrl: expectedHref,
    })
  })

  it('catalog bedrock → wireRoute with bedrockTransportHref and AWS env', () => {
    const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
    const policy = resolveExecutablePolicy(conn)!
    if (!policy.ok) return
    const credential = {
      type: 'iam' as const,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      region: 'us-east-1',
    }
    const desc = trackDescriptor(createHostDescriptor(conn, policy.policy, credential))
    expect(desc.wireRoute).toEqual({
      kind: 'catalog',
      provider: 'amazon-bedrock',
      transportBaseUrl: bedrockTransportHref('us-east-1'),
    })
    expect(desc.env['AWS_ACCESS_KEY_ID']).toBe('ak')
    expect(desc.env['AWS_SECRET_ACCESS_KEY']).toBe('sk')
    expect(desc.env['AWS_REGION']).toBe('us-east-1')
    expect(desc.env['AWS_DEFAULT_REGION']).toBe('us-east-1')
    expect(desc.env['AWS_EC2_METADATA_DISABLED']).toBe('true')
    expect(desc.env['AWS_MAX_ATTEMPTS']).toBe('1')
    expect(desc.env['AWS_BEDROCK_FORCE_HTTP1']).toBe('1')
  })

  it('catalog bedrock with sessionToken → AWS_SESSION_TOKEN set', () => {
    const conn = makeConn({ slug: 'bedrock', providerType: 'pi', authType: 'iam_credentials', piAuthProvider: 'amazon-bedrock' })
    const policy = resolveExecutablePolicy(conn)!
    if (!policy.ok) return
    const credential = {
      type: 'iam' as const,
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      sessionToken: 'st',
      region: 'us-east-1',
    }
    const desc = trackDescriptor(createHostDescriptor(conn, policy.policy, credential))
    expect(desc.env['AWS_SESSION_TOKEN']).toBe('st')
  })

  it('custom api_key → wireRoute with custom shape', () => {
    const conn = makeConn({
      slug: 'custom',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.example.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    const policy = resolveExecutablePolicy(conn)!
    if (!policy.ok) return
    const credential = { type: 'api_key' as const, value: 'test-key' }
    const desc = trackDescriptor(createHostDescriptor(conn, policy.policy, credential))
    expect(desc.wireRoute).toEqual({
      kind: 'custom',
      provider: 'openai',
      api: 'openai-completions',
      baseUrl: 'https://api.example.com/v1',
    })
    expect(desc.provider).toBe('openai')
  })

  it('custom none → wireRoute with custom shape and none credential', () => {
    const conn = makeConn({
      slug: 'local',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: 'http://localhost:8080/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })
    const policy = resolveExecutablePolicy(conn)!
    if (!policy.ok) return
    const credential = { type: 'none' as const }
    const desc = trackDescriptor(createHostDescriptor(conn, policy.policy, credential))
    expect(desc.wireRoute).toEqual({
      kind: 'custom',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'http://localhost:8080/v1',
    })
  })

  it('env is sanitized (only allowlisted keys inherited)', () => {
    const conn = makeConn({ slug: 'test', providerType: 'anthropic', authType: 'api_key' })
    const policy = resolveExecutablePolicy(conn)!
    if (!policy.ok) return
    const credential = { type: 'api_key' as const, value: 'k' }
    const desc = trackDescriptor(createHostDescriptor(conn, policy.policy, credential))
    expect(desc.env['HOME']).toBe(desc.privateHome)
    expect(desc.env['PATH']).toBeDefined()
    expect(desc.env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(desc.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  })
})

// ─── 7. Poison-pill test ─────────────────────────────────────────────

describe('poison-pill: module boundary sealed', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(import.meta.dir, '.poison-pill-tmp'))
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  })

  const EXTERNALS = [
    '@anthropic-ai/claude-agent-sdk',
    '@polo-ai/session-tools-core',
    '@mariozechner/pi-ai',
    '@mariozechner/pi-ai/*',
    '@aws-sdk/*',
    'koffi',
  ]

  const REQUIRED_INPUTS = [
    'host-llm-executor.ts',
    'host-llm-contract.ts',
    'host-executor-factory.ts',
    'config/storage.ts',
    'credentials/index.ts',
    'credentials/manager.ts',
    'sessions/index.ts',
    'utils/runtime-env.ts',
  ]

  const FORBIDDEN_INPUTS = [
    'claude-agent.ts',
    'pi-agent.ts',
    'backend/factory.ts',
    'backend/index.ts',
    'session-server',
    'proxy-tool-registry',
    'session-tools-core',
    'AuthStorage',
    'ModelRegistry',
    '@mariozechner/pi-ai',
    '@aws-sdk',
    'claude-agent-sdk',
  ]

  async function buildEntrypoint(entryPath: string) {
    const outdir = mkdtempSync(join(tmpDir, 'out-'))
    const result = await Bun.build({
      entrypoints: [entryPath],
      target: 'node',
      metafile: true,
      outdir,
      external: EXTERNALS,
    })
    if (!result.success) {
      throw new AggregateError(result.logs, 'Bun.build failed')
    }
    rmSync(outdir, { recursive: true, force: true })
    return result
  }

  it('entry1 (@polo-ai/shared/agent/host-llm-executor) contains required inputs', async () => {
    const entry = join(tmpDir, 'entry1.ts')
    writeFileSync(entry, `import '@polo-ai/shared/agent/host-llm-executor'\n`)
    const result = await buildEntrypoint(entry)
    const inputPaths = Object.keys(result.metafile!.inputs)
    for (const required of REQUIRED_INPUTS) {
      expect(inputPaths.some(p => p.includes(required))).toBe(true)
    }
  })

  it('entry1 does NOT contain forbidden inputs', async () => {
    const entry = join(tmpDir, 'entry1.ts')
    writeFileSync(entry, `import '@polo-ai/shared/agent/host-llm-executor'\n`)
    const result = await buildEntrypoint(entry)
    const inputPaths = Object.keys(result.metafile!.inputs)
    for (const forbidden of FORBIDDEN_INPUTS) {
      expect(inputPaths.some(p => p.includes(forbidden))).toBe(false)
    }
  })

  it('entry2 (@polo-ai/shared/agent/backend/host-executor-factory) does NOT contain forbidden inputs', async () => {
    const entry = join(tmpDir, 'entry2.ts')
    writeFileSync(entry, `import '@polo-ai/shared/agent/backend/host-executor-factory'\n`)
    const result = await buildEntrypoint(entry)
    const inputPaths = Object.keys(result.metafile!.inputs)
    for (const forbidden of FORBIDDEN_INPUTS) {
      expect(inputPaths.some(p => p.includes(forbidden))).toBe(false)
    }
  })

  it('package.json exports map ./agent/backend/host-executor-factory → host-llm-executor.ts', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const pkgPath = join(import.meta.dir, '..', '..', '..', '..', 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
    expect(pkg.exports['./agent/backend/host-executor-factory']).toBe('./src/agent/host-llm-executor.ts')
    expect(pkg.exports['./agent/host-llm-executor']).toBe('./src/agent/host-llm-executor.ts')
  })

  it('host-llm-executor module exports the frozen public surface (value exports)', async () => {
    const mod = await import('@polo-ai/shared/agent/host-llm-executor')
    const expectedValueExports = new Set([
      'createSessionlessHostLlmExecutor',
      'HOST_PARENT_MARKER',
      'HostLlmConfigurationError',
    ])
    const actualValueExports = new Set(Object.keys(mod))
    for (const key of expectedValueExports) {
      expect(actualValueExports.has(key)).toBe(true)
    }
  })

  it('strategy helpers are NOT exported via @polo-ai/shared/agent/host-llm-executor', async () => {
    const mod = await import('@polo-ai/shared/agent/host-llm-executor')
    const strategyHelpers = [
      'resolveExecutablePolicy',
      'selectExactModel',
      'readCredentialSnapshot',
      'createHostDescriptor',
      'computeFingerprint',
    ]
    for (const helper of strategyHelpers) {
      expect((mod as Record<string, unknown>)[helper]).toBeUndefined()
    }
  })

  it('both specifiers resolve to the same module at runtime (subprocess)', async () => {
    const { execSync } = await import('node:child_process')
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..', '..')
    const result = execSync(
      `bun -e "const m1 = await import('@polo-ai/shared/agent/host-llm-executor'); const m2 = await import('@polo-ai/shared/agent/backend/host-executor-factory'); const k1 = Object.keys(m1).sort().join(','); const k2 = Object.keys(m2).sort().join(','); console.log(k1 === k2 ? 'SAME' : 'DIFF:' + k1 + '|' + k2)"`,
      { encoding: 'utf-8', cwd: repoRoot },
    )
    expect(result.trim()).toBe('SAME')
  })

  it('strategy helpers NOT exported via either specifier (subprocess)', async () => {
    const { execSync } = await import('node:child_process')
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..', '..')
    const result = execSync(
      `bun -e "const m2 = await import('@polo-ai/shared/agent/backend/host-executor-factory'); const helpers = ['resolveExecutablePolicy','selectExactModel','readCredentialSnapshot','createHostDescriptor','computeFingerprint']; const leaked = helpers.filter(h => typeof m2[h] !== 'undefined'); console.log(leaked.length === 0 ? 'SEALED' : 'LEAKED:' + leaked.join(','))"`,
      { encoding: 'utf-8', cwd: repoRoot },
    )
    expect(result.trim()).toBe('SEALED')
  })

  it('createSessionlessHostLlmExecutor and HOST_PARENT_MARKER are defined', async () => {
    const mod = await import('@polo-ai/shared/agent/host-llm-executor')
    expect(typeof mod.createSessionlessHostLlmExecutor).toBe('function')
    expect(mod.HOST_PARENT_MARKER).toBeDefined()
    expect(mod.HostLlmConfigurationError).toBeDefined()
  })
})

// ─── 8. Custom api_key present/missing fixtures ──────────────────────

describe('custom api_key present/missing', () => {
  it('key present → readCredentialSnapshot returns ok', async () => {
    const conn = makeConn({
      slug: 'custom-key',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.custom.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    setInvocationCredential(
      { type: 'llm_api_key', connectionSlug: 'custom-key' },
      { value: 'the-key' },
    )
    const r = await readCredentialSnapshot(conn, 30_000)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.credential.type).toBe('api_key')
      expect((r.credential as { value: string }).value).toBe('the-key')
    }
  })

  it('key missing/empty → credential_missing', async () => {
    const conn = makeConn({
      slug: 'custom-no-key',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.custom.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    const r = await readCredentialSnapshot(conn, 30_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('credential_missing')
  })

  it('empty string key → credential_missing', async () => {
    const conn = makeConn({
      slug: 'custom-empty-key',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.custom.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    setInvocationCredential(
      { type: 'llm_api_key', connectionSlug: 'custom-empty-key' },
      { value: '' },
    )
    const r = await readCredentialSnapshot(conn, 30_000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('credential_missing')
  })
})

// ─── 9. Custom none/keyless public provider fixtures ─────────────────

describe('custom none/keyless public provider derivation', () => {
  it('openai-completions → public provider="openai"', () => {
    const conn = makeConn({
      slug: 'local-oai',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: 'http://localhost:8080/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('openai')
  })

  it('anthropic-messages → public provider="anthropic"', () => {
    const conn = makeConn({
      slug: 'local-ant',
      providerType: 'pi_compat',
      authType: 'none',
      baseUrl: 'http://localhost:8080/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('anthropic')
  })

  it('custom api_key openai-completions → provider="openai"', () => {
    const conn = makeConn({
      slug: 'custom-oai',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.custom.com/v1',
      customEndpoint: { api: 'openai-completions' },
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('openai')
  })

  it('custom api_key anthropic-messages → provider="anthropic"', () => {
    const conn = makeConn({
      slug: 'custom-ant',
      providerType: 'pi_compat',
      authType: 'api_key_with_endpoint',
      baseUrl: 'https://api.custom.com/v1',
      customEndpoint: { api: 'anthropic-messages' },
    })
    const result = resolveExecutablePolicy(conn)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.policy.provider).toBe('anthropic')
  })
})

// ─── contract helpers ────────────────────────────────────────────────

describe('contract helpers', () => {
  describe('normalizeCustomTransportHref', () => {
    it('valid https URL → returns href', () => {
      expect(normalizeCustomTransportHref('https://api.example.com/v1')).toBe('https://api.example.com/v1')
    })

    it('valid http localhost → returns href', () => {
      expect(normalizeCustomTransportHref('http://localhost:8080/v1')).toBe('http://localhost:8080/v1')
    })

    it('valid http 127.0.0.1 → returns href', () => {
      expect(normalizeCustomTransportHref('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
    })

    it('http non-loopback → null', () => {
      expect(normalizeCustomTransportHref('http://evil.com/v1')).toBeNull()
    })

    it('ftp protocol → null', () => {
      expect(normalizeCustomTransportHref('ftp://bad.example.com/v1')).toBeNull()
    })

    it('path traversal segment → null', () => {
      expect(normalizeCustomTransportHref('https://api.example.com/../evil')).toBeNull()
    })

    it('URL with username/password → null', () => {
      expect(normalizeCustomTransportHref('https://user:pass@api.example.com/v1')).toBeNull()
    })

    it('URL with hash → null', () => {
      expect(normalizeCustomTransportHref('https://api.example.com/v1#hash')).toBeNull()
    })

    it('invalid URL string → null', () => {
      expect(normalizeCustomTransportHref('not-a-url')).toBeNull()
    })
  })

  describe('copilotTransportHref', () => {
    it('token with proxy-ep → resolves to api.* URL', () => {
      const href = copilotTransportHref('proxy-ep=proxy.example.com;other-stuff')
      expect(href).toBe('https://api.example.com/')
    })

    it('token without proxy-ep → default copilot URL', () => {
      const href = copilotTransportHref('plain-token')
      expect(href).toBe('https://api.individual.githubcopilot.com/')
    })
  })

  describe('bedrockTransportHref', () => {
    it('returns bedrock-runtime URL with region', () => {
      expect(bedrockTransportHref('us-east-1')).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/')
      expect(bedrockTransportHref('eu-west-2')).toBe('https://bedrock-runtime.eu-west-2.amazonaws.com/')
    })
  })

  describe('contract constants', () => {
    it('HOST_PARENT_MARKER is a non-empty string', () => {
      expect(typeof HOST_PARENT_MARKER).toBe('string')
      expect(HOST_PARENT_MARKER.length).toBeGreaterThan(0)
    })

    it('ID_LIMIT and TEXT_LIMIT are positive integers', () => {
      expect(typeof ID_LIMIT).toBe('number')
      expect(ID_LIMIT).toBeGreaterThan(0)
      expect(typeof TEXT_LIMIT).toBe('number')
      expect(TEXT_LIMIT).toBeGreaterThan(0)
    })

    it('WIRE_RESULT_ROWS is a non-empty record', () => {
      expect(typeof WIRE_RESULT_ROWS).toBe('object')
      expect(Object.keys(WIRE_RESULT_ROWS).length).toBeGreaterThan(0)
    })

    it('PUBLIC_ERROR_MESSAGES is a non-empty record', () => {
      expect(typeof PUBLIC_ERROR_MESSAGES).toBe('object')
      expect(Object.keys(PUBLIC_ERROR_MESSAGES).length).toBeGreaterThan(0)
    })
  })

  describe('validateWorkerResult', () => {
    const requestId = 'req-123'
    const model = 'test-model'

    it('valid completed result → ok', () => {
      const line = JSON.stringify({
        type: 'host_completion_result',
        version: 1,
        requestId,
        model,
        status: 'completed',
        text: 'Hello',
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 15,
          reportedModel: model,
          terminalReason: 'stop',
          provenance: 'provider_final',
        },
      })
      const r = validateWorkerResult(line, requestId, model)
      expect(r.ok).toBe(true)
    })

    it('invalid JSON → not ok', () => {
      expect(validateWorkerResult('not json', requestId, model).ok).toBe(false)
    })

    it('wrong requestId → not ok', () => {
      const line = JSON.stringify({
        type: 'host_completion_result',
        version: 1,
        requestId: 'wrong',
        model,
        status: 'completed',
        text: 'Hi',
        usage: {
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 2, reportedModel: model, terminalReason: 'stop', provenance: 'provider_final',
        },
      })
      expect(validateWorkerResult(line, requestId, model).ok).toBe(false)
    })

    it('wrong model → not ok', () => {
      const line = JSON.stringify({
        type: 'host_completion_result',
        version: 1,
        requestId,
        model: 'wrong',
        status: 'completed',
        text: 'Hi',
        usage: {
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 2, reportedModel: model, terminalReason: 'stop', provenance: 'provider_final',
        },
      })
      expect(validateWorkerResult(line, requestId, model).ok).toBe(false)
    })

    it('completed without usage → not ok', () => {
      const line = JSON.stringify({
        type: 'host_completion_result',
        version: 1,
        requestId,
        model,
        status: 'completed',
        text: 'Hi',
      })
      expect(validateWorkerResult(line, requestId, model).ok).toBe(false)
    })

    it('unknown extra field → not ok', () => {
      const line = JSON.stringify({
        type: 'host_completion_result',
        version: 1,
        requestId,
        model,
        status: 'completed',
        text: 'Hi',
        usage: {
          inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
          totalTokens: 2, reportedModel: model, terminalReason: 'stop', provenance: 'provider_final',
        },
        extraField: 'bad',
      })
      expect(validateWorkerResult(line, requestId, model).ok).toBe(false)
    })
  })
})
