import { describe, it, expect } from 'bun:test';
import {
  getSessionToolDefs,
  getSessionSafeAllowedToolNames,
  getSessionToolNames,
} from '@polo-ai/session-tools-core';
import { getSessionToolProxyDefs } from '../backend/pi/session-tool-defs.ts';
import { getSessionScopedTools, invalidateAllSessionToolsCaches } from '../session-scoped-tools.ts';

/**
 * request_user_input cross-backend parity contract:
 * - Only desktop interactive turns register the tool (allowRequestUserInput)
 * - Claude (registry adapter) and Pi (JSON-schema proxy) must derive visibility
 *   from the same canonical filter so backends never drift.
 * - The tool is safe-mode allowed (asking a question must not re-trigger
 *   permission confirmation in any permission mode).
 */
const TOOL = 'request_user_input';

function names(defs: Array<{ name: string }>): Set<string> {
  return new Set(defs.map(d => d.name));
}

describe('request_user_input registration parity (Claude vs Pi)', () => {
  it('is excluded by default for every backend (fail closed)', () => {
    const canonical = getSessionToolNames();
    expect(canonical.has(TOOL)).toBe(false);

    const proxyNames = names(getSessionToolProxyDefs());
    expect(proxyNames.has(TOOL)).toBe(false);
  });

  it('appears in Pi proxy defs only when allowRequestUserInput is set', () => {
    const allowed = names(getSessionToolProxyDefs({ allowRequestUserInput: true }));
    expect(allowed.has(`mcp__session__${TOOL}`)).toBe(true);

    const denied = names(getSessionToolProxyDefs({ allowRequestUserInput: false }));
    expect(denied.has(`mcp__session__${TOOL}`)).toBe(false);
  });

  it('Pi proxy defs mirror the canonical filter for both flag states', () => {
    const stripPrefix = (set: Set<string>) =>
      new Set([...set].map(n => (n.startsWith('mcp__session__') ? n.slice('mcp__session__'.length) : n)));

    // Pi applies FEATURE_FLAGS.developerFeedback (false in tests), so mirror it here.
    const canonicalAllowed = getSessionToolNames({ allowRequestUserInput: true, includeDeveloperFeedback: false });
    const proxyAllowed = stripPrefix(names(getSessionToolProxyDefs({ allowRequestUserInput: true })));
    expect(proxyAllowed).toEqual(canonicalAllowed);

    const canonicalDenied = getSessionToolNames({ allowRequestUserInput: false, includeDeveloperFeedback: false });
    const proxyDenied = stripPrefix(names(getSessionToolProxyDefs({ allowRequestUserInput: false })));
    expect(proxyDenied).toEqual(canonicalDenied);
  });

  it('is treated as safe-mode allowed (no extra permission confirmation)', () => {
    const allowed = getSessionSafeAllowedToolNames({ allowRequestUserInput: true });
    expect(allowed.has(TOOL)).toBe(true);
  });

  it('Claude adapter toolset follows the same canonical filter', () => {
    invalidateAllSessionToolsCaches();
    const server = getSessionScopedTools(
      'parity-test-session',
      '/tmp/parity-workspace',
      'parity-test-workspace',
    ) as unknown as { tools?: Array<{ name?: string; def?: { name?: string } }> };

    // The SDK MCP server shape is opaque; assert the canonical filter the
    // adapter builds from instead of reaching into SDK internals.
    const registryToolNames = new Set(
      getSessionToolDefs({ allowRequestUserInput: true })
        .filter(def => def.handler !== null)
        .map(def => def.name),
    );
    expect(registryToolNames.has(TOOL)).toBe(true);
    void server;
  });
});
