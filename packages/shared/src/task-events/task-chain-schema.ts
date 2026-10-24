/**
 * Declarative task chains — Layer 3 of the task pub/sub contract
 *
 * A chain file declares "when step A's session completes, wake step B's
 * session with a prompt" without any code: agents and humans can set up a
 * handoff by writing one YAML file into {workspace}/task-events/chains/.
 * The loader translates each dependency edge into a plain TaskSubscription,
 * so the runtime (Layer 1) stays the only execution engine.
 *
 * Example:
 * ```yaml
 * chain: review-after-implement
 * description: 实现完成后自动进入审查
 * steps:
 *   - id: implement
 *     session: implement-feature-x   # 起点 — 由人或上游触发,不产生订阅
 *   - id: review
 *     after: implement               # implement 完成后唤醒 review 会话
 *     session: review-session
 *     prompt: |
 *       审查 implement 会话的产出,先跑测试再给结论。
 * ```
 *
 * MVP restriction: `after` accepts a single step id. Multi-dependency joins
 * need cross-event join state in the runtime; keep the file contract honest
 * (zod rejects multi-element arrays with a clear message) until that exists.
 */

import { z } from 'zod';
import { parse as parseYamlDocument } from 'yaml';

const STEP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export const taskChainStepSchema = z.object({
  /** Stable step id, referenced by other steps' `after`. */
  id: z.string().regex(STEP_ID_PATTERN, 'step id must match [A-Za-z0-9][A-Za-z0-9_-]*'),
  /** Session this step runs in — name or id, resolved against the workspace. */
  session: z.string().min(1),
  /** Upstream step whose completion triggers this step. Omit for entry steps. */
  after: z.union([z.string().regex(STEP_ID_PATTERN), z.array(z.string().regex(STEP_ID_PATTERN)).min(1).max(1)]).optional(),
  /** Injected into the wake-up message. Defaults to a generic handoff note. */
  prompt: z.string().optional(),
});

export const taskChainFileSchema = z.object({
  /** Chain name — free text, used in wake-up messages and logs. */
  chain: z.string().min(1),
  description: z.string().optional(),
  steps: z.array(taskChainStepSchema).min(1),
});

export type TaskChainStep = z.infer<typeof taskChainStepSchema>;
export type TaskChainFile = z.infer<typeof taskChainFileSchema>;

/** A chain whose session references have been resolved to session ids. */
export interface ResolvedTaskChainStep extends TaskChainStep {
  sessionId: string;
  /** Single upstream step id (normalized from `after`). */
  afterStepId?: string;
}

export interface ResolvedTaskChain {
  chainName: string;
  description?: string;
  /** Source file the chain was loaded from (absolute or workspace-relative). */
  sourceFile: string;
  steps: ResolvedTaskChainStep[];
}

export interface TaskChainParseResult {
  chain?: TaskChainFile;
  errors: string[];
}

/** Parse YAML or JSON text into a chain file. Never throws — returns errors. */
export function parseTaskChain(raw: string, sourceFile: string): TaskChainParseResult {
  let data: unknown;
  if (sourceFile.endsWith('.json')) {
    try {
      data = JSON.parse(raw);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { errors: [`${sourceFile}: invalid JSON — ${msg}`] };
    }
  } else {
    try {
      data = parseYamlDocument(raw);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { errors: [`${sourceFile}: invalid YAML — ${msg}`] };
    }
  }
  return validateTaskChainData(data, sourceFile);
}

function validateTaskChainData(data: unknown, sourceFile: string): TaskChainParseResult {
  const parsed = taskChainFileSchema.safeParse(data);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map(
        (issue) => `${sourceFile}: ${issue.path.join('.') || '<root>'} — ${issue.message}`,
      ),
    };
  }
  return { chain: parsed.data, errors: [] };
}

/**
 * Structural validation beyond schema: `after` references must exist and the
 * dependency graph must be acyclic. Returns an empty array when valid.
 */
export function validateTaskChain(chain: TaskChainFile): string[] {
  const errors: string[] = [];
  const byId = new Map(chain.steps.map((s) => [s.id, s]));
  if (byId.size !== chain.steps.length) errors.push('duplicate step ids are not allowed');

  for (const step of chain.steps) {
    const afters = step.after === undefined ? [] : Array.isArray(step.after) ? step.after : [step.after];
    for (const dep of afters) {
      if (!byId.has(dep)) {
        errors.push(`step "${step.id}" depends on unknown step "${dep}"`);
      }
    }
  }
  if (errors.length) return errors;

  // Cycle detection along single-parent edges.
  for (const step of chain.steps) {
    const seen = new Set<string>([step.id]);
    let cursor: string | undefined = Array.isArray(step.after) ? step.after[0] : step.after;
    while (cursor) {
      if (seen.has(cursor)) {
        errors.push(`step "${step.id}" is part of a dependency cycle at "${cursor}"`);
        break;
      }
      seen.add(cursor);
      const next = byId.get(cursor);
      cursor = next === undefined || next.after === undefined
        ? undefined
        : Array.isArray(next.after) ? next.after[0] : next.after;
    }
  }
  return errors;
}
