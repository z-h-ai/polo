/**
 * Update App Data Handler (P1-3 — canvas app data/structure separation)
 *
 * Iterates the mutable state of an existing generate_app canvas app WITHOUT
 * rewriting its HTML: the model sends the new JSON value, this handler writes
 * it atomically into the session data/ directory (the file the app's HTML
 * declared via <meta name="polo-app-data">), and Main pushes the fresh
 * content to the app's mounted card(s) as a ui_state message. When no card is
 * mounted (or the host has no canvas surface at all) the write still lands
 * and the content is injected on the card's next attach.
 *
 * Fail-closed fences (untrusted model input end to end):
 * 1. appId must match a previous generate_app app — strict pattern AND an
 *    existing `<data>/genui-apps/<appId>/` directory (never created here).
 * 2. dataSrc is resolved against the session data/ directory and must stay
 *    inside it in real-path space (isPathWithinDirectoryForCreation — the
 *    same symlink-aware containment the generate_app writes use; an
 *    absolute-inside-data form is accepted like payloadSrc, everything else
 *    — `..`, absolute-outside, NUL, symlink swaps — is rejected, not clamped).
 * 3. The serialized JSON is hard-capped at UPDATE_APP_DATA_MAX_BYTES (1MB,
 *    mirroring GENUI_APP_DATA_MAX_FILE_BYTES; parity guarded shared-side).
 * 4. The write is atomic (temp name + rename), so a card reading the file can
 *    never see a torn document; a post-write containment re-check closes the
 *    symlink-swap race before the push.
 *
 * The ui_state push goes through the optional ctx.notifyCanvasAppDataUpdated
 * seam (Electron only) — this handler itself never touches the webview, the
 * network, or anything outside the session data directory.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';
import { isPathWithinDirectory, isPathWithinDirectoryForCreation } from '../runtime/path-security.ts';
import {
  UpdateAppDataSchema,
  UPDATE_APP_DATA_MAX_BYTES,
} from '../tool-defs.ts';

export interface UpdateAppDataArgs {
  appId: string;
  dataSrc: string;
  data: unknown;
}

function formatValidationIssues(error: { issues: Array<{ path: (string | number)[]; message: string }> }): string {
  return error.issues
    .slice(0, 10)
    .map(issue => `${issue.path.length > 0 ? issue.path.map(String).join('.') : '(payload)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Atomic single-file write (generate_app's writeAtomic semantics): the
 * content lands at a unique temp name in the target directory and is renamed
 * over the target, so readers see either the previous file or the complete
 * new one — never a torn file. rename() replaces the target directory entry
 * rather than writing through it, so a symlink planted at the target is
 * swapped out, not followed.
 */
function writeAtomic(filePath: string, data: string): void {
  const tempPath = `${filePath}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    writeFileSync(tempPath, data, 'utf-8');
    renameSync(tempPath, filePath);
  } catch (error) {
    try {
      unlinkSync(tempPath);
    } catch {
      // The temp file may never have been created; the original error wins.
    }
    throw error;
  }
}

/** Resolve + fence the dataSrc against the session data/ directory. */
export function resolveAppDataWriteTarget(
  dataPath: string,
  dataSrc: string,
): { ok: true; target: string } | { ok: false; error: string } {
  if (dataSrc.includes('\0')) {
    return { ok: false, error: 'dataSrc must not contain NUL characters.' };
  }
  const candidate = isAbsolute(dataSrc) ? resolve(dataSrc) : resolve(dataPath, dataSrc);
  // Symlink-aware containment for a path that may not exist yet: the nearest
  // existing ancestor is real-pathed, and an existing target is checked in
  // full real-path space (macOS /var → /private/var included).
  if (!isPathWithinDirectoryForCreation(candidate, dataPath)) {
    return {
      ok: false,
      error: 'dataSrc escapes the session data directory. Use a path relative to the session data/ directory (e.g. "state.json").',
    };
  }
  return { ok: true, target: candidate };
}

/**
 * Handle the update_app_data tool call: validate the app id and the data
 * path, write the JSON atomically inside the session data/ directory, then
 * notify the host so mounted card(s) receive the fresh ui_state.
 */
export async function handleUpdateAppData(
  ctx: SessionToolContext,
  args: UpdateAppDataArgs
): Promise<ToolResult> {
  // Call-time toggle re-check (defense in depth) — the generate_app gate
  // covers this tool; a mid-session disable must take effect immediately.
  if (ctx.isGenerateAppEnabled && !ctx.isGenerateAppEnabled()) {
    return errorResponse('update_app_data is disabled by the Generative UI feature toggle.');
  }

  if (!ctx.dataPath) {
    return errorResponse('update_app_data requires a session data directory.');
  }

  const parsed = UpdateAppDataSchema.safeParse(args ?? {});
  if (!parsed.success) {
    return errorResponse(
      `Invalid update_app_data payload — fix the issues and retry. Issues: ${formatValidationIssues(parsed.error)}`
    );
  }
  const { appId, dataSrc, data } = parsed.data;

  // The app must already exist — this tool iterates, it never creates.
  const appsRoot = resolve(ctx.dataPath, 'genui-apps');
  const appDir = resolve(appsRoot, appId);
  if (!isPathWithinDirectory(appDir, appsRoot) || !existsSync(appDir)) {
    return errorResponse(
      `App not found: ${appId}. Use the app id from a previous generate_app result (create the app first with generate_app).`
    );
  }

  const serialized = `${JSON.stringify(data, null, 2)}\n`;
  const bytes = Buffer.byteLength(serialized, 'utf8');
  if (bytes > UPDATE_APP_DATA_MAX_BYTES) {
    return errorResponse(
      `data serializes to ${bytes} bytes; the hard limit is ${UPDATE_APP_DATA_MAX_BYTES} bytes (1MB). Split the data across declared files or reduce it.`
    );
  }

  const target = resolveAppDataWriteTarget(ctx.dataPath, dataSrc);
  if (!target.ok) {
    return errorResponse(target.error);
  }

  try {
    mkdirSync(dirname(target.target), { recursive: true });
    writeAtomic(target.target, serialized);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return errorResponse(`Failed to write the data file: ${msg}`);
  }

  // Post-write containment re-check in real-path space: closes the window
  // where a concurrent symlink swap could relocate the file before the push.
  if (!isPathWithinDirectory(target.target, ctx.dataPath)) {
    return errorResponse('The written data file escaped the session data directory; refusing to push it.');
  }

  // Mounted-card notification (Electron host). Absent seam → write-only:
  // the content is injected on the card's next attach.
  const delivered = ctx.notifyCanvasAppDataUpdated?.(appId, target.target);

  const lines = [
    `App data updated: ${dataSrc} (${bytes} bytes).`,
    delivered
      ? 'The new content was pushed to the mounted app card.'
      : 'No mounted card received the update right now — the content is injected when the card next attaches.',
    'Iterate further with update_app_data; reserve generate_app + updateOf for structural changes.',
  ];
  return successResponse(lines.join('\n'));
}
