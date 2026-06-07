import { describe, expect, it } from 'bun:test'
import {
  validateSetupTestInput,
  resolveCustomEndpointSetup,
  createBuiltInConnection,
} from './connection-setup-logic'

describe('validateSetupTestInput', () => {
  it('rejects pi custom endpoint tests without piAuthProvider', () => {
    const result = validateSetupTestInput({
      provider: 'pi',
      baseUrl: 'https://example.com/v1',
    })

    expect(result.valid).toBe(false)
    if (!result.valid) {
      expect(result.error).toContain('requires selecting a provider preset')
    }
  })

  it('allows pi custom endpoint tests with piAuthProvider', () => {
    expect(validateSetupTestInput({
      provider: 'pi',
      baseUrl: 'https://example.com/v1',
      piAuthProvider: 'openai',
    })).toEqual({ valid: true })
  })
})

describe('resolveCustomEndpointSetup', () => {
  it('treats a custom endpoint without a credential as keyed metadata', () => {
    const result = resolveCustomEndpointSetup({
      credential: undefined,
      customEndpointApi: 'openai-completions',
    })

    expect(result).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })

  it('treats a custom endpoint with a credential as keyed metadata', () => {
    const result = resolveCustomEndpointSetup({
      credential: 'sk-test',
      customEndpointApi: 'openai-completions',
    })

    expect(result).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })

  it('uses the anthropic provider hint for anthropic-messages protocol', () => {
    const result = resolveCustomEndpointSetup({
      credential: 'sk-ant',
      customEndpointApi: 'anthropic-messages',
    })

    expect(result).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'anthropic' })
  })

  it('treats remote endpoints with a credential as keyed custom endpoints', () => {
    expect(resolveCustomEndpointSetup({
      credential: 'sk-remote',
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })

  it('treats remote endpoints without a credential as keyed (still requires a key)', () => {
    expect(resolveCustomEndpointSetup({
      credential: undefined,
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })

  it('treats undefined baseUrl as a non-loopback (keyed) endpoint', () => {
    expect(resolveCustomEndpointSetup({
      credential: 'sk-anything',
      customEndpointApi: 'openai-completions',
    })).toEqual({ authType: 'api_key_with_endpoint', piAuthProvider: 'openai' })
  })
})

// New connections must persist a per-provider midStreamBehavior default so the
// per-connection submenu in Settings → AI shows a checkmark on the right item
// out of the box (no read-time fallback needed for fresh connections).
describe('createBuiltInConnection seeds midStreamBehavior', () => {
  it("Anthropic API key → 'queue' (Claude's emulated steer is fragile)", () => {
    const conn = createBuiltInConnection('anthropic-api')
    expect(conn.providerType).toBe('anthropic')
    expect(conn.midStreamBehavior).toBe('queue')
  })

  it("Claude Max OAuth → 'queue' (still uses Claude SDK)", () => {
    const conn = createBuiltInConnection('claude-max')
    expect(conn.providerType).toBe('anthropic')
    expect(conn.midStreamBehavior).toBe('queue')
  })

  it("ChatGPT Plus → 'steer' (Pi backend, native polite steer)", () => {
    const conn = createBuiltInConnection('chatgpt-plus')
    expect(conn.providerType).toBe('pi')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it("Pi API key (Polo AI Backend) → 'steer'", () => {
    const conn = createBuiltInConnection('pi-api-key')
    expect(conn.providerType).toBe('pi')
    expect(conn.midStreamBehavior).toBe('steer')
  })

  it("anthropic-api with custom endpoint becomes pi_compat → 'steer'", () => {
    const conn = createBuiltInConnection('anthropic-api', 'http://localhost:11434/v1')
    expect(conn.providerType).toBe('pi_compat')
    expect(conn.midStreamBehavior).toBe('steer')
  })
})
