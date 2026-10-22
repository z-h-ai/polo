/**
 * Render UI Handler
 *
 * Validates and acknowledges declarative Generative UI cards (render_ui).
 * The tool input is pure data — no code execution, no network. Rendering
 * happens client-side in packages/ui; this handler is the fail-closed gate:
 *
 * 1. data-table "src" must resolve inside the current session's data/
 *    directory (path traversal rejected).
 * 2. Zod validation failures are fed back as a tool error so the model can
 *    fix the payload and retry. Every issue is classified into the stable
 *    `[genui:<code>]` taxonomy (P2-3) with one fix hint per code, so
 *    "fix and retry once" succeeds on the first attempt more often and local
 *    tooling can count error rates by code.
 * 3. The tool is only registered for desktop interactive turns while the
 *    generativeUI.inline toggle is on (see tool-defs.ts allowRenderUi); the
 *    optional ctx.isRenderUiEnabled callback re-checks the toggle at call
 *    time so mid-session disable takes effect on the next tool call.
 */

import { resolve, dirname, join, basename } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { isPathWithinDirectory } from '../runtime/path-security.ts';
import {
  RENDER_UI_MAX_COMPONENTS,
  RenderUiSchema,
  type GenUIComponent,
  type GenUIComponentInput,
} from '../tool-defs.ts';

/**
 * Pre-validation tool input: fields the schema defaults (`goodWhen`,
 * `semantics`, column `type`) stay optional here — safeParse materializes
 * them into the output-side GenUIComponent.
 */
export interface RenderUiArgs {
  components: GenUIComponentInput[];
}

// ============================================================
// Error-code taxonomy (P2-3)
// ============================================================

/**
 * Stable error codes for render_ui validation failures. Zod issue shapes are
 * an implementation detail (and differ across zod majors); these codes are the
 * stable contract the model sees and local tooling can count.
 */
export type GenUiErrorCode =
  | 'payload-too-large'
  | 'too-many-components'
  | 'duplicate-component-id'
  | 'duplicate-form-field-key'
  | 'select-options-mismatch'
  | 'missing-required'
  | 'invalid-type'
  | 'unrecognized-key'
  | 'schema-invalid';

/**
 * One actionable fix hint per error code — appended to the tool error text.
 * Computed lazily (not a module-level const) because RENDER_UI_MAX_COMPONENTS
 * comes from tool-defs.ts, which imports this module back (handler registry)
 * — a const initializer here can run before that binding initializes.
 */
export function genUiErrorHint(code: GenUiErrorCode): string {
  switch (code) {
    case 'payload-too-large':
      return 'Move data into a file via transform_data and use "src" (the render_ui payload cap is 4096 bytes).';
    case 'too-many-components':
      return `Split into multiple render_ui calls — at most ${RENDER_UI_MAX_COMPONENTS} components per call.`;
    case 'duplicate-component-id':
      return 'Give every component a unique "id" within one call (reuse an id only in a LATER call to update that card).';
    case 'duplicate-form-field-key':
      return 'Make field/param "key"s unique within one form or button.';
    case 'select-options-mismatch':
      return 'Only select fields/params may carry "options", and every select must carry at least one option.';
    case 'missing-required':
      return 'Add the missing required field (an empty "components" array needs at least one component).';
    case 'invalid-type':
      return 'Match the field\'s expected type, enum value, or length constraint as declared in the component schema.';
    case 'unrecognized-key':
      return 'Remove keys the component does not define — schemas are strict (e.g. data-table takes "src", never inline "rows").';
    case 'schema-invalid':
      return 'Compare the payload against the component schema and fix the mismatched cross-field rule.';
  }
}

/**
 * Minimal structural view of a Zod issue (z.ZodIssue without the version
 * coupling) so the classifier stays a pure, dependency-light function.
 * `received`/`type`/`origin` cover the fields zod 4 emits for the codes the
 * render_ui schema can produce.
 */
export interface GenUiIssueLike {
  code?: string;
  origin?: string | null;
  type?: string | null;
  received?: unknown;
  path: (string | number)[];
  message: string;
}

/**
 * Map one validation issue to a stable GenUiErrorCode.
 *
 * The schema's cross-field rules (payload cap, duplicate ids/keys, the
 * select⇔options contract) emit `custom` issues from superRefine — those are
 * classified by message content; the remaining zod issue codes map by kind.
 */
export function classifyGenUiIssue(issue: GenUiIssueLike): GenUiErrorCode {
  if (issue.code === 'custom') {
    const message = issue.message;
    if (message.includes('exceeds')) return 'payload-too-large';
    if (message.includes('Duplicate component id')) return 'duplicate-component-id';
    if (message.includes('Duplicate field key') || message.includes('Duplicate param key')) return 'duplicate-form-field-key';
    if (
      message.includes('select field') ||
      message.includes('select param') ||
      message.includes('options are only valid on select')
    ) {
      return 'select-options-mismatch';
    }
    return 'schema-invalid';
  }
  if (issue.code === 'unrecognized_keys') return 'unrecognized-key';
  if (issue.code === 'invalid_type') {
    return issue.received === 'undefined' ? 'missing-required' : 'invalid-type';
  }
  if (
    issue.code === 'invalid_value' ||
    issue.code === 'invalid_enum_value' ||
    issue.code === 'invalid_union' ||
    issue.code === 'invalid_union_discriminator'
  ) {
    // `invalid_value` is zod 4; `invalid_enum_value` is the zod 3 equivalent
    // for enum-field violations (runtime here is zod 3.25.x classic API).
    return 'invalid-type';
  }
  if (issue.code === 'too_big' || issue.code === 'too_small') {
    // The components array itself (no numeric segment in the path). Nested
    // arrays (fields/columns/series…) are per-field constraints instead.
    const isComponentsArray =
      (issue.origin === 'array' || issue.type === 'array') &&
      !issue.path.some(seg => typeof seg === 'number');
    if (isComponentsArray) {
      return issue.code === 'too_big' ? 'too-many-components' : 'missing-required';
    }
    return 'invalid-type';
  }
  return 'schema-invalid';
}

/** One classified issue, ready for formatting. */
export interface ClassifiedGenUiIssue {
  path: string;
  message: string;
  code: GenUiErrorCode;
  hint: string;
}

/** Classify (up to 10) Zod issues into the stable taxonomy. */
export function classifyGenUiIssues(error: { issues: GenUiIssueLike[] }): ClassifiedGenUiIssue[] {
  return error.issues.slice(0, 10).map(issue => {
    const code = classifyGenUiIssue(issue);
    return {
      path: issue.path.length > 0 ? issue.path.map(String).join('.') : '(payload)',
      message: issue.message,
      code,
      hint: genUiErrorHint(code),
    };
  });
}

/**
 * Format classified issues into a compact, model-actionable summary: every
 * issue carries its `[genui:<code>]` prefix, followed by one fix hint per
 * distinct code observed in the batch.
 */
function formatValidationIssues(error: { issues: GenUiIssueLike[] }): string {
  const classified = classifyGenUiIssues(error);
  const issueText = classified
    .map(issue => `${issue.path}: [genui:${issue.code}] ${issue.message}`)
    .join('; ');
  const seen = new Set<GenUiErrorCode>();
  const hints: string[] = [];
  for (const issue of classified) {
    if (!seen.has(issue.code)) {
      seen.add(issue.code);
      hints.push(`[genui:${issue.code}] ${issue.hint}`);
    }
  }
  return `${issueText}. Fix hints: ${hints.join(' ')}`;
}

function describeComponent(component: GenUIComponent): string {
  const title = component.title ? ` — ${component.title}` : '';
  return `- ${component.type} "${component.id}"${title}`;
}

/**
 * Real path with symlinked prefixes resolved, tolerating a not-yet-written
 * target: the nearest existing ancestor is real-pathed and the missing
 * remainder re-appended. Without this, a missing src compares its lexical
 * fallback (e.g. macOS tmpdir `/var/...`) against the boundary's real path
 * (`/private/var/...`) and containment would spuriously fail.
 */
function realPathForBoundaryCheck(target: string): string {
  let current = resolve(target);
  let suffix = '';
  for (;;) {
    try {
      return join(realpathSync.native(current), suffix);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      suffix = suffix ? join(basename(current), suffix) : basename(current);
      current = parent;
    }
  }
}

/**
 * Handle the render_ui tool call.
 *
 * Returns a success summary describing what was rendered. The renderer reads
 * the tool INPUT (via the activity stream), so the result text only needs to
 * confirm the card set and remind about id-based updates.
 */
export async function handleRenderUi(
  ctx: SessionToolContext,
  args: RenderUiArgs
): Promise<ToolResult> {
  // Call-time toggle re-check (defense in depth): registration already gated
  // the tool, but a mid-session toggle change must take effect on the next
  // call without a hot un-registration.
  if (ctx.isRenderUiEnabled && !ctx.isRenderUiEnabled()) {
    return errorResponse('render_ui is disabled by the Generative UI feature toggle.');
  }

  const parsed = RenderUiSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResponse(
      `Invalid render_ui payload — fix the issues and retry. Issues: ${formatValidationIssues(parsed.error)}`
    );
  }

  const dataDir = ctx.dataPath;

  // data-table components are file-backed: the src must resolve inside the
  // session data/ directory (same boundary transform_data writes to).
  const dataTables = parsed.data.components.filter(c => c.type === 'data-table');
  if (dataTables.length > 0) {
    if (!dataDir) {
      return errorResponse('render_ui data-table components require a session data directory.');
    }
    // The boundary is decided in real-path space so symlink escapes are caught
    // AND a not-yet-written src inside the directory still passes containment.
    const boundaryDir = realPathForBoundaryCheck(dataDir);
    for (const table of dataTables) {
      const resolvedSrc = resolve(dataDir, table.src);
      // Containment FIRST, existence second: the boundary decision must not
      // depend on whether an outside path happens to exist. An existence-first
      // order turns the two error messages into a filesystem existence oracle
      // (outside present → containment error, outside missing → not-found);
      // here out-of-boundary srcs always get the same containment error, and
      // existence only ever decides the not-found retry hint for paths already
      // inside the boundary.
      if (!isPathWithinDirectory(realPathForBoundaryCheck(resolvedSrc), boundaryDir)) {
        return errorResponse(
          `data-table "src" must be within the session data directory. Got: ${table.src}`
        );
      }
      if (!existsSync(resolvedSrc)) {
        return errorResponse(
          `data-table "src" file not found: ${table.src}\n\nRun transform_data first, then reference its output path.`
        );
      }
    }
  }

  const lines = [
    `Rendered ${parsed.data.components.length} UI card component(s):`,
    ...parsed.data.components.map(describeComponent),
    '',
    'The cards are now visible to the user. Reusing a component id in a later render_ui call updates that card in place.',
  ];

  return successResponse(lines.join('\n'));
}
