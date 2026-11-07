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
 */
export interface ProjectContextFacade {
  search(input: { query: string; tag?: string; limit?: number }): Promise<{ degraded: boolean; hits: ProjectContextSearchHit[] }>;
  read(input: { assetId: string; version?: number }): Promise<
    | { ok: true; content: string; truncated: boolean; version: number }
    | { ok: false; error: string }
  >;
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
