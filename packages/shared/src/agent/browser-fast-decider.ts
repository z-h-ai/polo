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
import { getBrowserFastDeciderConfig } from '../config/storage.ts';
import { getLlmCredentialKey, type LlmConnection } from '../config/llm-connections.ts';
import { startInvocationCredentialProxy } from '../credentials/invocation-credential-proxy.ts';
import type { ManagedBillingHooks } from '../credentials/managed-billing-observation.ts';

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
  model?: string;
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
  // Preserve argument bytes (passwords, paths, URLs and fill values).
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
  if (['click', 'fill', 'select', 'upload'].includes(parsed.verb) && !parsed.ref) return false;
  if (parsed.ref && !/^@e\d+$/.test(parsed.ref)) return false;
  if (parsed.verb === 'click' && !/^click @e\d+$/.test(command)) return false;
  if (['fill', 'select', 'upload'].includes(parsed.verb) && !/^\w+ @e\d+ .+$/.test(command)) return false;
  if (parsed.verb === 'key' && !/^key \S+$/.test(command)) return false;
  if (parsed.verb === 'scroll' && !/^scroll (up|down|left|right) [1-9]\d*$/.test(command)) return false;
  if (parsed.verb === 'navigate' && !/^navigate https?:\/\/\S+$/.test(command)) return false;
  if (parsed.verb === 'done' && command !== 'done') return false;
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
  /** Model HTTP/retry deadline; durable billing cleanup may outlive it. */
  timeoutMs: number;
  signal?: AbortSignal;
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
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
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
    controller.signal.throwIfAborted();
    const resp = await doFetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
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
        const remaining = options.timeoutMs - (Date.now() - started);
        if (remaining <= 0) throw new Error(`fast path ${endpoint.name} timeout`);
        content = await withTimeout(attempt(), remaining, `fast path ${endpoint.name} timeout`);
        break;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'rate-limited' && i === 0 && options.timeoutMs - (Date.now() - started) > 800) {
          await new Promise<void>((resolve, reject) => {
            const abort = () => { clearTimeout(delay); reject(new Error('Fast request cancelled')); };
            const delay = setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 800);
            controller.signal.addEventListener('abort', abort, { once: true });
            if (controller.signal.aborted) abort();
          });
          continue;
        }
        throw e;
      }
    }
    return {
      name: endpoint.name,
      model: endpoint.model,
      command: content,
      latencyMs: Date.now() - started,
    };
  } catch (e) {
    return {
      name: endpoint.name,
      model: endpoint.model,
      command: null,
      latencyMs: Date.now() - started,
      error: options.signal?.aborted ? `fast path ${endpoint.name} cancelled`
        : controller.signal.aborted ? `fast path ${endpoint.name} timeout` : e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}

function commandsMatch(a: string, b: string): boolean {
  return a === b;
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
  } else if (a && !b) {
    agreement = 'single-A';
    suggestedCommand = a;
  } else if (b && !a) {
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

/** Default grounding models; availability is authorized by the current Admin catalog. */
export const BROWSER_FAST_MODELS = [
  { name: 'A', model: 'deepseek-flash' },
  { name: 'B', model: 'glm-5.3-flash' },
] as const;

export interface ManagedBrowserTransport {
  connection: LlmConnection;
  /** Current turn lifetime, including user stop and runtime disposal. */
  signal?: AbortSignal;
  billing?: ManagedBillingHooks;
  /** Only the SessionManager's verified desktop lease may set this. */
  billingOwnedByDesktopProxy?: boolean;
  assertCurrent(): void;
}

/**
 * Use the SAME invocation credential proxy and billing hooks as the main Pi
 * model. Local settings may disable/limit the helper, never select a provider,
 * key or ProductSpace. Each HTTP attempt (including a 429 retry) is metered.
 */
export function createBrowserFastDecider(deps: {
  resolveTransport: () => Promise<ManagedBrowserTransport>;
  resolveApiKey: (credentialKey: string) => Promise<string | null>;
  getConfig?: () => ReturnType<typeof getBrowserFastDeciderConfig>;
}): BrowserFastDeciderFn & { dispose(): Promise<void> } {
  const pending = new Set<Promise<FastDeciderResult>>();
  const controllers = new Set<AbortController>();
  let disposed = false;
  const unavailable = (): FastDeciderResult => ({ suggestedCommand: null, agreement: 'none', dangerous: false,
    paths: BROWSER_FAST_MODELS.map(p => ({ ...p, command: null, latencyMs: 0, error: 'Managed Polo transport unavailable, cancelled or timed out' })) });
  const decider: BrowserFastDeciderFn = async (input) => {
    const config = deps.getConfig?.() ?? getBrowserFastDeciderConfig();
    if (config?.enabled === false) {
      return { suggestedCommand: null, agreement: 'none', dangerous: false, paths: [] };
    }
    if (disposed) return unavailable();
    const requestedTimeout = config?.timeoutMs ?? 3000;
    const timeoutMs = Number.isFinite(requestedTimeout) ? Math.min(30000, Math.max(1000, requestedTimeout)) : 3000;
    const controller = new AbortController();
    controllers.add(controller);
    const cancel = () => controller.abort();
    const cancelled = new Promise<FastDeciderResult>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(unavailable()), { once: true });
    });
    const timer = setTimeout(cancel, timeoutMs);
    // Keep the original work owned until admission/receipt cleanup completes.
    // Returning the deadline result must never discard a billing journal.
    const work = (async (): Promise<FastDeciderResult> => {
      let proxy: Awaited<ReturnType<typeof startInvocationCredentialProxy>> | undefined;
      let turnSignal: AbortSignal | undefined;
      try {
        const transport = await deps.resolveTransport();
        const { connection, billing, billingOwnedByDesktopProxy, assertCurrent: assertScopeCurrent, signal } = transport;
        turnSignal = signal;
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
        const assertCurrent = () => { controller.signal.throwIfAborted(); assertScopeCurrent(); };
        assertCurrent();
        if (connection.managedBy !== 'admin' || !connection.baseUrl
          || !['pi', 'pi_compat'].includes(connection.providerType)
          || connection.customEndpoint?.api !== 'openai-completions'
          || (!billing && !billingOwnedByDesktopProxy)) {
          throw new Error('Managed Polo billing transport is unavailable');
        }
        const allowed = new Set(connection.models?.map(m => typeof m === 'string' ? m : m.id));
        // A partial catalog is reported per path, never redirected to another
        // connection or silently substituted with the session's main model.
        const available = BROWSER_FAST_MODELS.filter(p => allowed.has(p.model));
        const missing: FastDeciderPathOutcome[] = BROWSER_FAST_MODELS.filter(p => !allowed.has(p.model))
          .map(p => ({ ...p, command: null, latencyMs: 0, error: 'Model is not in the current Admin catalog' }));
        if (!available.length) return { suggestedCommand: null, agreement: 'none', dangerous: false, paths: missing };
        const apiKey = await deps.resolveApiKey(getLlmCredentialKey(connection.slug, 'api_key'));
        assertCurrent();
        if (!apiKey) throw new Error('Managed Polo credential is unavailable');
        let baseUrl: string, capability: string;
        if (billingOwnedByDesktopProxy) {
          const url = new URL(connection.baseUrl);
          if (billing || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
            || url.pathname !== '/v1' || url.username || url.password || url.search || url.hash) {
            throw new Error('Invalid verified desktop proxy');
          }
          // The verified desktop proxy already owns admission and settlement.
          baseUrl = connection.baseUrl;
          capability = apiKey;
        } else {
          proxy = await startInvocationCredentialProxy({
            upstreamBaseUrl: connection.baseUrl,
            credential: apiKey,
            credentialHeaders: [{ name: 'authorization', format: 'bearer' }],
          }, { billing, assertExecutionCurrent: assertCurrent, managedPolicy: { allowedModels: available.map(p => p.model) } });
          baseUrl = `${proxy.url}/v1`;
          capability = proxy.capability;
        }
        assertCurrent();
        const result = await decideFastAction(input, available.map(p => ({
          ...p, baseUrl, apiKey: capability,
        })), { timeoutMs, signal: controller.signal });
        signal?.throwIfAborted();
        assertCurrent();
        return { ...result, paths: [...result.paths, ...missing].sort((a, b) => a.name.localeCompare(b.name)) };
      } catch {
        // Never expose provider credentials, endpoint query strings or raw
        // upstream exceptions to the model's browser-tool transcript.
        return unavailable();
      } finally {
        try { await proxy?.close(); }
        finally { turnSignal?.removeEventListener('abort', cancel); controllers.delete(controller); }
      }
    })();
    pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    try { return await Promise.race([work, cancelled]); }
    catch { return unavailable(); }
    finally { clearTimeout(timer); }
  };
  return Object.assign(decider, { async dispose() {
    disposed = true;
    for (const controller of controllers) controller.abort();
    await Promise.all([...pending]);
  } });
}
