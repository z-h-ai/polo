/**
 * Browser Fast Decider — the "System One" fast layer for browser operations.
 *
 * Architecture (POO-113, docs/plans/poo113-jev-browser-opt/scheme.md):
 * the session main model plans a SUB-STEP ("点击「登录」"), and this module
 * grounds it into a concrete browser_tool command by asking two fast models
 * in parallel (path A + path B). Cross-model agreement acts as the
 * confidence signal; disagreements degrade to "no auto suggestion".
 *
 * Measured constraints baked into the design (scheme §5/§6):
 * - Fast models are good at GROUNDING but bad at whole-task PLANNING
 *   (40–47% whole-task vs 88–95% with an explicit sub-step). The sub-step
 *   is therefore REQUIRED, never inferred.
 * - The verb menu MUST be generated from the runtime command table
 *   (a missing verb degrades the fast layer systematically — the `upload`
 *   lesson), hence BROWSER_TOOL_ACTION_MENU is imported from the runtime.
 * - GLM-family models occasionally emit Chinese verbs (点击/上传/已完成);
 *   fuseCommand() normalizes them (the "保险丝").
 *
 * P1 scope: suggestions only. This module NEVER executes anything.
 */

import { BROWSER_TOOL_ACTION_MENU } from './browser-tool-runtime.ts';
import { withTimeout } from './llm-tool.ts';
import { getBrowserFastDeciderConfig, getLlmConnections, type BrowserFastDeciderPathConfig } from '../config/storage.ts';
import { getLlmCredentialKey } from '../config/llm-connections.ts';

// ============================================================================
// Public types
// ============================================================================

export interface FastDeciderInput {
  /** Formatted accessibility snapshot text (same format as the `snapshot` command output). */
  snapshotText: string;
  /** Sub-step planned by the main model, e.g. "点击「登录」". Required — see module doc. */
  substep: string;
  /** Previously executed commands (most recent last). Optional in P1. */
  history?: string[];
}

export type FastDeciderPathName = 'A' | 'B';

export interface FastDeciderEndpoint {
  name: FastDeciderPathName;
  /** OpenAI-compatible chat completions base URL (no trailing slash), e.g. https://api.deepseek.com */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** Extra request-body params (e.g. { thinking: { type: 'disabled' } }). Merged over per-model defaults. */
  requestParams?: Record<string, unknown>;
}

export interface FastDeciderPathOutcome {
  name: FastDeciderPathName;
  command: string | null;
  latencyMs: number;
  error?: string;
}

export interface FastDeciderResult {
  /** Normalized suggested command, or null when no reliable suggestion exists. */
  suggestedCommand: string | null;
  agreement: 'both' | 'single-A' | 'single-B' | 'none';
  /** True when the suggested target looks dangerous (save/delete/submit/pay/…). Informational in P1. */
  dangerous: boolean;
  paths: FastDeciderPathOutcome[];
}

export type BrowserFastDeciderFn = (input: FastDeciderInput) => Promise<FastDeciderResult>;

// ============================================================================
// Command normalization / validation (纯函数层, contract-tested)
// ============================================================================

/** Chinese verb fuses measured from GLM-family outputs (~10% of samples). */
const FUSE_PATTERNS: Array<[RegExp, string]> = [
  [/^点击\s*/i, 'click '],
  [/^上传\s*/i, 'upload '],
  [/^已完成$/, 'done'],
  [/^按\s+(\S+?)\s*键$/, 'key $1'],
  [/^输入\s+/i, 'fill '],
];

/** Normalize a raw fast-model output into a canonical command string. */
export function fuseCommand(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  // strip markdown fences / inline-code wrapping the models sometimes add
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '').trim();
  s = s.replace(/^`+/, '').replace(/`+$/, '').trim();
  // multi-line output is not a valid single command — take nothing
  if (s.includes('\n')) return null;
  for (const [pattern, replacement] of FUSE_PATTERNS) {
    if (pattern.test(s)) {
      s = s.replace(pattern, replacement);
      break;
    }
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s || null;
}

/** Verbs the fast layer is allowed to suggest (single source: runtime action menu). */
export const FAST_DECIDER_VERBS: readonly string[] = BROWSER_TOOL_ACTION_MENU.map((entry) =>
  entry.split(' ')[0]?.replace(/:$/, '') ?? '',
).filter((v) => v.length > 0);

export interface ParsedFastCommand {
  verb: string;
  ref: string | null;
}

/** Minimal parse for validation/agreement — full execution stays in the runtime. */
export function parseFastCommand(command: string): ParsedFastCommand | null {
  const parts = command.split(' ');
  const verb = parts[0]?.toLowerCase();
  if (!verb || !FAST_DECIDER_VERBS.includes(verb)) return null;
  const ref = parts[1]?.startsWith('@') ? parts[1]!.toLowerCase() : null;
  return { verb, ref };
}

/** A command is executable when its verb is in the menu and its ref exists in the snapshot. */
export function isExecutableCommand(command: string, snapshotText: string): boolean {
  const parsed = parseFastCommand(command);
  if (!parsed) return false;
  if (parsed.ref) {
    const refRe = new RegExp(`^\\s*${parsed.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\[`, 'm');
    if (!refRe.test(snapshotText)) return false;
  }
  return true;
}

/**
 * Dangerous-action detection (P2 policy input, informational in P1).
 * Default categories from the v2 retest blacklist; configurable upstream
 * via the managed config (P2). Matches the CLICK TARGET's element name,
 * or any navigate URL.
 */
export const DEFAULT_DANGEROUS_PATTERN = new RegExp(
  [
    '\\b(save|saved|delete|remove|submit|confirm|pay|payment|checkout|purchase|buy\\s+now|place\\s+order|book\\s+now|sign\\s+out|log\\s+out|send|transfer)\\b',
    '(保存|删除|移除|提交|确认|支付|付款|结算|购买|下单|预订|退出登录|发送|转账|注销)',
  ].join('|'),
  'i',
);

export function isDangerousCommand(command: string, snapshotText: string): boolean {
  const parsed = parseFastCommand(command);
  if (!parsed) return false;
  if (parsed.verb === 'navigate') return true;
  if (parsed.verb !== 'click' || !parsed.ref) return false;
  const lineRe = new RegExp(`^\\s*${parsed.ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\[[^\\]]*\\]\\s+"([^"]*)"`, 'm');
  const match = lineRe.exec(snapshotText);
  if (!match) return false;
  return DEFAULT_DANGEROUS_PATTERN.test(match[1]!);
}

// ============================================================================
// Prompt (menu generated from the runtime action table — hard constraint #1)
// ============================================================================

export function buildFastDeciderSystemPrompt(): string {
  return [
    '你是浏览器自动化系统中的快速决策器。根据页面快照与主模型规划的子步骤，输出定位该子步骤的动作命令。',
    '',
    '规则：',
    '- 只输出一条命令，禁止解释、禁止多行、禁止 markdown。',
    `- 命令格式（动词枚举固定）：${BROWSER_TOOL_ACTION_MENU.join(' | ')}`,
    '- @eN 必须来自快照实际存在的引用。',
    '- 子步骤目标不在快照中 → 输出 scroll down|up 像素 探索，或 fail: 原因。',
    '- 动词必须使用上面的英文枚举，不要用中文动词。',
  ].join('\n');
}

export function buildFastDeciderUserPrompt(input: FastDeciderInput): string {
  return [
    '## 页面快照',
    input.snapshotText,
    '',
    '## 主模型规划的当前子步骤',
    input.substep,
    '',
    input.history?.length ? `## 已执行动作\n${input.history.join('；')}\n` : '',
    '## 下一步命令',
  ].join('\n');
}

// ============================================================================
// Path invocation (OpenAI-compatible chat completions)
// ============================================================================

/** Per-model default body params (admin config can override via requestParams). */
function defaultRequestParams(model: string): Record<string, unknown> {
  if (model.includes('deepseek')) return { thinking: { type: 'disabled' } };
  if (model.includes('glm')) return { reasoning_effort: 'low' };
  return {};
}

export type FetchLike = typeof fetch;

export interface CallPathOptions {
  timeoutMs: number;
  fetchImpl?: FetchLike;
  maxTokens?: number;
}

/** Query a single fast path. Never throws — failures come back as `error`. */
export async function callFastPath(
  endpoint: FastDeciderEndpoint,
  input: FastDeciderInput,
  options: CallPathOptions,
): Promise<FastDeciderPathOutcome> {
  const started = Date.now();
  const doFetch = options.fetchImpl ?? fetch;
  const body = {
    model: endpoint.model,
    messages: [
      { role: 'system', content: buildFastDeciderSystemPrompt() },
      { role: 'user', content: buildFastDeciderUserPrompt(input) },
    ],
    temperature: 0.2,
    max_tokens: options.maxTokens ?? 256,
    ...defaultRequestParams(endpoint.model),
    ...endpoint.requestParams,
  };

  const attempt = async (): Promise<string | null> => {
    const resp = await doFetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (resp.status === 429) throw new Error('rate-limited');
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  };

  try {
    let content: string | null = null;
    for (let i = 0; i < 2; i++) {
      try {
        content = await withTimeout(attempt(), options.timeoutMs, `fast path ${endpoint.name} timeout`);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'rate-limited' && i === 0) {
          await new Promise((r) => setTimeout(r, 800));
          continue;
        }
        throw e;
      }
    }
    return {
      name: endpoint.name,
      command: content,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return {
      name: endpoint.name,
      command: null,
      latencyMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function commandsMatch(a: string, b: string): boolean {
  const pa = parseFastCommand(a);
  const pb = parseFastCommand(b);
  if (!pa || !pb) return a === b; // exact fallback for fail:/done
  if (pa.verb !== pb.verb || pa.ref !== pb.ref) return false;
  // for value-bearing verbs compare the value case-insensitively
  if (['fill', 'select', 'upload', 'navigate'].includes(pa.verb)) {
    return a.toLowerCase().replace(/\s+/g, ' ') === b.toLowerCase().replace(/\s+/g, ' ');
  }
  return true;
}

/** Core decision: two paths in parallel → agreement gate → validation. */
export async function decideFastAction(
  input: FastDeciderInput,
  endpoints: FastDeciderEndpoint[],
  options: CallPathOptions,
): Promise<FastDeciderResult> {
  const outcomes = await Promise.all(endpoints.map((e) => callFastPath(e, input, options)));

  const validated = outcomes.map((o) => {
    const fused = fuseCommand(o.command);
    const executable = fused !== null && isExecutableCommand(fused, input.snapshotText);
    return { outcome: o, command: executable ? fused : null };
  });

  const a = validated.find((v) => v.outcome.name === 'A')?.command ?? null;
  const b = validated.find((v) => v.outcome.name === 'B')?.command ?? null;

  let agreement: FastDeciderResult['agreement'] = 'none';
  let suggestedCommand: string | null = null;
  if (a && b && commandsMatch(a, b)) {
    agreement = 'both';
    suggestedCommand = a;
  } else if (a) {
    agreement = 'single-A';
    suggestedCommand = a;
  } else if (b) {
    agreement = 'single-B';
    suggestedCommand = b;
  }

  return {
    suggestedCommand,
    agreement,
    dangerous: suggestedCommand !== null && isDangerousCommand(suggestedCommand, input.snapshotText),
    paths: outcomes,
  };
}

// ============================================================================
// Factory wiring (managed config → endpoints → decider fn)
// ============================================================================

/**
 * Build endpoints from the managed fast-decider config + existing LLM
 * connections (credentials resolved through the credential store — the
 * same channel the main model uses; no plaintext keys live in settings).
 */
export async function resolveBrowserFastDeciderEndpoints(
  pathConfigs: BrowserFastDeciderPathConfig[],
  deps: {
    getConnections?: () => ReturnType<typeof getLlmConnections>;
    getApiKey: (credentialKey: string) => Promise<string | null>;
  },
): Promise<FastDeciderEndpoint[]> {
  const connections = (deps.getConnections?.() ?? getLlmConnections()) ?? [];
  const endpoints: FastDeciderEndpoint[] = [];
  for (const cfg of pathConfigs) {
    const conn = connections.find((c) => c.slug === cfg.connectionSlug);
    if (!conn?.baseUrl) continue;
    const apiKey = await deps.getApiKey(getLlmCredentialKey(conn.slug, 'api_key'));
    if (!apiKey) continue;
    endpoints.push({
      name: cfg.name,
      baseUrl: conn.baseUrl.replace(/\/+$/, ''),
      model: cfg.model,
      apiKey,
      requestParams: cfg.requestParams,
    });
  }
  return endpoints;
}

/**
 * Session-facing decider built from the managed config. Returns a
 * "not configured" result (null suggestion) when no endpoint resolves —
 * callers degrade gracefully and never block on the fast layer.
 */
export function createBrowserFastDecider(
  deps: {
    getConfig?: () => ReturnType<typeof getBrowserFastDeciderConfig>;
    resolveApiKey: (credentialKey: string) => Promise<string | null>;
    fetchImpl?: FetchLike;
  },
): BrowserFastDeciderFn {
  return async (input) => {
    const config = deps.getConfig?.() ?? getBrowserFastDeciderConfig();
    if (!config?.enabled) {
      return { suggestedCommand: null, agreement: 'none', dangerous: false, paths: [] };
    }
    const endpoints = await resolveBrowserFastDeciderEndpoints(config.paths ?? [], {
      getApiKey: deps.resolveApiKey,
    });
    if (endpoints.length === 0) {
      return { suggestedCommand: null, agreement: 'none', dangerous: false, paths: [] };
    }
    return decideFastAction(input, endpoints, {
      timeoutMs: config.timeoutMs ?? 3000,
      fetchImpl: deps.fetchImpl,
    });
  };
}
