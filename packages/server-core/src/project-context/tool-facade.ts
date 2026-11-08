import type { ProjectContextFacade, ProjectContextSearchHit } from '@polo-ai/session-tools-core'
import type { PcReadResponse, PcSearchResponse } from '@polo-ai/shared/admin/project-context-contract'
import type { RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handlers/handler-deps'
import type { ISessionManager } from '../handlers/session-manager-interface'
import {
  isProjectSessionAuthorizedNow,
  pcReadAsset,
  pcSearchAssets,
} from './service'

/**
 * POO-196 — the per-call re-authorized facade the session tools ride.
 *
 * The factory runs the cheap SYNCHRONOUS session-authorization pre-check once
 * (session exists + bound to a project + that project IS the committed active
 * space for the trusted account + the session carries its immutable projectId
 * binding, POO-205) and returns null otherwise — the host then never
 * registers the tools' backing facade. EVERY search/read re-runs the FULL
 * `requireProjectContextScope` gate (fresh trusted token, fence binding,
 * account resolution, workspace binding, requested-space equality) plus the
 * post-call scope CAS — no cached authorization anywhere (D7). Failures never
 * throw through: search degrades to "no hits", read reports a stable pc_*
 * error the handler relays verbatim.
 */

/** The stable pc_* codes a read failure may report — nothing else escapes. */
type PcReadErrorCode = 'pc_not_found' | 'pc_content_not_indexed' | 'pc_service_unavailable' | 'pc_signin_required'

function stableReadErrorCode(error: unknown): PcReadErrorCode {
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'pc_not_found') return 'pc_not_found'
  if (code === 'pc_content_not_indexed') return 'pc_content_not_indexed'
  if (code === 'pc_signin_required') return 'pc_signin_required'
  // Everything else — lost fence, revoked membership, workspace mismatch,
  // admin outage, scope CAS drift — collapses to the generic unavailable code.
  // Fail closed: never leak WHICH fence condition failed.
  return 'pc_service_unavailable'
}

/**
 * Minimal RequestContext for the service path: `currentWorkspaceId(ctx, deps)`
 * only reads `ctx.workspaceId` when set, so a workspace-bound facade needs no
 * renderer client. The workspace binding itself is still verified against the
 * session manager (`getBoundWorkspace`).
 */
function facadeRequestContext(workspaceId: string): RequestContext {
  return { clientId: 'session-tool-project-context', workspaceId, webContentsId: null }
}

/**
 * POO-205: the immutable project binding the runtime session record carries
 * (stamped by the SessionManager at creation). Read structurally until the
 * protocol Session DTO catches up with the SessionManager wiring.
 */
type ProjectBoundSessionRecord = {
  id: string
  productSpaceId?: string
  projectId?: string
}

export interface ProjectContextToolFacadeInput {
  deps: HandlerDeps<ISessionManager>
  sessionId: string
  workspaceId: string
}

/**
 * Builds the per-session project context facade for session tools, or null
 * when the session is not (or no longer) an authorized project session. The
 * host (SessionManager) closes over its HandlerDeps and calls this per agent
 * construction; the returned facade re-authorizes on every call.
 */
export function createProjectContextToolFacade(input: ProjectContextToolFacadeInput): ProjectContextFacade | null {
  const { deps, sessionId, workspaceId } = input

  // Synchronous fail-closed pre-check (cheap; the authoritative gate re-runs
  // inside every pcSearchAssets/pcReadAsset call below).
  const session = deps.sessionManager
    .getSessions()
    .find(candidate => candidate.id === sessionId) as ProjectBoundSessionRecord | undefined
  if (!isProjectSessionAuthorizedNow({
    workspaceId,
    sessionProductSpaceId: session?.productSpaceId ?? null,
    sessionProjectId: session?.projectId ?? null,
  })) {
    return null
  }

  return {
    async search({ query, tag, limit }): Promise<{ degraded: boolean; hits: ProjectContextSearchHit[] }> {
      try {
        // Re-read the session so a rebinding mid-turn is honored: the space +
        // project addressed are the session's CURRENT bindings, and the
        // service gate (`assertRequestedSpace`) refuses anything but the
        // committed active space.
        const current = deps.sessionManager
          .getSessions()
          .find(candidate => candidate.id === sessionId) as ProjectBoundSessionRecord | undefined
        const productSpaceId = current?.productSpaceId
        const projectId = current?.projectId
        if (!productSpaceId || !projectId) return { degraded: true, hits: [] }
        const result = await pcSearchAssets(deps, facadeRequestContext(workspaceId), {
          workspaceId,
          productSpaceId,
          projectId,
          q: query,
          tag,
          limit,
        }) as PcSearchResponse
        return {
          degraded: result.degraded === true,
          hits: result.hits,
        }
      } catch (error) {
        // Search has no error channel — every failure (gate, outage, scope
        // CAS) degrades to an empty, explicitly degraded result. Never throw
        // through, never fabricate hits.
        deps.platform.logger?.warn(
          `PC_TOOL_SEARCH: ${error instanceof Error ? error.message : String(error)}`,
        )
        return { degraded: true, hits: [] }
      }
    },

    async read({ assetId, version }): Promise<
      | { ok: true; content: string; truncated: boolean; version: number }
      | { ok: false; error: string }
    > {
      try {
        const current = deps.sessionManager
          .getSessions()
          .find(candidate => candidate.id === sessionId) as ProjectBoundSessionRecord | undefined
        const productSpaceId = current?.productSpaceId
        const projectId = current?.projectId
        if (!productSpaceId || !projectId) return { ok: false, error: 'pc_service_unavailable' }
        const result = await pcReadAsset(deps, facadeRequestContext(workspaceId), {
          workspaceId,
          productSpaceId,
          projectId,
          assetId,
          version,
        }) as PcReadResponse
        // PcReadResponse kind is fixed to 'text' by the admin contract — a
        // binary asset never surfaces here.
        return { ok: true, content: result.content, truncated: result.truncated === true, version: result.version }
      } catch (error) {
        deps.platform.logger?.warn(
          `PC_TOOL_READ: ${error instanceof Error ? error.message : String(error)}`,
        )
        return { ok: false, error: stableReadErrorCode(error) }
      }
    },
  }
}
