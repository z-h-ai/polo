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
 *    fix the payload and retry.
 * 3. The tool is only registered for desktop interactive turns while the
 *    generativeUI.inline toggle is on (see tool-defs.ts allowRenderUi); the
 *    optional ctx.isRenderUiEnabled callback re-checks the toggle at call
 *    time so mid-session disable takes effect on the next tool call.
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { isPathWithinDirectory } from '../runtime/path-security.ts';
import {
  RenderUiSchema,
  type GenUIComponent,
} from '../tool-defs.ts';

export interface RenderUiArgs {
  components: GenUIComponent[];
}

/** Format Zod issues into a compact, model-actionable summary. */
function formatValidationIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues
    .slice(0, 10)
    .map(issue => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(payload)'}: ${issue.message}`)
    .join('; ');
}

function describeComponent(component: GenUIComponent): string {
  const title = component.title ? ` — ${component.title}` : '';
  return `- ${component.type} "${component.id}"${title}`;
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
    for (const table of dataTables) {
      const resolvedSrc = resolve(dataDir, table.src);
      // Existence first: the containment check resolves symlinks, which only
      // behaves correctly for paths that exist.
      if (!existsSync(resolvedSrc)) {
        return errorResponse(
          `data-table "src" file not found: ${table.src}\n\nRun transform_data first, then reference its output path.`
        );
      }
      if (!isPathWithinDirectory(resolvedSrc, dataDir)) {
        return errorResponse(
          `data-table "src" must be within the session data directory. Got: ${table.src}`
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
