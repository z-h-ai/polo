/**
 * Question Request Types + Schema
 *
 * Canonical definition of the `request_user_input` tool protocol:
 * - Zod schema for the model-facing tool arguments (with cross-field rules)
 * - Shared constants used by SessionManager and the renderer
 *
 * Wire-level types (QuestionRequest / QuestionResponse / QuestionResolution)
 * live in @polo-ai/shared/protocol — this module only owns the tool input
 * contract that both Claude and Pi backends validate against.
 */

import { z } from 'zod';

/** Reserved option id the UI auto-fills for free-text "Other" answers. Models must never declare it. */
export const REQUEST_USER_INPUT_OTHER_OPTION_ID = '__other__';

/** Question/option id charset (after trim). */
export const REQUEST_USER_INPUT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Max questions per request (P0: 1–3). */
export const REQUEST_USER_INPUT_MAX_QUESTIONS = 3;
/** Min/max preset options per question (the UI appends "Other" automatically). */
export const REQUEST_USER_INPUT_MIN_OPTIONS = 2;
export const REQUEST_USER_INPUT_MAX_OPTIONS = 4;
/** Max length of the free-text "Other" answer (after trim). */
export const REQUEST_USER_INPUT_MAX_OTHER_TEXT = 2000;

// ============================================================
// Zod Schemas
// ============================================================

const IdSchema = z.string().trim()
  .min(1, 'id must not be empty')
  .max(64, 'id must be at most 64 characters')
  .regex(REQUEST_USER_INPUT_ID_PATTERN, 'id may only contain letters, digits, "_" and "-"');

export const RequestUserInputOptionSchema = z.object({
  id: IdSchema,
  label: z.string().trim().min(1, 'label must not be empty').max(80, 'label must be at most 80 characters'),
  description: z.string().trim().min(1, 'description must not be empty').max(240, 'description must be at most 240 characters'),
  recommended: z.boolean().optional(),
  exclusive: z.boolean().optional(),
});

export const RequestUserInputQuestionSchema = z.object({
  id: IdSchema,
  header: z.string().trim().min(1, 'header must not be empty').max(24, 'header must be at most 24 characters'),
  question: z.string().trim().min(1, 'question must not be empty').max(500, 'question must be at most 500 characters'),
  multiple: z.boolean().optional(),
  options: z.array(RequestUserInputOptionSchema)
    .min(REQUEST_USER_INPUT_MIN_OPTIONS, `each question needs at least ${REQUEST_USER_INPUT_MIN_OPTIONS} options`)
    .max(REQUEST_USER_INPUT_MAX_OPTIONS, `each question allows at most ${REQUEST_USER_INPUT_MAX_OPTIONS} options`),
});

export const RequestUserInputArgsSchema = z.object({
  questions: z.array(RequestUserInputQuestionSchema)
    .min(1, 'at least one question is required')
    .max(REQUEST_USER_INPUT_MAX_QUESTIONS, `at most ${REQUEST_USER_INPUT_MAX_QUESTIONS} questions per request`),
});

/** Inferred tool argument types. */
export type RequestUserInputOptionArgs = z.infer<typeof RequestUserInputOptionSchema>;
export type RequestUserInputQuestionArgs = z.infer<typeof RequestUserInputQuestionSchema>;
export type RequestUserInputArgs = z.infer<typeof RequestUserInputArgsSchema>;

// ============================================================
// Cross-field Validation
// ============================================================

interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Cross-field rules that plain per-field Zod schemas cannot express:
 * - question ids are globally unique within one request
 * - option ids are unique within their question
 * - the reserved `__other__` id is rejected for questions and options
 * - at most one recommended option per question
 * - `exclusive` is only allowed on multi-select questions
 */
export function validateRequestUserInputArgs(args: RequestUserInputArgs): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const questionIds = new Set<string>();

  args.questions.forEach((question, qIndex) => {
    const qPath = `questions[${qIndex}]`;

    if (question.id === REQUEST_USER_INPUT_OTHER_OPTION_ID) {
      issues.push({ path: `${qPath}.id`, message: `"${REQUEST_USER_INPUT_OTHER_OPTION_ID}" is a reserved id` });
    }
    if (questionIds.has(question.id)) {
      issues.push({ path: `${qPath}.id`, message: `duplicate question id "${question.id}"` });
    }
    questionIds.add(question.id);

    const optionIds = new Set<string>();
    let recommendedCount = 0;
    question.options.forEach((option, oIndex) => {
      const oPath = `${qPath}.options[${oIndex}]`;
      if (option.id === REQUEST_USER_INPUT_OTHER_OPTION_ID) {
        issues.push({ path: `${oPath}.id`, message: `"${REQUEST_USER_INPUT_OTHER_OPTION_ID}" is a reserved id — the UI adds "Other" automatically` });
      }
      if (optionIds.has(option.id)) {
        issues.push({ path: `${oPath}.id`, message: `duplicate option id "${option.id}" in question "${question.id}"` });
      }
      optionIds.add(option.id);
      if (option.recommended) recommendedCount++;
      if (option.exclusive && !question.multiple) {
        issues.push({ path: `${oPath}.exclusive`, message: `option "${option.id}" is exclusive but question "${question.id}" is not multi-select` });
      }
    });

    if (recommendedCount > 1) {
      issues.push({ path: qPath, message: `question "${question.id}" marks ${recommendedCount} options as recommended; at most one is allowed` });
    }
  });

  return issues;
}

/** Validate raw tool arguments; returns a discriminated result. */
export function parseRequestUserInputArgs(args: unknown):
  | { ok: true; data: RequestUserInputArgs }
  | { ok: false; error: string } {
  const parsed = RequestUserInputArgsSchema.safeParse(args ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { ok: false, error: first ? `${first.path.map(String).join('.') || 'args'}: ${first.message}` : 'Invalid arguments' };
  }
  const issues = validateRequestUserInputArgs(parsed.data);
  if (issues.length > 0) {
    const first = issues[0];
    return { ok: false, error: first ? `${first.path}: ${first.message}` : 'Invalid arguments' };
  }
  return { ok: true, data: parsed.data };
}
