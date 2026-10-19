import { describe, it, expect } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  getSessionToolDefs,
  getSessionToolNames,
  getSessionToolRegistry,
  getSessionSafeAllowedToolNames,
  getSessionSafeBlockedToolNames,
  getToolDefsAsJsonSchema,
} from './tool-defs.ts';

describe('session tool filtering helpers', () => {
  it('excludes developer feedback tool when includeDeveloperFeedback is false', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('includes developer feedback tool when includeDeveloperFeedback is true', () => {
    const defs = getSessionToolDefs({ includeDeveloperFeedback: true });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(true);
  });

  it('name set and registry stay aligned for filtered output', () => {
    const names = getSessionToolNames({ includeDeveloperFeedback: false });
    const registry = getSessionToolRegistry({ includeDeveloperFeedback: false });

    expect(registry.has('send_developer_feedback')).toBe(false);
    expect(names.has('send_developer_feedback')).toBe(false);

    for (const name of names) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it('json schema conversion respects includeDeveloperFeedback filter', () => {
    const defs = getToolDefsAsJsonSchema({ includeDeveloperFeedback: false });
    const names = defs.map(d => d.name);

    expect(names.includes('send_developer_feedback')).toBe(false);
  });

  it('all canonical session tools declare safeMode metadata', () => {
    for (const def of SESSION_TOOL_DEFS) {
      expect(def.safeMode === 'allow' || def.safeMode === 'block').toBe(true);
    }
  });

  it('safe-mode helper sets classify expected tools', () => {
    const allowed = getSessionSafeAllowedToolNames();
    const blocked = getSessionSafeBlockedToolNames();

    expect(allowed.has('send_developer_feedback')).toBe(true);
    expect(allowed.has('call_llm')).toBe(true);
    expect(allowed.has('browser_tool')).toBe(true);
    expect(allowed.has('script_sandbox')).toBe(true);

    expect(blocked.has('source_oauth_trigger')).toBe(true);
    expect(blocked.has('source_credential_prompt')).toBe(true);
    expect(blocked.has('spawn_session')).toBe(true);
  });

  it('safe-mode helpers support MCP prefixing', () => {
    const allowedPrefixed = getSessionSafeAllowedToolNames({ prefix: 'mcp__session__' });
    const blockedPrefixed = getSessionSafeBlockedToolNames({ prefix: 'mcp__session__' });

    expect(allowedPrefixed.has('mcp__session__send_developer_feedback')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__call_llm')).toBe(true);
    expect(allowedPrefixed.has('mcp__session__script_sandbox')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__source_oauth_trigger')).toBe(true);
    expect(blockedPrefixed.has('mcp__session__spawn_session')).toBe(true);
  });
});

describe('render_ui tool gating', () => {
  it('does not register render_ui by default (fail closed)', () => {
    const names = getSessionToolNames();
    expect(names.has('render_ui')).toBe(false);
  });

  it('does not register render_ui when the toggle flag is off', () => {
    const defs = getSessionToolDefs({ allowRenderUi: false, allowRequestUserInput: true });
    const names = defs.map(d => d.name);

    expect(names.includes('render_ui')).toBe(false);
  });

  it('registers render_ui only when the toggle flag is on', () => {
    const defs = getSessionToolDefs({ allowRenderUi: true });
    const def = defs.find(d => d.name === 'render_ui');

    expect(def).toBeDefined();
    expect(def?.executionMode).toBe('registry');
    expect(def?.safeMode).toBe('allow');
    expect(def?.readOnly).toBe(true);
    expect(def?.handler).toBeDefined();
  });

  it('json schema conversion respects the allowRenderUi filter', () => {
    const off = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).map(d => d.name);
    expect(off.includes('mcp__session__render_ui')).toBe(false);

    const on = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', allowRenderUi: true }).map(d => d.name);
    expect(on.includes('mcp__session__render_ui')).toBe(true);
  });
});

describe('generate_app tool gating', () => {
  it('does not register generate_app by default (fail closed)', () => {
    const names = getSessionToolNames();
    expect(names.has('generate_app')).toBe(false);
  });

  it('does not register generate_app when the toggle flag is off', () => {
    const defs = getSessionToolDefs({ allowGenerateApp: false, allowRenderUi: true, allowRequestUserInput: true });
    const names = defs.map(d => d.name);

    expect(names.includes('generate_app')).toBe(false);
  });

  it('registers generate_app only when the toggle flag is on', () => {
    const defs = getSessionToolDefs({ allowGenerateApp: true });
    const def = defs.find(d => d.name === 'generate_app');

    expect(def).toBeDefined();
    expect(def?.executionMode).toBe('registry');
    expect(def?.safeMode).toBe('allow');
    expect(def?.handler).toBeDefined();
  });

  it('render_ui and generate_app toggle independently', () => {
    const onlyCanvas = getSessionToolDefs({ allowGenerateApp: true }).map(d => d.name);
    expect(onlyCanvas.includes('generate_app')).toBe(true);
    expect(onlyCanvas.includes('render_ui')).toBe(false);

    const onlyInline = getSessionToolDefs({ allowRenderUi: true }).map(d => d.name);
    expect(onlyInline.includes('render_ui')).toBe(true);
    expect(onlyInline.includes('generate_app')).toBe(false);
  });

  it('json schema conversion respects the allowGenerateApp filter', () => {
    const off = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).map(d => d.name);
    expect(off.includes('mcp__session__generate_app')).toBe(false);

    const on = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', allowGenerateApp: true }).map(d => d.name);
    expect(on.includes('mcp__session__generate_app')).toBe(true);
  });
});
