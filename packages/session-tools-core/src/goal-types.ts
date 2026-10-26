/**
 * Goal Update Types + Schema (POO-134)
 *
 * Canonical definition of the `goal_update` tool protocol:
 * - Zod schema for the model-facing tool arguments (with cross-field rules)
 * - The wire format of the report the handler emits, and the strict parser the
 *   server re-validates with (fail-closed — a Goal state change is only ever
 *   applied from a report this module produced and parsed successfully).
 *
 * This package owns the tool input contract; @polo-ai/shared/protocol owns the
 * authoritative GoalRecord/projection types. No dependency inversion: the
 * server imports THIS module to parse reports, never the reverse.
 */

import { z } from 'zod';

export const GOAL_UPDATE_TOOL_NAME = 'goal_update';

/** Marker that prefixes the canonical JSON report inside the tool_result text. */
export const GOAL_UPDATE_REPORT_MARKER = 'GOAL_UPDATE_REPORT';

/** Bounded report sizes (defence against runaway model output). */
export const GOAL_UPDATE_MAX_TODOS = 50;
export const GOAL_UPDATE_MAX_CRITERIA = 12;
export const GOAL_UPDATE_MAX_EVIDENCE = 24;
export const GOAL_UPDATE_MAX_CLARIFICATION_OPTIONS = 6;

export const GoalTodoStatusSchema = z.enum(['pending', 'in_progress', 'completed']);

const GOAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export const GoalUpdateTodoSchema = z.object({
  /** STABLE across reports: a later report must reuse the id of the same item. */
  id: z.string().trim()
    .min(1, 'id must not be empty')
    .max(64, 'id must be at most 64 characters')
    .regex(GOAL_ID_PATTERN, 'id may only contain letters, digits, "_" and "-"'),
  label: z.string().trim().min(1, 'label must not be empty').max(200, 'label must be at most 200 characters'),
  status: GoalTodoStatusSchema,
});

export const GoalUpdateEvidenceSchema = z.object({
  kind: z.enum(['file', 'message']),
  /** Relative (preferred) or absolute path of a real artifact for `file`. */
  path: z.string().trim().min(1, 'path must not be empty').max(1024).optional(),
  /** Persisted assistant message id of THIS session for `message`. */
  messageId: z.string().trim().min(1, 'messageId must not be empty').max(128).optional(),
  /** Untrusted free-text note; display only. */
  note: z.string().trim().max(500).optional(),
});

export const GoalUpdateClarificationSchema = z.object({
  question: z.string().trim().min(1, 'question must not be empty').max(1000, 'question must be at most 1000 characters'),
  /** Optional concrete choices shown to the user alongside the question. */
  options: z.array(z.string().trim().min(1).max(200)).max(GOAL_UPDATE_MAX_CLARIFICATION_OPTIONS).optional(),
  /** A concrete delivery suggestion the user may simply accept. */
  suggestion: z.string().trim().min(1).max(1000).optional(),
});

export const GoalUpdateCandidateSchema = z.object({
  summary: z.string().trim().min(1, 'summary must not be empty').max(4000, 'summary must be at most 4000 characters'),
  evidence: z.array(GoalUpdateEvidenceSchema)
    .min(1, 'a candidate needs at least one piece of evidence')
    .max(GOAL_UPDATE_MAX_EVIDENCE, `a candidate allows at most ${GOAL_UPDATE_MAX_EVIDENCE} evidence items`),
});

export const GoalUpdateArgsSchema = z.object({
  kind: z.enum(['progress', 'clarification', 'candidate']),
  /** Short narration of what advanced since the last report. */
  note: z.string().trim().max(2000).optional(),
  /** Agent todo list snapshot (read-only projection on the client). */
  todos: z.array(GoalUpdateTodoSchema).max(GOAL_UPDATE_MAX_TODOS).optional(),
  /** Refined completion requirements (additive refinement of the Goal's criteria). */
  criteria: z.array(z.string().trim().min(1, 'criterion must not be empty').max(300))
    .min(1, 'criteria must not be empty when provided')
    .max(GOAL_UPDATE_MAX_CRITERIA).optional(),
  clarification: GoalUpdateClarificationSchema.optional(),
  candidate: GoalUpdateCandidateSchema.optional(),
});

export type GoalUpdateTodo = z.infer<typeof GoalUpdateTodoSchema>;
export type GoalUpdateEvidence = z.infer<typeof GoalUpdateEvidenceSchema>;
export type GoalUpdateClarification = z.infer<typeof GoalUpdateClarificationSchema>;
export type GoalUpdateCandidate = z.infer<typeof GoalUpdateCandidateSchema>;
export type GoalUpdateReport = z.infer<typeof GoalUpdateArgsSchema>;

// ============================================================
// Cross-field Validation
// ============================================================

/**
 * Validate the cross-field rules the schema cannot express per-field:
 * - `clarification` only travels with kind 'clarification' (and vice versa)
 * - `candidate` only travels with kind 'candidate' (and vice versa)
 */
export function validateGoalUpdateCrossFields(report: GoalUpdateReport): string | null {
  if (report.kind === 'clarification' && !report.clarification) {
    return "kind 'clarification' requires a clarification object";
  }
  if (report.kind !== 'clarification' && report.clarification) {
    return 'clarification is only allowed with kind clarification';
  }
  if (report.kind === 'candidate' && !report.candidate) {
    return "kind 'candidate' requires a candidate object";
  }
  if (report.kind !== 'candidate' && report.candidate) {
    return 'candidate is only allowed with kind candidate';
  }
  return null;
}

/** Parse + fully validate model-supplied goal_update arguments. */
export function parseGoalUpdateArgs(
  args: unknown,
): { ok: true; data: GoalUpdateReport } | { ok: false; error: string } {
  const parsed = GoalUpdateArgsSchema.safeParse(args);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, error: `${path}${issue?.message ?? 'invalid arguments'}` };
  }
  const cross = validateGoalUpdateCrossFields(parsed.data);
  if (cross) return { ok: false, error: cross };
  return { ok: true, data: parsed.data };
}

// ============================================================
// Wire format (tool_result text ⇄ server)
// ============================================================

/**
 * Serialize a validated report into the canonical tool_result payload. The
 * marker + JSON line is the ONLY channel the server accepts a Goal report on:
 * it appears in the SUCCESS tool_result of a goal_update tool call matched to
 * a same-turn tool_start, and is re-parsed strictly on the server side.
 */
export function serializeGoalUpdateReport(report: GoalUpdateReport): string {
  return `${GOAL_UPDATE_REPORT_MARKER} ${JSON.stringify(report)}`;
}

/**
 * Normalize a tool_result payload into the bare text the strict parser scans.
 *
 * The REAL production wire (observed in the first authorized real-model run)
 * is the JSON string of MCP text CONTENT BLOCKS — the marker and its JSON live
 * ESCAPED inside the block text. Bare marker text stays supported as the
 * historical shape. A bracket-shaped input must be a well-formed array of
 * text-only content blocks; anything else in that shape is ambiguous and fails
 * CLOSED (null) rather than being scanned for an escaped marker it cannot
 * parse reliably.
 */
function normalizeWireText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const parts: string[] = [];
  for (const block of parsed) {
    if (typeof block !== 'object' || block === null) return null;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== 'text' || typeof record.text !== 'string') return null;
    parts.push(record.text);
  }
  return parts.join('\n');
}

/**
 * Strictly parse the canonical report payload out of a tool_result text.
 * Accepts the real MCP content-block wire, the historical bare marker text,
 * and nothing else — the server never guesses a Goal state change from prose.
 */
export function parseGoalUpdateReportPayload(
  text: string | undefined | null,
): GoalUpdateReport | null {
  if (!text) return null;
  const normalized = normalizeWireText(text);
  if (normalized === null) return null;
  const index = normalized.indexOf(GOAL_UPDATE_REPORT_MARKER);
  if (index < 0) return null;
  const jsonStart = normalized.indexOf('{', index + GOAL_UPDATE_REPORT_MARKER.length);
  if (jsonStart < 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized.slice(jsonStart));
  } catch {
    return null;
  }
  const validated = parseGoalUpdateArgs(parsed);
  return validated.ok ? validated.data : null;
}
