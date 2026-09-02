import { readFile, writeFile, stat } from 'fs/promises'
import { join } from 'path'
import { RPC_CHANNELS, type FileAttachment, type SendMessageOptions, type SessionEvent } from '@polo-ai/shared/protocol'
import type { StoredAttachment } from '@polo-ai/core/types'
import { getWorkspaceByNameOrId } from '@polo-ai/shared/config'
import { perf } from '@polo-ai/shared/utils'
import { isValidThinkingLevel, THINKING_LEVEL_IDS } from '@polo-ai/shared/agent/thinking-levels'

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(id => `'${id}'`).join(', ')
import { pushTyped, type RpcServer, type RequestContext } from '@polo-ai/server-core/transport'
import type { HandlerDeps, SessionFileWatcher } from '../handler-deps'
import { setTransferableHandler } from './transfer'
import { bindClientActiveSession } from './client-active-session'
import {
  getRuntimeActiveProductSpace,
  isRuntimeOfflineReadOnly,
  unregisterProductSpaceExecution,
} from '../../runtime/product-space-executions'
import {
  captureCompleteTrustedSessionScope,
  captureTrustedSessionScope,
  getSyncTrustedProductSpaceAccountId,
  trustedScopeMatchesSessionRecord,
} from './trusted-product-space-account'

/**
 * The offline read-only view keeps only the RPCs needed to read saved
 * history. Every Session write entry — create, import (direct or committed
 * through chunked transfer), permission/credential responses and mutating
 * commands — must refuse while the offline view is active so no data enters
 * the runtime without a fresh online membership validation.
 */
function assertOnlineBusinessSurface(): void {
  if (isRuntimeOfflineReadOnly()) {
    throw new Error('OFFLINE_READ_ONLY')
  }
}

interface ClientSessionWatchState {
  watcher: SessionFileWatcher
  sessionId: string
  debounceTimer: ReturnType<typeof setTimeout> | null
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>()

const SESSION_GET_LOG_ID_LIMIT = 25

function summarizeIds(ids: Iterable<string>, limit = SESSION_GET_LOG_ID_LIMIT) {
  const all = Array.from(ids)
  return {
    count: all.length,
    ids: all.slice(0, limit),
    truncated: all.length > limit,
  }
}

/**
 * Stable business-RPC error for an uncommitted (null) runtime fence.
 */
export const PRODUCT_SPACE_CONTEXT_REQUIRED = 'PRODUCT_SPACE_CONTEXT_REQUIRED'

/**
 * Space AND account fence (R32-2), completed with the caller's Main-owned
 * Workspace binding (R33-1) and made FAIL-CLOSED on an unresolvable caller
 * Workspace (R34-1). A session is inside the active scope only when ALL of
 * the following hold against ONE trusted immutable scope:
 * - the caller's Workspace is resolvable from Main-owned state (RPC context
 *   or window registry) — a boundary that cannot attribute its caller never
 *   operates;
 * - the committed ProductSpace matches the runtime fence,
 * - the immutable account binding matches the current trusted account
 *   (space-bound legacy records without an accountId are quarantined —
 *   fail-closed, never silently adopted by the next signed-in account),
 * - the target session belongs to that same caller Workspace.
 */
function sessionInsideActiveSpace(
  sessionManager: HandlerDeps['sessionManager'],
  sessionId: string,
  callerWorkspaceId?: string | null,
): boolean {
  // R37-3: ONE atomic complete Main-owned scope capture — the runtime fence
  // account must equal the trusted mirror, the transition epoch must be
  // stable and settled, and the record is compared only against that
  // immutable account/ProductSpace/caller-Workspace tuple. Split
  // fence/mirror states can never authorize a boundary.
  const scope = captureCompleteTrustedSessionScope(callerWorkspaceId)
  if (!scope) return false
  const session = sessionManager
    .getSessions()
    .find(candidate => candidate.id === sessionId)
  if (!session) return false
  return trustedScopeMatchesSessionRecord(session, scope)
}

/**
 * The ONE shared Main-owned authorization predicate for every session
 * boundary (list/read/write/send/watch/command/branch/import). Everything
 * ID-addressed funnels through here — there is no second path that could
 * forget a dimension.
 */
function sessionOutsideActiveScope(
  sessionManager: HandlerDeps['sessionManager'],
  sessionId: string,
  callerWorkspaceId?: string | null,
): boolean {
  return !sessionInsideActiveSpace(sessionManager, sessionId, callerWorkspaceId)
}

function assertSessionScopeAllowed(
  sessionManager: HandlerDeps['sessionManager'],
  sessionId: string,
  callerWorkspaceId?: string | null,
): void {
  if (sessionOutsideActiveScope(sessionManager, sessionId, callerWorkspaceId)) {
    throw new Error(PRODUCT_SPACE_CONTEXT_REQUIRED)
  }
}

// R34-1: the scope capture is THE shared atomic helper (see
// trusted-product-space-account) — the handler layer and SessionManager no
// longer keep divergent copies.

function sessionWorkspaceDistribution(sessions: Array<{ workspaceId?: string }>): Record<string, number> {
  const distribution: Record<string, number> = {}
  for (const session of sessions) {
    const key = session.workspaceId || '(missing)'
    distribution[key] = (distribution[key] ?? 0) + 1
  }
  return distribution
}

/**
 * Clean up session file watcher for a client.
 * Called from main process disconnect hooks to prevent watcher leaks.
 */
export function cleanupSessionFileWatchForClient(clientId: string): void {
  const state = clientSessionWatches.get(clientId)
  if (!state) return

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer)
    state.debounceTimer = null
  }

  state.watcher.close()
  clientSessionWatches.delete(clientId)
}

// Recursive directory scanner for session files
// Filters out internal files (session.jsonl) and hidden files (. prefix)
// Returns only non-empty directories
async function scanSessionDirectory(dirPath: string): Promise<import('@polo-ai/shared/protocol').SessionFile[]> {
  const { readdir, stat } = await import('fs/promises')
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: import('@polo-ai/shared/protocol').SessionFile[] = []

  for (const entry of entries) {
    // Skip internal and hidden files
    if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue

    const fullPath = join(dirPath, entry.name)

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const children = await scanSessionDirectory(fullPath)
      // Only include non-empty directories
      if (children.length > 0) {
        files.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        })
      }
    } else {
      const stats = await stat(fullPath)
      files.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: stats.size,
      })
    }
  }

  // Sort: directories first, then alphabetically
  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
] as const

export function registerSessionsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const { sessionManager, platform } = deps
  const log = platform.logger

  /**
   * R33-1: the caller's Workspace comes from Main-owned state only — the
   * RPC context or the window registry — never from renderer assertions.
   * `null`/`undefined` means "cannot bind" (no window, no context): the
   * account/space dimensions still apply, the Workspace dimension simply
   * cannot narrow them.
   */
  const resolveCallerWorkspaceId = (
    ctx: { workspaceId?: string | null; webContentsId?: number | null },
  ): string | null | undefined => {
    if (ctx.workspaceId) return ctx.workspaceId
    if (ctx.webContentsId == null) return undefined
    return deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? null
  }

  // Get all sessions for the calling window's workspace
  // Waits for initialization to complete so sessions are never returned empty during startup
  server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_SESSIONS continuing after initialization failure:', error)
    }
    const end = perf.start('rpc.getSessions')
    const windowWorkspaceId = ctx.webContentsId != null
      ? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId)
      : undefined
    const workspaceId = ctx.workspaceId ?? windowWorkspaceId
    // R34-1: the list is Workspace-scoped — a caller whose Workspace cannot
    // be resolved from Main-owned state is attributed to nothing and fails
    // closed with an empty list.
    if (!workspaceId) {
      end()
      return []
    }
    const allSessions = sessionManager.getSessions(workspaceId ?? undefined)
    // Fail closed: R37-3 — the list filter is bound to ONE atomic complete
    // Main-owned scope capture (fence account == trusted mirror, stable
    // settled epoch, caller Workspace). Split fence/mirror states surface
    // nothing.
    const listScope = captureCompleteTrustedSessionScope(workspaceId)
    const sessions = listScope
      ? allSessions.filter(session => trustedScopeMatchesSessionRecord(session, listScope))
      : []
    end()

    log.info('[sessions:get] result', {
      ctxWorkspaceId: ctx.workspaceId,
      webContentsId: ctx.webContentsId,
      windowWorkspaceId,
      resolvedWorkspaceId: workspaceId,
      returnedCount: sessions.length,
      returnedWorkspaceIds: sessionWorkspaceDistribution(sessions),
      returnedIds: summarizeIds(sessions.map(s => s.id)),
    })

    return sessions
  })

  // Get unread summary across all workspaces. R33-1: the aggregate is
  // account-aware — only sessions inside the complete trusted scope are
  // counted, and a replaced account never sees its predecessor's unread
  // state.
  server.handle(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY, async () => {
    try {
      await sessionManager.waitForInit()
    } catch (error) {
      log.error('GET_UNREAD_SUMMARY continuing after initialization failure:', error)
    }
    return sessionManager.getUnreadSummary(captureTrustedSessionScope())
  })

  server.handle(RPC_CHANNELS.sessions.MARK_ALL_READ, async (ctx, workspaceId: string) => {
    // R33-1/R35-1: the aggregate mutation is bound to the COMPLETE trusted
    // scope — account AND committed space AND the caller's Main-owned
    // Workspace. A renderer-supplied workspaceId alone can never widen the
    // mutation: without a resolvable caller Workspace, or when the selected
    // id disagrees with it, nothing is marked (fail closed).
    const scope = captureCompleteTrustedSessionScope(resolveCallerWorkspaceId(ctx))
    if (!scope || scope.workspaceId !== workspaceId) {
      return
    }
    return sessionManager.markAllSessionsRead(workspaceId, scope)
  })

  // Get a single session with messages (for lazy loading)
  server.handle(RPC_CHANNELS.sessions.GET_MESSAGES, async (ctx, sessionId: string) => {
    if (sessionOutsideActiveScope(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))) return null
    const end = perf.start('rpc.getSessionMessages')
    const session = await sessionManager.getSession(sessionId)
    end()
    return session
  })

  // Create a new session
  server.handle(RPC_CHANNELS.sessions.CREATE, async (ctx, workspaceId: string, options?: import('@polo-ai/shared/protocol').CreateSessionOptions) => {
    // R34-1: the destination Workspace is the CALLER's Main-owned Workspace,
    // never a renderer-selected id. A caller whose Workspace cannot be
    // resolved — or that asks for a different destination than its own —
    // fails closed before any record is created.
    const callerWorkspaceId = resolveCallerWorkspaceId(ctx)
    if (!callerWorkspaceId || callerWorkspaceId !== workspaceId) {
      throw new Error(PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
    // A session may only be created inside the committed active ProductSpace;
    // a null fence means the business surface is not ready, and the offline
    // read-only view starts no new sessions.
    if (!getRuntimeActiveProductSpace()) {
      throw new Error(PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
    assertOnlineBusinessSurface()
    const end = perf.start('rpc.createSession', { workspaceId })
    const session = await sessionManager.createSession(workspaceId, options)
    end()
    // R30: no unchecked best-effort pre-registration here — the first
    // sendMessage registers the session's execution through the checked
    // reservation protocol (gate capture + switch-lock critical section +
    // atomic transition to processing), so no inactive stale record can be
    // left behind by a path that bypasses that protocol.
    return session
  })

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (ctx, sessionId: string) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    unregisterProductSpaceExecution(sessionId)
    return sessionManager.deleteSession(sessionId)
  })

  // Send a message to a session (with optional file attachments).
  //
  // Behavior:
  //   - Awaits until the user message is persisted to disk, then returns
  //     `{ accepted: true, messageId }`. This guarantees the message survives
  //     a mid-stream crash (#616).
  //   - The actual model-streaming work continues in the background; results
  //     flow back via SESSION_EVENT as before.
  //   - Pre-persist errors (session not found, etc.) reject the RPC so the
  //     caller can show a synchronous error.
  //   - Post-persist errors (model API failures, etc.) are routed via the
  //     event stream as today.
  // attachments: FileAttachment[] for Claude (has content), storedAttachments: StoredAttachment[] for persistence (has thumbnailBase64)
  server.handle(RPC_CHANNELS.sessions.SEND_MESSAGE, async (ctx, sessionId: string, message: string, attachments?: FileAttachment[], storedAttachments?: StoredAttachment[], options?: SendMessageOptions) => {
    // Capture the caller's clientId for error routing
    const callerClientId = ctx.clientId

    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    // The offline read-only view shows saved history but starts no executions.
    if (isRuntimeOfflineReadOnly()) {
      throw new Error('OFFLINE_READ_ONLY')
    }

    // R30: the redundant SEND pre-registration was removed — sendMessage
    // itself registers through the checked reservation protocol before any
    // bootstrap work, so this path can no longer leave an unchecked record.

    return await new Promise<{ accepted: true; messageId: string }>((resolve, reject) => {
      let acked = false
      const onAck = (messageId: string) => {
        if (!acked) {
          acked = true
          resolve({ accepted: true, messageId })
        }
      }

      sessionManager
        .sendMessage(sessionId, message, attachments, storedAttachments, options, undefined, undefined, onAck, { callerClientId })
        .then(() => {
          // sendMessage finished without firing onAck — should not happen in
          // practice (every code path that creates a user message acks).
          // Treat as a defensive failure rather than silently dropping.
          if (!acked) {
            acked = true
            reject(new Error('sendMessage completed without persisting a user message'))
          }
        })
        .catch(err => {
          log.error('Error in sendMessage:', err)
          if (!acked) {
            // Pre-persist error — surface synchronously to the caller.
            acked = true
            reject(err)
            return
          }
          // Post-persist error — route via the event stream as today.
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'error',
            sessionId,
            error: err instanceof Error ? err.message : 'Unknown error'
          } as SessionEvent)
          pushTyped(server, RPC_CHANNELS.sessions.EVENT, { to: 'client', clientId: callerClientId }, {
            type: 'complete',
            sessionId
          } as SessionEvent)
        })
    })
  })

  // Cancel processing
  server.handle(RPC_CHANNELS.sessions.CANCEL, async (ctx, sessionId: string, silent?: boolean) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    return sessionManager.cancelProcessing(sessionId, silent)
  })

  // Kill background shell
  server.handle(RPC_CHANNELS.sessions.KILL_SHELL, async (ctx, sessionId: string, shellId: string) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    return sessionManager.killShell(sessionId, shellId)
  })

  // Get background task output
  server.handle(RPC_CHANNELS.tasks.GET_OUTPUT, async (ctx, taskId: string) => {
    // R35-1: the output belongs to its OWNER session — the complete trusted
    // caller scope (account AND committed space AND caller Workspace) must
    // resolve before the owner session is even looked up, and the owner is
    // re-checked against that scope inside SessionManager. Missing caller
    // binding discloses nothing.
    const scope = captureCompleteTrustedSessionScope(resolveCallerWorkspaceId(ctx))
    if (!scope) {
      return null
    }
    try {
      const output = await sessionManager.getTaskOutput(taskId, scope)
      return output
    } catch (err) {
      log.error('Failed to get task output:', err)
      throw err
    }
  })

  // Respond to a permission request (bash command approval)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION, async (ctx, sessionId: string, requestId: string, allowed: boolean, alwaysAllow: boolean) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    // Responding can resume agent processing: never allowed in the offline
    // read-only view.
    assertOnlineBusinessSurface()
    return sessionManager.respondToPermission(sessionId, requestId, allowed, alwaysAllow)
  })

  // Respond to a credential request (secure auth input)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL, async (ctx, sessionId: string, requestId: string, response: import('@polo-ai/shared/protocol').CredentialResponse) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    assertOnlineBusinessSurface()
    return sessionManager.respondToCredential(sessionId, requestId, response)
  })

  // ==========================================================================
  // Consolidated Command Handlers
  // ==========================================================================

  // Commands that mutate session data or can trigger agent work are refused
  // in the offline read-only view; only the local history-reading and
  // navigation commands below stay available.
  const OFFLINE_MUTATING_COMMANDS = new Set<import('@polo-ai/shared/protocol').SessionCommand['type']>([
    'flag',
    'unflag',
    'archive',
    'unarchive',
    'rename',
    'setSessionStatus',
    'setPermissionMode',
    'setThinkingLevel',
    'updateWorkingDirectory',
    'setSources',
    'setLabels',
    'setConnection',
    'shareToViewer',
    'updateShare',
    'revokeShare',
    'refreshTitle',
    'setPendingPlanExecution',
    'markCompactionComplete',
    'markPendingPlanExecutionDispatched',
    'clearPendingPlanExecution',
    'addAnnotation',
    'removeAnnotation',
  ])

  // Session commands - consolidated handler for session operations
  server.handle(RPC_CHANNELS.sessions.COMMAND, async (
    ctx,
    sessionId: string,
    command: import('@polo-ai/shared/protocol').SessionCommand
  ) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    if (OFFLINE_MUTATING_COMMANDS.has(command.type)) {
      assertOnlineBusinessSurface()
    }
    switch (command.type) {
      case 'flag':
        return sessionManager.flagSession(sessionId)
      case 'unflag':
        return sessionManager.unflagSession(sessionId)
      case 'archive':
        return sessionManager.archiveSession(sessionId)
      case 'unarchive':
        return sessionManager.unarchiveSession(sessionId)
      case 'rename':
        return sessionManager.renameSession(sessionId, command.name)
      case 'setSessionStatus':
        return sessionManager.setSessionStatus(sessionId, command.state)
      case 'markRead':
        return sessionManager.markSessionRead(sessionId)
      case 'markUnread':
        return sessionManager.markSessionUnread(sessionId)
      case 'setActiveViewing':
        {
          const activeWorkspaceId = ctx.workspaceId
            ?? (
              ctx.webContentsId === null
                ? null
                : deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId) ?? null
            )
          const session = await sessionManager.getSession(sessionId)
          if (
            !activeWorkspaceId
            || command.workspaceId !== activeWorkspaceId
            || session?.workspaceId !== activeWorkspaceId
          ) {
            throw Object.assign(
              new Error('Active session does not belong to the RPC client workspace'),
              { code: 'workspace_context_mismatch' },
            )
          }
          // This server-owned client binding is the authority used by
          // session-scoped mutations such as Creator Skill installation.
          bindClientActiveSession(ctx.clientId, activeWorkspaceId, sessionId)
        }
        // Track which session user is actively viewing (for unread state machine).
        return sessionManager.setActiveViewingSession(sessionId, command.workspaceId)
      case 'setPermissionMode':
        return sessionManager.setSessionPermissionMode(sessionId, command.mode)
      case 'setThinkingLevel':
        // Validate thinking level before passing to session manager
        if (!isValidThinkingLevel(command.level)) {
          throw new Error(`Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`)
        }
        return sessionManager.setSessionThinkingLevel(sessionId, command.level)
      case 'updateWorkingDirectory':
        return sessionManager.updateWorkingDirectory(sessionId, command.dir)
      case 'setSources':
        return sessionManager.setSessionSources(sessionId, command.sourceSlugs)
      case 'setLabels':
        return sessionManager.setSessionLabels(sessionId, command.labels)
      case 'showInFinder': {
        const sessionPath = sessionManager.getSessionPath(sessionId)
        if (sessionPath) {
          deps.platform.showItemInFolder?.(sessionPath)
        }
        return
      }
      case 'copyPath': {
        // Return the session folder path for copying to clipboard
        const sessionPath = sessionManager.getSessionPath(sessionId)
        return sessionPath ? { success: true, path: sessionPath } : { success: false }
      }
      case 'shareToViewer':
        return sessionManager.shareToViewer(sessionId)
      case 'updateShare':
        return sessionManager.updateShare(sessionId)
      case 'revokeShare':
        return sessionManager.revokeShare(sessionId)
      case 'refreshTitle':
        log.info(`IPC: refreshTitle received for session ${sessionId}`)
        return sessionManager.refreshTitle(sessionId)
      // Connection selection (locked after first message)
      case 'setConnection':
        log.info(`IPC: setConnection received for session ${sessionId}, connection: ${command.connectionSlug}`)
        return sessionManager.setSessionConnection(sessionId, command.connectionSlug)
      // Pending plan execution (Accept & Compact flow)
      case 'setPendingPlanExecution':
        return sessionManager.setPendingPlanExecution(sessionId, command.planPath, command.draftInputSnapshot)
      case 'markCompactionComplete':
        return sessionManager.markCompactionComplete(sessionId)
      case 'markPendingPlanExecutionDispatched':
        return sessionManager.markPendingPlanExecutionDispatched(sessionId)
      case 'clearPendingPlanExecution':
        return sessionManager.clearPendingPlanExecution(sessionId)
      case 'addAnnotation':
        return sessionManager.addMessageAnnotation(sessionId, command.messageId, command.annotation)
      case 'removeAnnotation':
        return sessionManager.removeMessageAnnotation(sessionId, command.messageId, command.annotationId)
      case 'updateAnnotation':
        return sessionManager.updateMessageAnnotation(sessionId, command.messageId, command.annotationId, command.patch)
      default: {
        const _exhaustive: never = command
        throw new Error(`Unknown session command: ${JSON.stringify(command)}`)
      }
    }
  })

  // Get pending plan execution state (for reload recovery)
  server.handle(RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION, async (
    ctx,
    sessionId: string
  ) => {
    if (sessionOutsideActiveScope(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))) return null
    return sessionManager.getPendingPlanExecution(sessionId)
  })

  // Get authoritative permission mode diagnostics for renderer reconciliation
  server.handle(RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE, async (
    ctx,
    sessionId: string
  ) => {
    if (sessionOutsideActiveScope(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))) return null
    return sessionManager.getSessionPermissionModeState(sessionId)
  })

  // ============================================================
  // Session Content Search
  // ============================================================

  // Search session content using ripgrep
  server.handle(RPC_CHANNELS.sessions.SEARCH_CONTENT, async (ctx, workspaceId: string, query: string, searchId?: string) => {
    const id = searchId || Date.now().toString(36)
    log.info('[search]','ipc:request', { searchId: id, query })

    // R33-1/R34-1: the searched workspace must be the CALLER's Main-owned
    // Workspace, and a caller whose Workspace cannot be resolved never
    // searches at all — a renderer-provided id alone can never widen the
    // search.
    const callerWorkspaceId = resolveCallerWorkspaceId(ctx)
    if (!callerWorkspaceId || callerWorkspaceId !== workspaceId) {
      log.warn('SEARCH_CONTENT refused: no resolvable caller workspace or requested workspace does not match it', { searchId: id })
      return []
    }

    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.warn('SEARCH_SESSIONS: Workspace not found:', workspaceId)
      return []
    }

    const { searchSessions } = await import('@polo-ai/server-core/services')
    const sessionsDir = sessionManager.getSessionsRoot(workspace.id)
    if (!sessionsDir) return []
    log.debug(`SEARCH_SESSIONS: Searching "${query}" in ${sessionsDir}`)

    const results = await searchSessions(query, sessionsDir, {
      timeout: 5000,
      maxMatchesPerSession: 3,
      maxSessions: 50,
      searchId: id,
    })

    // Filter out hidden sessions and every session outside the COMPLETE
    // trusted scope (other ProductSpace, replaced account, or never-bound
    // legacy records). R37-3: one atomic complete scope capture — split
    // fence/mirror states surface nothing.
    const allSessions = await sessionManager.getSessions()
    const searchScope = captureCompleteTrustedSessionScope(callerWorkspaceId)
    const excludedSessionIds = new Set(
      allSessions
        .filter(s => s.hidden
          || !searchScope
          || !trustedScopeMatchesSessionRecord(s, searchScope))
        .map(s => s.id)
    )
    const filteredResults = results.filter(r => !excludedSessionIds.has(r.sessionId))

    log.info('[search]','ipc:response', { searchId: id, resultCount: filteredResults.length, totalFound: results.length })
    return filteredResults
  })

  // ============================================================
  // Session Info Panel (files, notes, file watching)
  // ============================================================

  // Get files in session directory (recursive tree structure)
  server.handle(RPC_CHANNELS.sessions.GET_FILES, async (ctx, sessionId: string) => {
    if (sessionOutsideActiveScope(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))) return []
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return []

    try {
      return await scanSessionDirectory(sessionPath)
    } catch (error) {
      log.error('Failed to get session files:', error)
      return []
    }
  })

  // Start watching a session directory for file changes (per client)
  server.handle(RPC_CHANNELS.sessions.WATCH_FILES, async (ctx, sessionId: string) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    const clientId = ctx.clientId
    // R33-1: the caller's Workspace is captured at watch time and
    // revalidated before EVERY publish, so an installed watcher whose
    // account/space authorization changed (replacement, revoke) can never
    // keep publishing into a renderer that must no longer see the session.
    const callerWorkspaceId = resolveCallerWorkspaceId(ctx)
    cleanupSessionFileWatchForClient(clientId)

    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return

    try {
      const state: ClientSessionWatchState = {
        watcher: null as unknown as SessionFileWatcher,
        sessionId,
        debounceTimer: null,
      }

      const onChange = (_eventType: string, filename: string | Buffer | null) => {
        // Ignore internal files and hidden files
        const normalizedFilename = filename?.toString()
        if (
          normalizedFilename
          && (
            normalizedFilename.includes('session.jsonl')
            || normalizedFilename.startsWith('.')
          )
        ) {
          return
        }

        // Debounce: wait 100ms before notifying to batch rapid changes
        if (state.debounceTimer) {
          clearTimeout(state.debounceTimer)
        }

        state.debounceTimer = setTimeout(() => {
          // Authorization revalidation BEFORE the publish: the watcher is
          // torn down the moment its session leaves the trusted scope.
          if (sessionOutsideActiveScope(sessionManager, sessionId, callerWorkspaceId)) {
            cleanupSessionFileWatchForClient(clientId)
            return
          }
          pushTyped(server, RPC_CHANNELS.sessions.FILES_CHANGED, { to: 'client', clientId }, state.sessionId)
        }, 100)
      }
      if (deps.sessionFileWatchFactory) {
        state.watcher = deps.sessionFileWatchFactory(
          sessionPath,
          { recursive: true },
          onChange,
        )
      } else {
        const { watch } = await import('fs')
        state.watcher = watch(sessionPath, { recursive: true }, onChange)
      }

      clientSessionWatches.set(clientId, state)
    } catch (error) {
      log.error('Failed to start session file watcher:', error)
    }
  })

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId)
  })

  // Get session notes (reads notes.md from session directory)
  server.handle(RPC_CHANNELS.sessions.GET_NOTES, async (ctx, sessionId: string) => {
    if (sessionOutsideActiveScope(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))) return ''
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) return ''

    try {
      const notesPath = join(sessionPath, 'notes.md')
      const content = await readFile(notesPath, 'utf-8')
      return content
    } catch {
      // File doesn't exist yet - return empty string
      return ''
    }
  })

  // Set session notes (writes to notes.md in session directory)
  server.handle(RPC_CHANNELS.sessions.SET_NOTES, async (ctx, sessionId: string, content: string) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    assertOnlineBusinessSurface()
    const sessionPath = sessionManager.getSessionPath(sessionId)
    if (!sessionPath) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    try {
      const notesPath = join(sessionPath, 'notes.md')
      await writeFile(notesPath, content, 'utf-8')
    } catch (error) {
      log.error('Failed to save session notes:', error)
      throw error
    }
  })

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(RPC_CHANNELS.sessions.EXPORT, async (ctx, sessionId: string) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const bundle = await sessionManager.exportSession(sessionId, workspaceId)
    if (!bundle) throw new Error(`Failed to export session ${sessionId}`)
    return bundle
  })

  // Import a session bundle into the CALLER's Main-owned Workspace (R34-1).
  // The destination is bound to the caller's Workspace binding — direct RPC
  // and chunked-transfer commits (transfer:COMMIT re-enters this handler
  // with the committing client's context) can never import into a workspace
  // the caller is not in, and a caller without a resolvable Workspace fails
  // closed before any read or write.
  const importHandler = async (ctx: RequestContext, targetWorkspaceId: string, bundle: unknown, mode: string) => {
    if (!getRuntimeActiveProductSpace()) {
      throw new Error(PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
    const callerWorkspaceId = resolveCallerWorkspaceId(ctx)
    if (!callerWorkspaceId || callerWorkspaceId !== targetWorkspaceId) {
      throw new Error(PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
    assertOnlineBusinessSurface()
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    if (mode !== 'move' && mode !== 'fork') throw new Error(`Invalid dispatch mode: ${mode}`)

    return sessionManager.importSession(targetWorkspaceId, bundle as import('@polo-ai/shared/sessions').SessionBundle, mode)
  }
  server.handle(RPC_CHANNELS.sessions.IMPORT, async (ctx, ...rest: unknown[]) => {
    return importHandler(ctx, ...(rest as [string, unknown, string]))
  })
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler)

  // Export a session as a summarized remote-transfer payload.
  server.handle(RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER, async (ctx, sessionId: string) => {
    assertSessionScopeAllowed(sessionManager, sessionId, resolveCallerWorkspaceId(ctx))
    await sessionManager.waitForInit()
    const workspaceId = ctx.workspaceId ?? deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!)
    if (!workspaceId) throw new Error('No workspace context')

    const payload = await sessionManager.exportRemoteSessionTransfer(sessionId, workspaceId)
    if (!payload) throw new Error(`Failed to export remote transfer for session ${sessionId}`)
    return payload
  })

  // Import a summarized remote-transfer payload into the CALLER's
  // Main-owned Workspace (R34-1) — never a renderer-selected destination.
  server.handle(RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER, async (ctx, targetWorkspaceId: string, payload: import('@polo-ai/shared/protocol').RemoteSessionTransferPayload) => {
    if (!getRuntimeActiveProductSpace()) {
      throw new Error(PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
    const callerWorkspaceId = resolveCallerWorkspaceId(ctx)
    if (!callerWorkspaceId || callerWorkspaceId !== targetWorkspaceId) {
      throw new Error(PRODUCT_SPACE_CONTEXT_REQUIRED)
    }
    assertOnlineBusinessSurface()
    await sessionManager.waitForInit()
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string') throw new Error('targetWorkspaceId is required')
    return sessionManager.importRemoteSessionTransfer(targetWorkspaceId, payload)
  })
}
