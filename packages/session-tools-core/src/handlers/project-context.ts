/**
 * project_context_search / project_context_read Handlers (POO-196)
 *
 * Read-only lookups into the enterprise project's shared file area. The
 * handlers NEVER authorize anything themselves: they resolve the facade once
 * per call via ctx.getProjectContext() and forward to it. Null/absent facade
 * = the turn is not inside an authorized project session — fail closed with
 * an explicit message (never fabricated content, never a cached answer).
 *
 * All authorization (committed enterprise ProductSpace fence, membership,
 * workspace binding, per-call scope CAS) lives server-side behind the facade.
 */

import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { errorResponse, successResponse } from '../response.ts';
// Import from the leaf protocol module — never from tool-defs.ts — so this
// handler stays outside the tool-defs ↔ handlers module cycle.
import {
  ProjectContextSearchArgsSchema,
  ProjectContextReadArgsSchema,
  type ProjectContextSearchHit,
} from '../project-context-types.ts';

const PROJECT_CONTEXT_TOOLS_UNAVAILABLE = '当前会话不在项目共享范围内';

/** One hit per line: 名称 (v版本) 标签 ｜ snippet ｜ assetId=… version=… */
function formatHit(hit: ProjectContextSearchHit): string {
  const tags = hit.tags.length > 0 ? hit.tags.map(tag => tag.label).join('/') : '-';
  const snippet = hit.snippet ? hit.snippet.replace(/\s+/g, ' ').trim() : '-';
  const score = hit.score !== null ? ` score=${hit.score.toFixed(3)}` : '';
  return `${hit.name} (v${hit.version}) [${tags}]${score} ｜ ${snippet} ｜ assetId=${hit.assetId} version=${hit.version}`;
}

function parseArgs<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, args: unknown): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success || parsed.data === undefined) {
    return { ok: false, error: 'invalid arguments' };
  }
  return { ok: true, data: parsed.data };
}

export async function handleProjectContextSearch(ctx: SessionToolContext, args: unknown): Promise<ToolResult> {
  const facade = ctx.getProjectContext?.();
  if (!facade) {
    return errorResponse(PROJECT_CONTEXT_TOOLS_UNAVAILABLE);
  }

  const parsed = parseArgs(ProjectContextSearchArgsSchema, args);
  if (!parsed.ok) {
    return errorResponse(`Invalid project_context_search arguments: ${parsed.error}`);
  }

  let result: Awaited<ReturnType<typeof facade.search>>;
  try {
    result = await facade.search({
      query: parsed.data.query,
      tag: parsed.data.tag,
      limit: parsed.data.limit,
    });
  } catch (error) {
    // The facade contract is "no throw" — an unexpected rejection is still
    // fail-closed: report it without leaking or inventing project content.
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`project_context_search failed: ${message}`);
  }

  const lines: string[] = [];
  if (result.degraded) {
    lines.push('索引暂不可达，以下按名称与标签匹配');
  }
  if (result.hits.length === 0) {
    lines.push(result.degraded
      ? '没有匹配的项目共享文件'
      : `没有匹配的项目共享文件（query: ${parsed.data.query}）`);
  } else {
    for (const hit of result.hits) {
      lines.push(formatHit(hit));
    }
  }
  return successResponse(lines.join('\n'));
}

export async function handleProjectContextRead(ctx: SessionToolContext, args: unknown): Promise<ToolResult> {
  const facade = ctx.getProjectContext?.();
  if (!facade) {
    return errorResponse(PROJECT_CONTEXT_TOOLS_UNAVAILABLE);
  }

  const parsed = parseArgs(ProjectContextReadArgsSchema, args);
  if (!parsed.ok) {
    return errorResponse(`Invalid project_context_read arguments: ${parsed.error}`);
  }

  let result: Awaited<ReturnType<typeof facade.read>>;
  try {
    result = await facade.read({
      assetId: parsed.data.assetId,
      version: parsed.data.version,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`project_context_read failed: ${message}`);
  }

  if (!result.ok) {
    // Relay the stable pc_* code verbatim — the error is the honest outcome,
    // never invent content around it.
    return errorResponse(`project_context_read failed: ${result.error}`);
  }

  const header = `${parsed.data.assetId} v${result.version}${result.truncated ? ' (内容已截断)' : ''}`;
  return successResponse(`${header}\n${result.content}`);
}
