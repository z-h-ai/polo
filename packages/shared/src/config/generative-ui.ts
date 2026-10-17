/**
 * Generative UI Feature Toggles
 *
 * Two-level gate per Generative UI track, following the same semantics:
 * - Remote: the `generativeUI.<track>` key from /api/capabilities (org-level
 *   rollout). The field being ABSENT means enabled — backward compatible with
 *   servers that predate the flag. Only an explicit `false` disables.
 * - Local: the user-level Settings kill switch (getGenerativeUiInlineEnabled /
 *   getGenerativeUiCanvasEnabled).
 *
 * The two are intersected: either one off disables the tool. The remote value
 * is cached in module state because tool registration needs a synchronous
 * read; the cache is refreshed wherever /api/capabilities is fetched
 * (setGenerativeUiRemoteCapability). Missing/failing fetches leave the cache
 * untouched and default to enabled.
 *
 * Tracks:
 * - `inline` — Track 1 declarative cards (render_ui).
 * - `canvas` — Track 2 sandboxed canvas apps (generate_app).
 */

import { z } from 'zod';
import { getGenerativeUiInlineEnabled, getGenerativeUiCanvasEnabled } from './storage.ts';

/**
 * The generativeUI section of the /api/capabilities response.
 * Each track absent/undefined = enabled (backward compat); explicit false disables.
 */
export interface GenerativeUiCapability {
  generativeUI?: {
    /** Track 1 inline cards (render_ui). */
    inline?: boolean;
    /** Track 2 sandboxed canvas apps (generate_app). */
    canvas?: boolean;
  };
}

/**
 * Tolerant parse of the /api/capabilities payload: unknown sections (e.g.
 * creatorSkillArtifacts) are stripped and a missing generativeUI section is
 * fine — both leave the features enabled.
 */
export const GenerativeUiCapabilitySchema = z.object({
  generativeUI: z.object({
    inline: z.boolean().optional(),
    canvas: z.boolean().optional(),
  }).optional(),
});

let remoteCapability: GenerativeUiCapability | undefined;

/**
 * Update the cached remote capability. Only an explicit `<track>: false`
 * disables — absent field, undefined input, or a failed fetch keep the
 * features enabled (fail-open by design: backward compatibility).
 */
export function setGenerativeUiRemoteCapability(capability: GenerativeUiCapability | undefined | null): void {
  remoteCapability = capability ?? undefined;
}

/** True only when the server explicitly sent `generativeUI.inline === false`. */
export function isGenerativeUiRemoteInlineDisabled(): boolean {
  return remoteCapability?.generativeUI?.inline === false;
}

/** True only when the server explicitly sent `generativeUI.canvas === false`. */
export function isGenerativeUiRemoteCanvasDisabled(): boolean {
  return remoteCapability?.generativeUI?.canvas === false;
}

/**
 * Combined two-level gate for the render_ui tool, used at tool registration
 * and by the handler's call-time re-check. Remote kill and local kill switch
 * both apply.
 */
export function isGenerativeUiInlineEnabled(): boolean {
  return !isGenerativeUiRemoteInlineDisabled() && getGenerativeUiInlineEnabled();
}

/**
 * Combined two-level gate for the generate_app tool (canvas track). Same
 * semantics as the inline gate.
 */
export function isGenerativeUiCanvasEnabled(): boolean {
  return !isGenerativeUiRemoteCanvasDisabled() && getGenerativeUiCanvasEnabled();
}
