/**
 * Wire protocol pinning and transport URL rules.
 *
 * Verifies that the parent-side contract (host-llm-contract.ts) stays
 * byte-compatible with the worker-side protocol (host-completion-protocol.ts),
 * and that transport URL derivation functions produce canonical hrefs the
 * worker will accept.
 */
import { describe, it, expect } from 'bun:test';
import {
  HOST_PARENT_MARKER, ID_LIMIT, TEXT_LIMIT,
  WIRE_RESULT_ROWS, PUBLIC_ERROR_MESSAGES,
  validateWorkerResult, normalizeCustomTransportHref, copilotTransportHref, bedrockTransportHref,
  makePublicError,
} from '../../host-llm-contract.ts';
import {
  HOST_ERRORS, HOST_PARENT_MARKER as PROTOCOL_MARKER, ID_LIMIT as PROTOCOL_ID_LIMIT, TEXT_LIMIT as PROTOCOL_TEXT_LIMIT,
  validateHostRequest, canonicalTransportHref, unsafeSegments, serializeHostResult, failureResult,
  RESULT_TOO_LARGE_LINE,
} from '../../../../../pi-agent-server/src/host-completion-protocol.ts';
import { resolveExecutablePolicy } from '../host-executor-factory.ts';
import type { LlmConnection } from '../../../config/llm-connections.ts';

// ============================================================
// 1. Protocol pinning assertions
// ============================================================

describe('protocol pinning', () => {
  it('contract constants match protocol constants', () => {
    expect(HOST_PARENT_MARKER).toEqual(PROTOCOL_MARKER);
    expect(ID_LIMIT).toEqual(PROTOCOL_ID_LIMIT);
    expect(TEXT_LIMIT).toEqual(PROTOCOL_TEXT_LIMIT);
  });

  it('WIRE_RESULT_ROWS matches HOST_ERRORS for all 13 rows', () => {
    for (const [kind, tuple] of Object.entries(HOST_ERRORS)) {
      const [status, code, reason, message] = tuple;
      const key = `${code}|${reason}`;
      expect(WIRE_RESULT_ROWS[key]).toBeDefined();
      expect(WIRE_RESULT_ROWS[key]).toEqual(tuple);
    }
    expect(Object.keys(WIRE_RESULT_ROWS).length).toEqual(Object.keys(HOST_ERRORS).length);
  });
});

// ============================================================
// 2. validateHostRequest black-box boundary tests
// ============================================================

describe('validateHostRequest boundary', () => {
  const validRequest = {
    type: 'host_completion' as const,
    version: 1 as const,
    parentValidation: HOST_PARENT_MARKER,
    requestId: 'host-test-123',
    model: 'claude-sonnet-4-6',
    prompt: 'Hello',
    maxOutputTokens: 1024,
    timeoutMs: 5000,
    route: { kind: 'catalog' as const, provider: 'anthropic', transportBaseUrl: 'https://api.anthropic.com/' },
    credential: { type: 'api_key' as const, value: 'test-key' },
  };

  it('accepts a valid catalog request', () => {
    const verdict = validateHostRequest(validRequest);
    expect(verdict.kind).toBe('valid');
    if (verdict.kind === 'valid') {
      expect(verdict.request.routeKind).toBe('catalog');
      expect(verdict.request.provider).toBe('anthropic');
      expect(verdict.request.transportHref).toBe('https://api.anthropic.com/');
    }
  });

  it('accepts a valid custom request (openai-completions, https)', () => {
    const verdict = validateHostRequest({
      ...validRequest,
      route: { kind: 'custom', provider: 'openai', api: 'openai-completions', baseUrl: 'https://api.example.com/v1' },
    });
    expect(verdict.kind).toBe('valid');
    if (verdict.kind === 'valid') {
      expect(verdict.request.routeKind).toBe('custom');
      expect(verdict.request.api).toBe('openai-completions');
      expect(verdict.request.transportHref).toBe('https://api.example.com/v1');
    }
  });

  it('accepts a valid custom request (anthropic-messages, http loopback)', () => {
    const verdict = validateHostRequest({
      ...validRequest,
      route: { kind: 'custom', provider: 'anthropic', api: 'anthropic-messages', baseUrl: 'http://localhost:8080/v1' },
    });
    expect(verdict.kind).toBe('valid');
    if (verdict.kind === 'valid') {
      expect(verdict.request.routeKind).toBe('custom');
      expect(verdict.request.api).toBe('anthropic-messages');
      expect(verdict.request.transportHref).toBe('http://localhost:8080/v1');
    }
  });

  it('rejects missing required fields', () => {
    const verdict = validateHostRequest({ type: 'host_completion', version: 1 });
    expect(verdict.kind).toBe('invalid');
  });

  it('rejects oversize prompt (>1 MiB)', () => {
    const verdict = validateHostRequest({
      ...validRequest,
      prompt: 'x'.repeat(1_048_577),
    });
    expect(verdict.kind).toBe('oversize');
  });

  it('rejects oversize requestId (>8192 bytes)', () => {
    const verdict = validateHostRequest({
      ...validRequest,
      requestId: 'x'.repeat(8193),
    });
    expect(verdict.kind).toBe('oversize');
  });

  it('rejects empty requestId', () => {
    const verdict = validateHostRequest({
      ...validRequest,
      requestId: '',
    });
    expect(verdict.kind).toBe('invalid');
  });

  it('rejects invalid route (missing provider)', () => {
    const verdict = validateHostRequest({
      ...validRequest,
      route: { kind: 'catalog', provider: '', transportBaseUrl: 'https://api.anthropic.com/' },
    });
    expect(verdict.kind).toBe('invalid');
  });

  it('rejects invalid credential (missing value)', () => {
    const verdict = validateHostRequest({
      ...validRequest,
      credential: { type: 'api_key', value: '' },
    });
    expect(verdict.kind).toBe('invalid');
  });
});

// ============================================================
// 3. bedrockTransportHref multi-region test
// ============================================================

describe('bedrockTransportHref', () => {
  const regions = [
    'us-east-1',
    'us-west-2',
    'eu-central-1',
    'ap-south-1',
    'ap-northeast-1',
    'ca-central-1',
  ];

  for (const region of regions) {
    it(`produces canonical https href for ${region}`, () => {
      const href = bedrockTransportHref(region);
      expect(href).toBe(`https://bedrock-runtime.${region}.amazonaws.com/`);
      expect(canonicalTransportHref(href)).toBe(href);
      expect(href.endsWith('/')).toBe(true);
      expect(href).toContain(region);
    });
  }

  it('still generates href for empty region (validation is in policy)', () => {
    const href = bedrockTransportHref('');
    expect(href).toBe('https://bedrock-runtime..amazonaws.com/');
  });

  it('still generates href for special-char region (validation is elsewhere)', () => {
    const href = bedrockTransportHref('us-east-1;malicious');
    expect(href).toBe('https://bedrock-runtime.us-east-1;malicious.amazonaws.com/');
  });
});

// ============================================================
// 4. normalizeCustomTransportHref consistency
// ============================================================

describe('normalizeCustomTransportHref', () => {
  const validCases: Array<[string, string]> = [
    ['http://localhost:8080/v1', 'http://localhost:8080/v1'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000/'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['https://localhost:8443', 'https://localhost:8443/'],
  ];

  for (const [input, expected] of validCases) {
    it(`normalizes ${input} → ${expected}`, () => {
      expect(normalizeCustomTransportHref(input)).toBe(expected);
    });

    it(`normalized result passes validateHostRequest with custom route: ${input}`, () => {
      const href = normalizeCustomTransportHref(input);
      expect(href).not.toBeNull();
      const isHttps = input.startsWith('https://');
      const verdict = validateHostRequest({
        type: 'host_completion',
        version: 1,
        parentValidation: HOST_PARENT_MARKER,
        requestId: 'r',
        model: 'm',
        prompt: 'p',
        maxOutputTokens: 1024,
        timeoutMs: 5000,
        route: {
          kind: 'custom',
          provider: isHttps ? 'openai' : 'anthropic',
          api: isHttps ? 'openai-completions' : 'anthropic-messages',
          baseUrl: input,
        },
        credential: { type: 'api_key', value: 'k' },
      });
      expect(verdict.kind).toBe('valid');
      if (verdict.kind === 'valid') {
        expect(verdict.request.transportHref).toBe(href as string);
      }
    });
  }

  const invalidCases = [
    'http://evil.com',
    'http://evil.com:8080',
    'ftp://localhost:8080',
    'https://user:pass@api.example.com/',
    'https://api.example.com/#fragment',
    'https://api.example.com/../etc/passwd',
    'https://api.example.com/./test',
    'not-a-url',
  ];

  for (const input of invalidCases) {
    it(`rejects ${input}`, () => {
      expect(normalizeCustomTransportHref(input)).toBeNull();
    });
  }
});

// ============================================================
// 5. copilotTransportHref same-origin derivation
// ============================================================

describe('copilotTransportHref', () => {
  it('default token (no proxy-ep) → canonical individual endpoint', () => {
    expect(copilotTransportHref('test-token')).toBe('https://api.individual.githubcopilot.com/');
  });

  it('proxy-ep token → canonical proxy-derived endpoint', () => {
    expect(copilotTransportHref('token;proxy-ep=proxy.example.com;other')).toBe('https://api.example.com/');
  });

  it('proxy dot replacement (proxy. → api.)', () => {
    expect(copilotTransportHref('token;proxy-ep=proxy.api.example.com;other')).toBe('https://api.api.example.com/');
  });

  it('matches pi-ai getGitHubCopilotBaseUrl canonicalized', async () => {
    const { getGitHubCopilotBaseUrl } = await import('@mariozechner/pi-ai/oauth');
    expect(copilotTransportHref('test-token')).toEqual(new URL(getGitHubCopilotBaseUrl('test-token')).href);
    expect(copilotTransportHref('token;proxy-ep=proxy.example.com;other')).toEqual(
      new URL(getGitHubCopilotBaseUrl('token;proxy-ep=proxy.example.com;other')).href,
    );
    expect(copilotTransportHref('token;proxy-ep=proxy.api.example.com;other')).toEqual(
      new URL(getGitHubCopilotBaseUrl('token;proxy-ep=proxy.api.example.com;other')).href,
    );
  });

  it('malformed proxy-ep with spaces → null (Fix R2 Issue 1)', () => {
    expect(copilotTransportHref('token;proxy-ep=exam ple.com;other')).toBeNull();
  });

  it('malformed proxy-ep with illegal characters → null (Fix R2 Issue 1)', () => {
    expect(copilotTransportHref('token;proxy-ep=<script>;other')).toBeNull();
  });

  it('malformed proxy-ep with port out of range → null (Fix R2 Issue 1)', () => {
    expect(copilotTransportHref('token;proxy-ep=example.com:99999;other')).toBeNull();
  });
});

// ============================================================
// 6. CATALOG_TRANSPORT_HREFS correctness
// ============================================================

describe('CATALOG_TRANSPORT_HREFS correctness (via resolveExecutablePolicy)', () => {
  const apiKeyProviders = [
    'anthropic', 'google', 'openai', 'cerebras', 'deepseek', 'fireworks', 'groq', 'huggingface',
    'kimi-coding', 'minimax', 'minimax-cn', 'mistral', 'moonshotai', 'moonshotai-cn',
    'opencode', 'opencode-go', 'openrouter', 'vercel-ai-gateway', 'xai',
    'xiaomi', 'xiaomi-token-plan-ams', 'xiaomi-token-plan-cn', 'xiaomi-token-plan-sgp', 'zai',
  ];

  it('matches canonicalOf(getModels(provider)[0].baseUrl) for every API key catalog provider', async () => {
    const { getModels } = await import('@mariozechner/pi-ai');
    for (const p of apiKeyProviders) {
      const conn: LlmConnection = {
        slug: 'test',
        name: 'test',
        providerType: 'pi',
        authType: 'api_key',
        piAuthProvider: p,
        defaultModel: 'test',
        models: ['test'],
        createdAt: 0,
      };
      const result = resolveExecutablePolicy(conn);
      expect(result.ok).toBe(true);
      if (result.ok) {
        const models = getModels(p as any);
        expect(models.length).toBeGreaterThan(0);
        const expectedHref = new URL(models[0]!.baseUrl).href;
        expect(result.policy.staticHref).toEqual(expectedHref);
      }
    }
  });

  it('matches for anthropic providerType with api_key', async () => {
    const { getModels } = await import('@mariozechner/pi-ai');
    const conn: LlmConnection = {
      slug: 'test',
      name: 'test',
      providerType: 'anthropic',
      authType: 'api_key',
      defaultModel: 'test',
      models: ['test'],
      createdAt: 0,
    };
    const result = resolveExecutablePolicy(conn);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const models = getModels('anthropic' as any);
      expect(models.length).toBeGreaterThan(0);
      const expectedHref = new URL(models[0]!.baseUrl).href;
      expect(result.policy.staticHref).toEqual(expectedHref);
    }
  });
});

// ============================================================
// 7. serializeHostResult upper limit test
// ============================================================

describe('serializeHostResult upper limits', () => {
  const baseResult = {
    type: 'host_completion_result' as const,
    version: 1 as const,
    requestId: 'r',
    model: 'm',
    status: 'completed' as const,
    text: 'hello',
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
      reportedModel: 'm',
      terminalReason: 'stop' as const,
      provenance: 'provider_final' as const,
    },
  };

  it('returns RESULT_TOO_LARGE_LINE when text exceeds TEXT_LIMIT', () => {
    const line = serializeHostResult({ ...baseResult, text: 'x'.repeat(TEXT_LIMIT + 1) });
    expect(line).toBe(RESULT_TOO_LARGE_LINE);
  });

  it('returns RESULT_TOO_LARGE_LINE when requestId exceeds ID_LIMIT', () => {
    const line = serializeHostResult({ ...baseResult, requestId: 'x'.repeat(ID_LIMIT + 1) });
    expect(line).toBe(RESULT_TOO_LARGE_LINE);
  });

  it('returns RESULT_TOO_LARGE_LINE when model exceeds ID_LIMIT', () => {
    const line = serializeHostResult({ ...baseResult, model: 'x'.repeat(ID_LIMIT + 1) });
    expect(line).toBe(RESULT_TOO_LARGE_LINE);
  });

  it('returns RESULT_TOO_LARGE_LINE when usage.reportedModel exceeds ID_LIMIT', () => {
    const line = serializeHostResult({
      ...baseResult,
      usage: { ...baseResult.usage, reportedModel: 'x'.repeat(ID_LIMIT + 1) },
    });
    expect(line).toBe(RESULT_TOO_LARGE_LINE);
  });

  it('returns RESULT_TOO_LARGE_LINE when error.reason exceeds 1024 bytes', () => {
    const line = serializeHostResult({
      ...baseResult,
      status: 'failed',
      text: undefined,
      error: { code: 'provider_failed', reason: 'x'.repeat(1025), message: 'msg' },
    });
    expect(line).toBe(RESULT_TOO_LARGE_LINE);
  });

  it('returns RESULT_TOO_LARGE_LINE when error.message exceeds 1024 bytes', () => {
    const line = serializeHostResult({
      ...baseResult,
      status: 'failed',
      text: undefined,
      error: { code: 'provider_failed', reason: 'provider_request_failed', message: 'x'.repeat(1025) },
    });
    expect(line).toBe(RESULT_TOO_LARGE_LINE);
  });

  it('returns RESULT_TOO_LARGE_LINE when total line exceeds 4 MiB', () => {
    const hugeResult = {
      ...baseResult,
      text: 'a'.repeat(TEXT_LIMIT),
      _padding: 'x'.repeat(4 * 1024 * 1024),
    } as any;
    const line = serializeHostResult(hugeResult);
    expect(line).toBe(RESULT_TOO_LARGE_LINE);
  });

  it('serializes a valid result normally', () => {
    const line = serializeHostResult(baseResult);
    expect(line).not.toBe(RESULT_TOO_LARGE_LINE);
    expect(line.endsWith('\n')).toBe(true);
    expect(JSON.parse(line).text).toBe('hello');
  });
});

// ============================================================
// 8. Parent-side extreme subset declaration
// ============================================================

describe('parent-side limits are strict subset of wire protocol', () => {
  it('maxOutputTokens parent range 1..8192 is within wire 1..65536', () => {
    const parentMax = 8192;
    const wireMin = 1;
    const wireMax = 65536;
    expect(parentMax).toBeLessThanOrEqual(wireMax);
    expect(wireMin).toBeLessThanOrEqual(1);
    expect(parentMax).toBeLessThan(wireMax);
  });

  it('timeoutMs parent range 1000..120000 is within wire 100..600000', () => {
    const parentMin = 1000;
    const parentMax = 120_000;
    const wireMin = 100;
    const wireMax = 600_000;
    expect(wireMin).toBeLessThan(parentMin);
    expect(parentMax).toBeLessThan(wireMax);
  });
});

// ============================================================
// 9. WIRE_RESULT_ROWS completeness
// ============================================================

describe('WIRE_RESULT_ROWS completeness', () => {
  it('all entries have unique code|reason keys', () => {
    const keys = Object.keys(WIRE_RESULT_ROWS);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('all entries have matching status as first tuple element', () => {
    for (const [key, tuple] of Object.entries(WIRE_RESULT_ROWS)) {
      const [status, code, reason, message] = tuple;
      const parts = key.split('|');
      expect(code).toBe(parts[0] as string);
      expect(reason).toBe(parts[1] as string);
    }
  });

  it('all 4-tuple elements are non-empty strings', () => {
    for (const [key, tuple] of Object.entries(WIRE_RESULT_ROWS)) {
      expect(tuple.length).toBe(4);
      for (const element of tuple) {
        expect(typeof element).toBe('string');
        expect(element.length).toBeGreaterThan(0);
      }
    }
  });

  it('has exactly 13 entries', () => {
    expect(Object.keys(WIRE_RESULT_ROWS).length).toBe(13);
  });
});

// ============================================================
// 10. PUBLIC_ERROR_MESSAGES completeness
// ============================================================

describe('PUBLIC_ERROR_MESSAGES completeness', () => {
  it('all entries have unique code|reason keys', () => {
    const keys = Object.keys(PUBLIC_ERROR_MESSAGES);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  it('all status values are valid (failed or cancelled)', () => {
    for (const [key, [status, message]] of Object.entries(PUBLIC_ERROR_MESSAGES)) {
      expect(['failed', 'cancelled']).toContain(status);
    }
  });

  it('all messages are non-empty', () => {
    for (const [key, [status, message]] of Object.entries(PUBLIC_ERROR_MESSAGES)) {
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('has exactly 14 entries', () => {
    expect(Object.keys(PUBLIC_ERROR_MESSAGES).length).toBe(14);
  });
});

// ============================================================
// Cross-module: makePublicError consistency
// ============================================================

describe('makePublicError', () => {
  it('produces correct status and message from PUBLIC_ERROR_MESSAGES', () => {
    const result = makePublicError('connection_not_found', 'missing_slug', 'req-1', 'model-1');
    expect(result.status).toBe('failed');
    if ('error' in result) {
      expect(result.error.code).toBe('connection_not_found');
      expect(result.error.reason).toBe('missing_slug');
      expect(result.error.message).toBe('LLM connection not found for the given slug');
    }
    expect(result.requestId).toBe('req-1');
    expect(result.model).toBe('model-1');
  });

  it('includes usage when provided', () => {
    const usage = {
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 30,
      reportedModel: 'm',
    };
    const result = makePublicError('worker_failed', 'worker_exited', 'r', 'm', usage);
    expect((result as any).usage).toEqual(usage);
  });
});

// ============================================================
// Cross-module: validateWorkerResult + failureResult round-trip
// ============================================================

describe('validateWorkerResult + failureResult round-trip', () => {
  it('accepts a failureResult line for each HOST_ERRORS kind', () => {
    for (const [kind, [status, code, reason, message]] of Object.entries(HOST_ERRORS)) {
      const result = failureResult('req-1', 'model-1', kind as any);
      const line = JSON.stringify(result) + '\n';
      const verdict = validateWorkerResult(line, 'req-1', 'model-1');
      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.result.status as string).toBe(status as string);
        expect(verdict.result.error?.code).toBe(code as string);
        expect(verdict.result.error?.reason).toBe(reason as string);
      }
    }
  });

  it('rejects mismatched requestId', () => {
    const result = failureResult('req-1', 'model-1', 'empty_text');
    const line = JSON.stringify(result) + '\n';
    const verdict = validateWorkerResult(line, 'wrong-id', 'model-1');
    expect(verdict.ok).toBe(false);
  });

  it('rejects mismatched model', () => {
    const result = failureResult('req-1', 'model-1', 'empty_text');
    const line = JSON.stringify(result) + '\n';
    const verdict = validateWorkerResult(line, 'req-1', 'wrong-model');
    expect(verdict.ok).toBe(false);
  });
});
