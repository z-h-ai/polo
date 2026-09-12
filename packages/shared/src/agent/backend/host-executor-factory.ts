import { copilotTransportHref, bedrockTransportHref, normalizeCustomTransportHref } from '../host-llm-contract.ts'
import { getLlmConnection } from '../../config/storage.ts'
import { getCredentialManager } from '../../credentials/index.ts'
import { createSafeRuntimeEnvironment } from '../../utils/runtime-env.ts'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LlmConnection } from '../../config/llm-connections.ts'

const API_KEY_CATALOG_PROVIDERS = new Set(['anthropic', 'google', 'openai', 'cerebras', 'deepseek', 'fireworks', 'groq', 'huggingface',
  'kimi-coding', 'minimax', 'minimax-cn', 'mistral', 'moonshotai', 'moonshotai-cn', 'opencode', 'opencode-go', 'openrouter',
  'vercel-ai-gateway', 'xai', 'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai'])
const OAUTH_CATALOG_PROVIDERS = new Set(['anthropic', 'openai-codex', 'github-copilot'])
const CATALOG_TRANSPORT_HREFS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/', google: 'https://generativelanguage.googleapis.com/v1beta', openai: 'https://api.openai.com/v1',
  cerebras: 'https://api.cerebras.ai/v1', deepseek: 'https://api.deepseek.com/', fireworks: 'https://api.fireworks.ai/inference',
  groq: 'https://api.groq.com/openai/v1', huggingface: 'https://router.huggingface.co/v1', 'kimi-coding': 'https://api.kimi.com/coding',
  minimax: 'https://api.minimax.io/anthropic', 'minimax-cn': 'https://api.minimaxi.com/anthropic', mistral: 'https://api.mistral.ai/',
  moonshotai: 'https://api.moonshot.ai/v1', 'moonshotai-cn': 'https://api.moonshot.cn/v1', opencode: 'https://opencode.ai/zen/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1', openrouter: 'https://openrouter.ai/api/v1', 'vercel-ai-gateway': 'https://ai-gateway.vercel.sh/',
  xai: 'https://api.x.ai/v1', xiaomi: 'https://api.xiaomimimo.com/anthropic', 'xiaomi-token-plan-ams': 'https://token-plan-ams.xiaomimimo.com/anthropic',
  'xiaomi-token-plan-cn': 'https://token-plan-cn.xiaomimimo.com/anthropic', 'xiaomi-token-plan-sgp': 'https://token-plan-sgp.xiaomimimo.com/anthropic',
  zai: 'https://api.z.ai/api/coding/paas/v4', 'openai-codex': 'https://chatgpt.com/backend-api',
}

export type WireCredential = { type: 'api_key'; value: string } | { type: 'oauth_access'; value: string }
  | { type: 'iam'; accessKeyId: string; secretAccessKey: string; sessionToken?: string; region: string } | { type: 'none' }

export interface ExecutablePolicy {
  routeKind: 'catalog' | 'custom'; provider: string; api?: 'openai-completions' | 'anthropic-messages'
  credentialType: 'api_key' | 'oauth_access' | 'iam' | 'none'; staticHref?: string; isCopilot: boolean; isBedrock: boolean
}
export type PolicyResult = { ok: true; policy: ExecutablePolicy } | { ok: false }
export type ModelResult = { ok: true; model: string } | { ok: false; reason: 'default_model_missing' | 'model_not_in_connection' }
export type CredentialResult = { ok: true; credential: WireCredential } | { ok: false; reason: 'credential_missing' | 'credential_expired' }
export interface HostSpawnDescriptor {
  wireRoute: { kind: 'catalog'; provider: string; transportBaseUrl: string } | { kind: 'custom'; provider: string; api: string; baseUrl: string }
  wireCredential: WireCredential; env: NodeJS.ProcessEnv; privateHome: string; provider: string
}

export function computeFingerprint(c: LlmConnection): string {
  const modelIds = (c.models ?? []).map(m => typeof m === 'string' ? m : m.id)
  return JSON.stringify({ slug: c.slug, providerType: c.providerType, piAuthProvider: c.piAuthProvider, authType: c.authType,
    baseUrl: c.baseUrl, customEndpoint: c.customEndpoint, defaultModel: c.defaultModel, modelIds })
}

export function resolveExecutablePolicy(c: LlmConnection): PolicyResult {
  const at = c.authType, pt = c.providerType, pa = c.piAuthProvider
  if (pt === 'anthropic' && at === 'api_key') return { ok: true, policy: { routeKind: 'catalog', provider: 'anthropic', credentialType: 'api_key', staticHref: CATALOG_TRANSPORT_HREFS['anthropic'], isCopilot: false, isBedrock: false } }
  if (pt === 'anthropic' && at === 'oauth') return { ok: true, policy: { routeKind: 'catalog', provider: 'anthropic', credentialType: 'oauth_access', staticHref: CATALOG_TRANSPORT_HREFS['anthropic'], isCopilot: false, isBedrock: false } }
  if (pt === 'pi' && at === 'api_key' && pa && API_KEY_CATALOG_PROVIDERS.has(pa)) return { ok: true, policy: { routeKind: 'catalog', provider: pa, credentialType: 'api_key', staticHref: CATALOG_TRANSPORT_HREFS[pa], isCopilot: false, isBedrock: false } }
  if (pt === 'pi' && at === 'oauth' && pa && OAUTH_CATALOG_PROVIDERS.has(pa)) {
    if (pa === 'github-copilot') return { ok: true, policy: { routeKind: 'catalog', provider: pa, credentialType: 'oauth_access', isCopilot: true, isBedrock: false } }
    return { ok: true, policy: { routeKind: 'catalog', provider: pa, credentialType: 'oauth_access', staticHref: CATALOG_TRANSPORT_HREFS[pa], isCopilot: false, isBedrock: false } }
  }
  if (pt === 'pi' && at === 'iam_credentials' && pa === 'amazon-bedrock') return { ok: true, policy: { routeKind: 'catalog', provider: pa, credentialType: 'iam', isCopilot: false, isBedrock: true } }
  if (pt === 'pi_compat' && at === 'api_key_with_endpoint' && c.customEndpoint?.api) {
    const href = normalizeCustomTransportHref(c.baseUrl ?? '')
    if (!href) return { ok: false }
    return { ok: true, policy: { routeKind: 'custom', provider: c.customEndpoint.api === 'openai-completions' ? 'openai' : 'anthropic', api: c.customEndpoint.api, credentialType: 'api_key', staticHref: href, isCopilot: false, isBedrock: false } }
  }
  if (pt === 'pi_compat' && at === 'none' && c.customEndpoint?.api) {
    const href = normalizeCustomTransportHref(c.baseUrl ?? '')
    if (!href) return { ok: false }
    const h = new URL(href).hostname.replace(/^\[(.+)\]$/, '$1')
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '::1') return { ok: false }
    return { ok: true, policy: { routeKind: 'custom', provider: c.customEndpoint.api === 'openai-completions' ? 'openai' : 'anthropic', api: c.customEndpoint.api, credentialType: 'none', staticHref: href, isCopilot: false, isBedrock: false } }
  }
  return { ok: false }
}

export function selectExactModel(c: LlmConnection, requested?: string): ModelResult {
  const model = requested ?? c.defaultModel
  if (!model) return { ok: false, reason: 'default_model_missing' }
  const models = c.models
  if (!models || models.length === 0) return { ok: true, model }
  const found = models.some(m => (typeof m === 'string' ? m : m.id) === model)
  return found ? { ok: true, model } : { ok: false, reason: 'model_not_in_connection' }
}

export async function readCredentialSnapshot(c: LlmConnection, timeoutMs: number): Promise<CredentialResult> {
  const slug = c.slug, at = c.authType, mgr = getCredentialManager()
  if (at === 'none') return { ok: true, credential: { type: 'none' } }
  if (at === 'api_key' || at === 'api_key_with_endpoint') {
    const value = await mgr.getLlmApiKey(slug)
    if (!value) return { ok: false, reason: 'credential_missing' }
    return { ok: true, credential: { type: 'api_key', value } }
  }
  if (at === 'oauth') {
    const oauth = await mgr.getLlmOAuth(slug)
    if (!oauth) return { ok: false, reason: 'credential_missing' }
    const now = Date.now()
    if (!oauth.expiresAt || oauth.expiresAt <= now + timeoutMs + 300_000) return { ok: false, reason: 'credential_expired' }
    return { ok: true, credential: { type: 'oauth_access', value: oauth.accessToken } }
  }
  if (at === 'iam_credentials') {
    const iam = await mgr.getLlmIamCredentials(slug)
    if (!iam) return { ok: false, reason: 'credential_missing' }
    if (!iam.region || !/^[a-z0-9-]{2,24}$/.test(iam.region)) return { ok: false, reason: 'credential_missing' }
    return { ok: true, credential: { type: 'iam', accessKeyId: iam.accessKeyId, secretAccessKey: iam.secretAccessKey, ...(iam.sessionToken ? { sessionToken: iam.sessionToken } : {}), region: iam.region } }
  }
  return { ok: false, reason: 'credential_missing' }
}

const BEDROCK_AWS_KEYS: Record<string, string> = {
  AWS_EC2_METADATA_DISABLED: 'true', AWS_MAX_ATTEMPTS: '1', AWS_BEDROCK_FORCE_HTTP1: '1', AWS_USE_FIPS_ENDPOINT: 'false', AWS_USE_DUALSTACK_ENDPOINT: 'false',
}

export function createHostDescriptor(c: LlmConnection, policy: ExecutablePolicy, credential: WireCredential): HostSpawnDescriptor {
  let transportHref = policy.staticHref ?? ''
  if (policy.isCopilot && credential.type === 'oauth_access') transportHref = copilotTransportHref(credential.value)
  else if (policy.isBedrock && credential.type === 'iam') transportHref = bedrockTransportHref(credential.region)
  const privateHome = mkdtempSync(join(tmpdir(), 'polo-host-llm-'))
  const env = createSafeRuntimeEnvironment(process.env, { HOME: privateHome })
  if (policy.isBedrock && credential.type === 'iam') {
    env['AWS_ACCESS_KEY_ID'] = credential.accessKeyId; env['AWS_SECRET_ACCESS_KEY'] = credential.secretAccessKey
    if (credential.sessionToken) env['AWS_SESSION_TOKEN'] = credential.sessionToken
    env['AWS_REGION'] = credential.region; env['AWS_DEFAULT_REGION'] = credential.region
    for (const [k, v] of Object.entries(BEDROCK_AWS_KEYS)) env[k] = v
  }
  const wireRoute = policy.routeKind === 'catalog'
    ? { kind: 'catalog' as const, provider: policy.provider, transportBaseUrl: transportHref }
    : { kind: 'custom' as const, provider: policy.provider, api: policy.api!, baseUrl: transportHref }
  return { wireRoute, wireCredential: credential, env, privateHome, provider: policy.provider }
}

