/**
 * Contract tests for the browser fast decider (POO-113 P1).
 *
 * Covers the five hard constraints from the accepted plan:
 *  1. verb menu generated from BROWSER_TOOL_ACTION_MENU (single source)
 *  2. substep is required by the prompt contract
 *  3. fuse normalization + isExecutable validation
 *  4. per-path timeout / failure degrades, never throws
 *  5. suggestions only — decideFastAction returns text, executes nothing
 * Plus dangerous-action detection and the agreement gate.
 */

import { describe, it, expect } from 'bun:test';
import {
  BROWSER_TOOL_ACTION_MENU,
} from '../browser-tool-runtime.ts';
import {
  fuseCommand,
  parseFastCommand,
  isExecutableCommand,
  isDangerousCommand,
  FAST_DECIDER_VERBS,
  buildFastDeciderSystemPrompt,
  buildFastDeciderUserPrompt,
  decideFastAction,
  resolveBrowserFastDeciderEndpoints,
  type FastDeciderEndpoint,
  type FastDeciderInput,
} from '../browser-fast-decider.ts';

const SNAP = [
  'URL: https://app.example.com/settings',
  'Title: Settings',
  'Elements (3):',
  '  @e1 [textbox] "Email"',
  '  @e4 [button] "Save changes"',
  '  @e5 [link] "Cancel"',
].join('\n');

const INPUT: FastDeciderInput = { snapshotText: SNAP, substep: '点击「Save changes」按钮' };

function endpoint(name: 'A' | 'B', model = 'deepseek-flash'): FastDeciderEndpoint {
  return { name, baseUrl: 'https://api.example.com', model, apiKey: 'k' };
}

function fetchReplying(contentPerModel: Record<string, string>): typeof fetch {
  return (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string };
    const content = contentPerModel[body.model] ?? 'click @e5';
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

// ============================================================================
// Constraint 1 — menu single source
// ============================================================================

describe('browser fast decider contract', () => {
  it('action menu covers the verbs the runtime help documents (upload lesson)', () => {
    const menu = BROWSER_TOOL_ACTION_MENU.join(' ');
    for (const verb of ['click', 'fill', 'select', 'upload', 'scroll', 'key', 'navigate', 'done', 'fail']) {
      expect(menu).toContain(verb);
    }
  });

  it('FAST_DECIDER_VERBS derives from the action menu', () => {
    expect(FAST_DECIDER_VERBS).toContain('click');
    expect(FAST_DECIDER_VERBS).toContain('upload');
    expect(FAST_DECIDER_VERBS).not.toContain('drag'); // menu-only verbs, not full runtime surface
  });

  it('system prompt embeds the generated menu (constraint 1)', () => {
    const prompt = buildFastDeciderSystemPrompt();
    for (const entry of BROWSER_TOOL_ACTION_MENU) {
      expect(prompt).toContain(entry);
    }
  });

  // ==========================================================================
  // Constraint 2 — substep required
  // ==========================================================================

  it('user prompt carries the substep, never plans alone (constraint 2)', () => {
    const prompt = buildFastDeciderUserPrompt(INPUT);
    expect(prompt).toContain(INPUT.substep);
    expect(prompt).toContain('主模型规划的当前子步骤');
  });

  // ==========================================================================
  // Constraint 3 — fuse + isExecutable
  // ==========================================================================

  it('fuses Chinese verbs measured from GLM-family outputs', () => {
    expect(fuseCommand('点击 @e4')).toBe('click @e4');
    expect(fuseCommand('上传 @e3 /tmp/a.pdf')).toBe('upload @e3 /tmp/a.pdf');
    expect(fuseCommand('已完成')).toBe('done');
    expect(fuseCommand('按 Enter 键')).toBe('key Enter');
    expect(fuseCommand('`click @e4`')).toBe('click @e4');
  });

  it('rejects multi-line and empty output', () => {
    expect(fuseCommand('fill @e2 报告\n设置 file-input @e3')).toBeNull();
    expect(fuseCommand('   ')).toBeNull();
    expect(fuseCommand(null)).toBeNull();
  });

  it('isExecutable requires a menu verb and a ref present in the snapshot', () => {
    expect(isExecutableCommand('click @e4', SNAP)).toBeTrue();
    expect(isExecutableCommand('click @e99', SNAP)).toBeFalse(); // ref not in snapshot
    expect(isExecutableCommand('hover @e4', SNAP)).toBeFalse();  // verb not in menu
    expect(isExecutableCommand('done', SNAP)).toBeTrue();
  });

  it('parseFastCommand extracts verb and ref', () => {
    expect(parseFastCommand('fill @e1 test@example.com')).toEqual({ verb: 'fill', ref: '@e1' });
    expect(parseFastCommand('done')).toEqual({ verb: 'done', ref: null });
  });

  it('flags dangerous click targets by element name (default blacklist)', () => {
    expect(isDangerousCommand('click @e4', SNAP)).toBeTrue();   // "Save changes"
    expect(isDangerousCommand('click @e5', SNAP)).toBeFalse();  // "Cancel"
    expect(isDangerousCommand('fill @e1 x', SNAP)).toBeFalse(); // non-click
    expect(isDangerousCommand('navigate https://x.com', SNAP)).toBeTrue();
  });

  // ==========================================================================
  // Constraints 4+5 — decideFastAction: agreement gate, degradation, no execution
  // ==========================================================================

  it('both paths agree → suggestedCommand with agreement=both', async () => {
    const result = await decideFastAction(INPUT,
      [endpoint('A'), { ...endpoint('B'), model: 'glm-5.3-flashx' }],
      { timeoutMs: 2000, fetchImpl: fetchReplying({ 'deepseek-flash': 'click @e4', 'glm-5.3-flashx': '点击 @e4' }) });
    expect(result.suggestedCommand).toBe('click @e4');
    expect(result.agreement).toBe('both');
    expect(result.paths).toHaveLength(2);
    expect(result.paths.every((p) => p.error === undefined)).toBeTrue();
  });

  it('paths disagree → agreement degrades to single-A and marks the answer', async () => {
    const result = await decideFastAction(INPUT,
      [endpoint('A'), { ...endpoint('B'), model: 'glm-5.3-flashx' }],
      { timeoutMs: 2000, fetchImpl: fetchReplying({ 'deepseek-flash': 'click @e4', 'glm-5.3-flashx': 'click @e5' }) });
    expect(result.agreement).toBe('single-A');
    expect(result.suggestedCommand).toBe('click @e4');
  });

  it('invalid ref from one path counts as that path failing (constraint 3 in the gate)', async () => {
    const result = await decideFastAction(INPUT,
      [endpoint('A'), { ...endpoint('B'), model: 'glm-5.3-flashx' }],
      { timeoutMs: 2000, fetchImpl: fetchReplying({ 'deepseek-flash': 'click @e4', 'glm-5.3-flashx': 'click @e77' }) });
    expect(result.agreement).toBe('single-A');
    expect(result.suggestedCommand).toBe('click @e4');
  });

  it('path failure (http error) degrades instead of throwing (constraint 4)', async () => {
    const failing: typeof fetch = (async () =>
      new Response('{"error":"boom"}', { status: 500 })) as unknown as typeof fetch;
    const result = await decideFastAction(INPUT,
      [endpoint('A'), endpoint('B')],
      { timeoutMs: 2000, fetchImpl: failing });
    expect(result.suggestedCommand).toBeNull();
    expect(result.agreement).toBe('none');
    expect(result.paths.every((p) => p.error)).toBeTrue();
  });

  it('rate-limited path retries once then succeeds', async () => {
    let calls = 0;
    const flaky: typeof fetch = (async () => {
      calls += 1;
      if (calls === 1) return new Response('rate', { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'click @e4' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const result = await decideFastAction(INPUT, [endpoint('A')], { timeoutMs: 2000, fetchImpl: flaky });
    expect(result.suggestedCommand).toBe('click @e4');
    expect(calls).toBe(2);
  });

  it('dangerous agreed suggestion is flagged (informational in P1)', async () => {
    const result = await decideFastAction(INPUT,
      [endpoint('A'), { ...endpoint('B'), model: 'glm-5.3-flashx' }],
      { timeoutMs: 2000, fetchImpl: fetchReplying({ 'deepseek-flash': 'click @e4', 'glm-5.3-flashx': 'click @e4' }) });
    expect(result.suggestedCommand).toBe('click @e4');
    expect(result.dangerous).toBeTrue();
  });

  // ==========================================================================
  // Endpoint resolution (managed config → connections → credentials)
  // ==========================================================================

  it('resolveBrowserFastDeciderEndpoints maps config paths through connections + credentials', async () => {
    const endpoints = await resolveBrowserFastDeciderEndpoints(
      [
        { name: 'A', connectionSlug: 'deepseek-main', model: 'deepseek-flash' },
        { name: 'B', connectionSlug: 'missing-slug', model: 'glm-5.3-flashx' },
      ],
      {
        getConnections: () => [
          { slug: 'deepseek-main', baseUrl: 'https://api.deepseek.com/v1/' },
        ] as never,
        getApiKey: async (key) => (key.includes('deepseek-main') ? 'sk-test' : null),
      },
    );
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]!.baseUrl).toBe('https://api.deepseek.com/v1'); // trailing slash stripped
    expect(endpoints[0]!.apiKey).toBe('sk-test');
  });
});
