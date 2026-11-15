/**
 * Project Context Protocol (POO-196)
 *
 * One dependency-free module for everything the project_context_* tools need:
 * the per-call re-authorized facade interface and the canonical Zod argument
 * schemas. Lives apart from tool-defs.ts (mirroring question-types.ts /
 * goal-types.ts) so handlers can import schemas without an import cycle.
 *
 * Authorization NEVER lives here: the facade implementation (server-core)
 * re-runs the full trusted-scope gate on every search/read — this module only
 * fixes the shape of the contract shared by hosts and handlers.
 */

import { z } from 'zod';

// ============================================================
// Facade Interface
// ============================================================

/**
 * One search hit from the project's shared file area. `snippet` is null when
 * the index has no text for the hit; `score` is null in degraded
 * (name/tag-only) matches.
 */
export interface ProjectContextSearchHit {
  assetId: string;
  version: number;
  name: string;
  tags: { id: string; label: string; preset: boolean }[];
  snippet: string | null;
  score: number | null;
}

/**
 * POO-196: per-call re-authorized access to the enterprise project's shared
 * file area. The IMPLEMENTATION lives server-side (server-core): every
 * search/read re-runs the full trusted-scope gate — no cached authorization
 * decides anything. The tool handlers only ever see this interface.
 *
 * POO-215 U1: `suggest` is the distillation-suggestion gate. It performs NO
 * admin call and NO write — the entries themselves travel to the renderer
 * through the tool_result for the user to confirm one by one (adjudication
 * Q5: model suggests, user disposes; never an automatic deposit). The facade
 * method only answers "is THIS session authorized to surface suggestions for
 * its committed project", so a non-project turn can never raise the card.
 */
export interface ProjectContextFacade {
  search(input: { query: string; tag?: string; limit?: number }): Promise<{ degraded: boolean; hits: ProjectContextSearchHit[] }>;
  read(input: { assetId: string; version?: number }): Promise<
    | { ok: true; content: string; truncated: boolean; version: number }
    | { ok: false; error: string }
  >;
  suggest(): Promise<{ ok: true } | { ok: false; error: string }>;
}

// ============================================================
// Canonical Zod Schemas
// ============================================================

export const ProjectContextSearchArgsSchema = z.object({
  query: z.string().min(1).max(2048).describe('What to look for in the project shared files. Matched against file names, tags and (when the search index is available) content.'),
  tag: z.string().max(64).optional().describe('Restrict results to one tag'),
  limit: z.number().int().min(1).max(20).optional().describe('Max hits to return (default and cap: 20)'),
}).strict();

export const ProjectContextReadArgsSchema = z.object({
  assetId: z.string().min(1).max(128).describe('Asset id of the project shared file (from an @ mention or a project_context_search hit)'),
  version: z.number().int().min(1).optional().describe('Specific version to read. Omit for the latest.'),
}).strict();

/**
 * POO-215 U1/U2: one distillation suggestion — a SELF-CONTAINED markdown
 * knowledge entry the model distilled from this turn's output, NOT a quote
 * of the chat history. Bounds: at most 5 entries per call (the checklist card
 * stays scannable), 20KB per body (the upload contract caps single assets
 * far above this), at most 4 suggested tags drawn from the preset vocabulary.
 */
export const ProjectContextSuggestArgsSchema = z.object({
  entries: z.array(z.object({
    title: z.string().min(1).max(120).describe('Short knowledge-entry title (the file name in the project library will be derived from it)'),
    body: z.string().min(1).max(20_000).describe('Self-contained markdown body: conclusions, steps, or the final artifact content — never a raw chat transcript'),
    suggestedTags: z.array(z.string().min(1).max(64)).max(4).default([]).describe('At most 4 preset tag ids from the project library vocabulary (e.g. requirement, design, tech, meeting)'),
  }).strict()).min(1).max(5).describe('The distilled entries to offer for deposit (1-5 per call)'),
}).strict();

export type ProjectContextSuggestArgs = z.output<typeof ProjectContextSuggestArgsSchema>;

/**
 * The tool_result payload the distillation card parses. `suggestions` mirrors
 * the accepted entries verbatim plus a stable id the renderer keys its
 * per-entry state on; the model never writes this envelope itself.
 */
export const PC_DISTILL_RESULT_MARKER = 'PC_DISTILL_SUGGESTIONS_V1';

export interface ProjectContextSuggestion {
  id: string;
  title: string;
  body: string;
  suggestedTags: string[];
}
