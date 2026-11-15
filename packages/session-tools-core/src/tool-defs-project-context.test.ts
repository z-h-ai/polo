/**
 * POO-196 project context tool tests
 *
 * Covers the fail-closed registry gating (allowProjectContext defaults to
 * false), the proxy (JSON Schema) mirror, and the handler contract: a
 * null/absent facade fails closed with the explicit message, a real facade's
 * search/read output carries assetId/version, and read errors relay the
 * stable pc_* code verbatim.
 */

import { describe, expect, it } from 'bun:test';
import {
  SESSION_TOOL_DEFS,
  getSessionToolDefs,
  getSessionToolNames,
  getToolDefsAsJsonSchema,
  handleProjectContextSearch,
  handleProjectContextRead,
  handleProjectContextSuggest,
  ProjectContextSearchArgsSchema,
  ProjectContextReadArgsSchema,
  ProjectContextSuggestArgsSchema,
  PC_DISTILL_RESULT_MARKER,
  type ProjectContextFacade,
  type SessionToolContext,
} from './index.ts';

function makeCtx(getProjectContext?: () => ProjectContextFacade | null): SessionToolContext {
  return {
    sessionId: 'test-session',
    workspacePath: '/tmp/test-workspace',
    get sourcesPath() { return '/tmp/test-workspace/sources'; },
    get skillsPath() { return '/tmp/test-workspace/skills'; },
    plansFolderPath: '/tmp/test-workspace/plans',
    fs: {
      exists: () => false,
      readFile: () => '',
      readFileBuffer: () => Buffer.alloc(0),
      writeFile: () => {},
      isDirectory: () => false,
      readdir: () => [],
      stat: () => ({ size: 0, isDirectory: () => false }),
    },
    loadSourceConfig: () => null,
    callbacks: {
      onPlanSubmitted: () => {},
      onAuthRequest: () => {},
    },
    ...(getProjectContext ? { getProjectContext } : {}),
  } as SessionToolContext;
}

describe('project_context tool gating (fail closed)', () => {
  it('does not register either tool by default', () => {
    const names = getSessionToolNames();
    expect(names.has('project_context_search')).toBe(false);
    expect(names.has('project_context_read')).toBe(false);
  });

  it('does not register the tools when allowProjectContext is false', () => {
    const names = getSessionToolDefs({ allowProjectContext: false, allowGoalUpdate: true })
      .map(d => d.name);
    expect(names.includes('project_context_search')).toBe(false);
    expect(names.includes('project_context_read')).toBe(false);
  });

  it('registers both tools only when allowProjectContext is true', () => {
    const defs = getSessionToolDefs({ allowProjectContext: true });
    for (const name of ['project_context_search', 'project_context_read']) {
      const def = defs.find(d => d.name === name);
      expect(def).toBeDefined();
      expect(def?.executionMode).toBe('registry');
      expect(def?.safeMode).toBe('allow');
      expect(def?.readOnly).toBe(true);
      expect(def?.handler).toBeDefined();
    }
  });

  it('both tools exist in the canonical registry with metadata', () => {
    for (const name of ['project_context_search', 'project_context_read']) {
      const def = SESSION_TOOL_DEFS.find(d => d.name === name);
      expect(def).toBeDefined();
      expect(def?.executionMode).toBe('registry');
      expect(def?.safeMode).toBe('allow');
      expect(def?.readOnly).toBe(true);
    }
  });

  it('json schema conversion respects the allowProjectContext filter (proxy mirror)', () => {
    const off = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).map(d => d.name);
    expect(off.includes('mcp__session__project_context_search')).toBe(false);
    expect(off.includes('mcp__session__project_context_read')).toBe(false);

    const on = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', allowProjectContext: true }).map(d => d.name);
    expect(on.includes('mcp__session__project_context_search')).toBe(true);
    expect(on.includes('mcp__session__project_context_read')).toBe(true);
  });

  it('search schema bounds the query and limit', () => {
    expect(ProjectContextSearchArgsSchema.safeParse({ query: '' }).success).toBe(false);
    expect(ProjectContextSearchArgsSchema.safeParse({ query: 'x'.repeat(2049) }).success).toBe(false);
    expect(ProjectContextSearchArgsSchema.safeParse({ query: 'ok', limit: 21 }).success).toBe(false);
    expect(ProjectContextSearchArgsSchema.safeParse({ query: 'ok', tag: 't'.repeat(65) }).success).toBe(false);
    // Strict: unknown keys are rejected, not stripped.
    expect(ProjectContextSearchArgsSchema.safeParse({ query: 'ok', extra: 1 }).success).toBe(false);
    expect(ProjectContextSearchArgsSchema.safeParse({ query: 'ok', limit: 5 }).success).toBe(true);
  });

  it('read schema requires a bounded assetId', () => {
    expect(ProjectContextReadArgsSchema.safeParse({}).success).toBe(false);
    expect(ProjectContextReadArgsSchema.safeParse({ assetId: '' }).success).toBe(false);
    expect(ProjectContextReadArgsSchema.safeParse({ assetId: 'a'.repeat(129) }).success).toBe(false);
    expect(ProjectContextReadArgsSchema.safeParse({ assetId: 'asset-1', version: 0 }).success).toBe(false);
    expect(ProjectContextReadArgsSchema.safeParse({ assetId: 'asset-1' }).success).toBe(true);
  });
});

describe('project_context handlers (facade null fails closed)', () => {
  it('search fails closed when the facade is absent', async () => {
    const result = await handleProjectContextSearch(makeCtx(), { query: 'roadmap' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('当前会话不在项目共享范围内');
  });

  it('read fails closed when the facade is absent', async () => {
    const result = await handleProjectContextRead(makeCtx(), { assetId: 'asset-1' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('当前会话不在项目共享范围内');
  });

  it('search fails closed when the factory returns null', async () => {
    const result = await handleProjectContextSearch(makeCtx(() => null), { query: 'roadmap' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('当前会话不在项目共享范围内');
  });

  it('rejects invalid arguments before invoking the facade', async () => {
    let searchCalls = 0;
    const facade: ProjectContextFacade = {
      search: async () => {
        searchCalls += 1;
        return { degraded: false, hits: [] };
      },
      suggest: async () => ({ ok: true as const }),
      read: async () => ({ ok: true, content: '', truncated: false, version: 1 }),
    };
    const result = await handleProjectContextSearch(makeCtx(() => facade), { query: '' });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Invalid project_context_search arguments');
    expect(searchCalls).toBe(0);
  });
});

describe('project_context handlers (facade output formatting)', () => {
  it('search renders name, version, tags, snippet and the assetId/version trail', async () => {
    const facade: ProjectContextFacade = {
      search: async () => ({
        degraded: false,
        hits: [
          {
            assetId: 'asset-42',
            version: 3,
            name: '产品定稿.md',
            tags: [{ id: 'tag-1', label: '结论', preset: false }],
            snippet: '最终方案：采用 B 计划',
            score: 0.87,
          },
        ],
      }),
      suggest: async () => ({ ok: true as const }),
      read: async () => ({ ok: true, content: 'unused', truncated: false, version: 1 }),
    };
    const result = await handleProjectContextSearch(makeCtx(() => facade), { query: '定稿' });
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('产品定稿.md');
    expect(text).toContain('v3');
    expect(text).toContain('结论');
    expect(text).toContain('assetId=asset-42');
    expect(text).toContain('version=3');
    expect(text).not.toContain('索引暂不可达');
  });

  it('search prefixes the degraded notice when the index is unreachable', async () => {
    const facade: ProjectContextFacade = {
      search: async () => ({ degraded: true, hits: [] }),
      suggest: async () => ({ ok: true as const }),
      read: async () => ({ ok: false, error: 'pc_service_unavailable' }),
    };
    const result = await handleProjectContextSearch(makeCtx(() => facade), { query: 'anything' });
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('索引暂不可达，以下按名称与标签匹配');
    expect(text).toContain('没有匹配的项目共享文件');
  });

  it('read returns the content with its version', async () => {
    const facade: ProjectContextFacade = {
      search: async () => ({ degraded: false, hits: [] }),
      suggest: async () => ({ ok: true as const }),
      read: async () => ({ ok: true, content: 'SHARED CONTENT', truncated: false, version: 7 }),
    };
    const result = await handleProjectContextRead(makeCtx(() => facade), { assetId: 'asset-9', version: 7 });
    expect(result.isError).toBe(false);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('asset-9 v7');
    expect(text).toContain('SHARED CONTENT');
  });

  it('read marks truncated content', async () => {
    const facade: ProjectContextFacade = {
      search: async () => ({ degraded: false, hits: [] }),
      suggest: async () => ({ ok: true as const }),
      read: async () => ({ ok: true, content: 'PARTIAL', truncated: true, version: 2 }),
    };
    const result = await handleProjectContextRead(makeCtx(() => facade), { assetId: 'asset-9' });
    expect((result.content[0] as { text: string }).text).toContain('内容已截断');
  });

  it('read relays the stable pc_* error verbatim and never invents content', async () => {
    const facade: ProjectContextFacade = {
      search: async () => ({ degraded: false, hits: [] }),
      suggest: async () => ({ ok: true as const }),
      read: async () => ({ ok: false, error: 'pc_not_found' }),
    };
    const result = await handleProjectContextRead(makeCtx(() => facade), { assetId: 'missing' });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('pc_not_found');
    expect(text).not.toContain('SHARED');
  });
});

describe('project_context_suggest (POO-215 U1 distillation hand-off)', () => {
  const ENTRY = {
    title: '部署 SOP',
    body: '# 部署 SOP\n\n1. 构建\n2. 发布',
    suggestedTags: ['tech'],
  };

  it('registers only with allowProjectContext and is a gated (non-safe, non-readOnly) tool', () => {
    const off = getSessionToolDefs({ allowProjectContext: false }).map(d => d.name);
    expect(off.includes('project_context_suggest')).toBe(false);

    const def = getSessionToolDefs({ allowProjectContext: true }).find(d => d.name === 'project_context_suggest');
    expect(def).toBeDefined();
    expect(def?.executionMode).toBe('registry');
    expect(def?.safeMode).toBe('block');
    expect(def?.readOnly).toBe(false);
    expect(def?.handler).toBeDefined();
    expect(getSessionToolNames().has('project_context_suggest')).toBe(false);
    expect(SESSION_TOOL_DEFS.find(d => d.name === 'project_context_suggest')).toBeDefined();
  });

  it('json schema conversion mirrors the same filter under the session prefix', () => {
    const off = getToolDefsAsJsonSchema({ prefix: 'mcp__session__' }).map(d => d.name);
    expect(off.includes('mcp__session__project_context_suggest')).toBe(false);
    const on = getToolDefsAsJsonSchema({ prefix: 'mcp__session__', allowProjectContext: true }).map(d => d.name);
    expect(on.includes('mcp__session__project_context_suggest')).toBe(true);
  });

  it('suggest schema bounds entries, title/body length and tag count', () => {
    expect(ProjectContextSuggestArgsSchema.safeParse({ entries: [] }).success).toBe(false);
    expect(ProjectContextSuggestArgsSchema.safeParse({
      entries: Array.from({ length: 6 }, () => ENTRY),
    }).success).toBe(false);
    expect(ProjectContextSuggestArgsSchema.safeParse({
      entries: [{ ...ENTRY, title: 'x'.repeat(121) }],
    }).success).toBe(false);
    expect(ProjectContextSuggestArgsSchema.safeParse({
      entries: [{ ...ENTRY, body: 'x'.repeat(20_001) }],
    }).success).toBe(false);
    expect(ProjectContextSuggestArgsSchema.safeParse({
      entries: [{ ...ENTRY, suggestedTags: ['a', 'b', 'c', 'd', 'e'] }],
    }).success).toBe(false);
    // Strict: unknown keys are rejected, not stripped.
    expect(ProjectContextSuggestArgsSchema.safeParse({ entries: [ENTRY], extra: 1 }).success).toBe(false);
    expect(ProjectContextSuggestArgsSchema.safeParse({ entries: [{ ...ENTRY, suggestedTags: undefined }] }).success).toBe(true);
  });

  it('fails closed when the facade is absent', async () => {
    const result = await handleProjectContextSuggest(makeCtx(), { entries: [ENTRY] });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('当前会话不在项目共享范围内');
  });

  it('rejects invalid arguments before invoking the facade', async () => {
    let suggestCalls = 0;
    const facade: ProjectContextFacade = {
      suggest: async () => {
        suggestCalls += 1;
        return { ok: true as const };
      },
      search: async () => ({ degraded: false, hits: [] }),
      read: async () => ({ ok: true, content: '', truncated: false, version: 1 }),
    };
    const result = await handleProjectContextSuggest(makeCtx(() => facade), { entries: [] });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('Invalid project_context_suggest arguments');
    expect(suggestCalls).toBe(0);
  });

  it('relays a not-authorized gate as the explicit suggestion refusal', async () => {
    const facade: ProjectContextFacade = {
      suggest: async () => ({ ok: false as const, error: 'not_authorized' }),
      search: async () => ({ degraded: false, hits: [] }),
      read: async () => ({ ok: true, content: '', truncated: false, version: 1 }),
    };
    const result = await handleProjectContextSuggest(makeCtx(() => facade), { entries: [ENTRY] });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('无法发起沉淀建议');
  });

  it('emits the marker-tagged JSON envelope with numbered suggestions and the user-disposition receipt', async () => {
    const facade: ProjectContextFacade = {
      suggest: async () => ({ ok: true as const }),
      search: async () => ({ degraded: false, hits: [] }),
      read: async () => ({ ok: true, content: '', truncated: false, version: 1 }),
    };
    const result = await handleProjectContextSuggest(makeCtx(() => facade), {
      entries: [ENTRY, { title: '结论记录', body: '## 结论\n采用 B 计划', suggestedTags: [] }],
    });
    expect(result.isError).toBe(false);
    const envelope = JSON.parse((result.content[0] as { text: string }).text) as {
      marker: string
      accepted: number
      message: string
      suggestions: Array<{ id: string; title: string; body: string; suggestedTags: string[] }>
    };
    expect(envelope.marker).toBe(PC_DISTILL_RESULT_MARKER);
    expect(envelope.accepted).toBe(2);
    expect(envelope.message).toContain('2 条沉淀建议');
    expect(envelope.message).toContain('等待用户勾选确认');
    expect(envelope.suggestions.map(s => s.id)).toEqual(['s1', 's2']);
    expect(envelope.suggestions[0]).toEqual({ id: 's1', ...ENTRY });
    expect(envelope.suggestions[1]?.suggestedTags).toEqual([]);
  });

  it('reports a facade rejection without fabricating an envelope', async () => {
    const facade: ProjectContextFacade = {
      suggest: async () => {
        throw new Error('facade exploded');
      },
      search: async () => ({ degraded: false, hits: [] }),
      read: async () => ({ ok: true, content: '', truncated: false, version: 1 }),
    };
    const result = await handleProjectContextSuggest(makeCtx(() => facade), { entries: [ENTRY] });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain('project_context_suggest failed');
    expect((result.content[0] as { text: string }).text).not.toContain(PC_DISTILL_RESULT_MARKER);
  });
});
