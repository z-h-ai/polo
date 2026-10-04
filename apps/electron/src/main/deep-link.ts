/**
 * Deep Link Handler
 *
 * Parses poloai:// URLs and routes to appropriate actions.
 *
 * URL Formats (workspace is optional - uses active window if omitted):
 *
 * Compound format (hierarchical navigation):
 *   poloai://allSessions[/session/{sessionId}]            - Session list (all sessions)
 *   poloai://flagged[/session/{sessionId}]             - Session list (flagged filter)
 *   poloai://state/{stateId}[/session/{sessionId}]     - Session list (state filter)
 *   poloai://sources[/source/{sourceSlug}]          - Sources list
 *   poloai://settings[/{subpage}]                   - Settings (general, shortcuts, preferences)
 *
 * Action format:
 *   poloai://action/{actionName}[/{id}][?params]
 *   poloai://workspace/{workspaceId}/action/{actionName}[?params]
 *
 * Organization join:
 *   poloai://join/{token}
 *
 * F1 circle web→desktop return (POO-70 B1):
 *   poloai://circle-return?v=1&circleId=<uuid>&membershipId=<uuid>&orderId=<uuid>
 *   - three ids optional, at least one required, strict UUID/param/version
 *     validation; recorded as the single pending navigation candidate and
 *     delivered via the typed circleReturn event + getPending RPC. Never a
 *     join/payment/authorization (P70-RETURN-BRIDGE-01/02/03).
 *
 * Legacy provider launch entry (compat only, F1 G6):
 *   polo://open - no params, no target: just launches/focuses the app.
 *   Any other polo:// shape is rejected.
 *
 * Actions:
 *   new-chat                  - Create new chat, optional ?input=text&name=name&send=true
 *                               If send=true is provided with input, immediately sends the message
 *   resume-sdk-session/{id}   - Resume Claude Code session by SDK session ID
 *   delete-session/{id}       - Delete session
 *   flag-session/{id}         - Flag session
 *   unflag-session/{id}       - Unflag session
 *
 * Examples:
 *   poloai://allSessions                               (all sessions view)
 *   poloai://allSessions/session/abc123                (specific session)
 *   poloai://settings/shortcuts                     (shortcuts page)
 *   poloai://sources/source/github                  (github source info)
 *   poloai://action/new-chat                        (uses active window)
 *   poloai://action/resume-sdk-session/{sdkId}      (resume Claude Code session)
 *   poloai://workspace/ws123/allSessions/session/abc123   (targets specific workspace)
 */

import type { BrowserWindow } from 'electron'
import { mainLog } from './logger'
import type { WindowManager } from './window-manager'
import { RPC_CHANNELS } from '../shared/types'
import type { EventSink } from '@polo-ai/server-core/transport'
import { isValidPoloaiCallbackId, isValidPoloUuid } from '../shared/types'
import {
  CIRCLE_RETURN_DEEP_LINK_HOST,
  CIRCLE_RETURN_PROTOCOL_VERSION,
  LEGACY_OPEN_DEEP_LINK_HOST,
  LEGACY_OPEN_DEEP_LINK_SCHEME,
} from '@polo-ai/shared/protocol'
import type { CircleReturnTargetIds } from '@polo-ai/shared/protocol'
import { describeDeepLinkForLog } from './deep-link-log'
import { captureCircleReturnAccountView, getCircleReturnCandidateStore } from './circle-return-candidate-store'

export interface DeepLinkTarget {
  /** Workspace ID - undefined means use active window */
  workspaceId?: string
  /** Compound route format (e.g., 'allSessions/session/abc123', 'settings/shortcuts') */
  view?: string
  /** Action route (e.g., 'new-chat', 'delete-session') */
  action?: string
  actionParams?: Record<string, string>
  callbackId?: string
  /** Window mode - if set, opens in a new window instead of navigating in existing */
  windowMode?: 'focused' | 'full'
  /** Right sidebar param (e.g., 'files/path/to/file', 'history') */
  rightSidebar?: string
  /** Opaque organization invitation/public-join token. */
  joinToken?: string
  /** Ask the client to refresh its ProductSpace list (no selection change). */
  productSpaceRefresh?: true
  /**
   * F1 versioned circle-return target ids (poloai://circle-return?...).
   * Ids only ADDRESS a page — never an authorization; the candidate is
   * recorded in the Main candidate store and delivered to the outer page
   * through the typed circleReturn event + pending RPC (P70-RETURN-BRIDGE-02).
   */
  circleReturn?: CircleReturnTargetIds
  /**
   * Legacy provider launch entry (polo://open, F1 G6): launch/focus
   * compatibility ONLY — no navigation target is derived from it
   * (P70-RETURN-BRIDGE-01).
   */
  legacyLaunch?: true
}

export interface DeepLinkResult {
  success: boolean
  error?: string
  windowId?: number
}

/**
 * Navigation payload sent to renderer via IPC
 */
export interface DeepLinkNavigation {
  /** Compound route format (e.g., 'allSessions/session/abc123', 'settings/shortcuts') */
  view?: string
  /** Action route (e.g., 'new-chat', 'delete-session') */
  action?: string
  actionParams?: Record<string, string>
  callbackId?: string
  joinToken?: string
  /** Ask the client to refresh its ProductSpace list (no selection change). */
  productSpaceRefresh?: true
}

/**
 * Parse window mode from URL search params
 */
function parseWindowMode(parsed: URL): 'focused' | 'full' | undefined {
  const windowParam = parsed.searchParams.get('window')
  if (windowParam === 'focused' || windowParam === 'full') {
    return windowParam
  }
  return undefined
}

/**
 * Parse right sidebar param from URL search params
 */
function parseRightSidebar(parsed: URL): string | undefined {
  return parsed.searchParams.get('sidebar') || undefined
}

function parseCallbackId(parsed: URL): string | undefined {
  const callbackId = parsed.searchParams.get('callbackId')
  return isValidPoloaiCallbackId(callbackId) ? callbackId : undefined
}

function isSupportedDeepLinkProtocol(protocol: string): boolean {
  const configuredScheme = process.env.POLO_AI_DEEPLINK_SCHEME || 'poloai'
  // The legacy provider scheme (polo://, F1 G6) is accepted at the protocol
  // level ONLY for the published no-target launch entry — see parseDeepLink.
  const schemes = new Set(
    ['poloai', LEGACY_OPEN_DEEP_LINK_SCHEME, configuredScheme].map(scheme => scheme.toLowerCase()),
  )
  return schemes.has(protocol.replace(/:$/, '').toLowerCase())
}

/**
 * Strict parse of the F1 versioned circle-return target
 * (poloai://circle-return?v=1&circleId=<uuid>&membershipId=<uuid>&orderId=<uuid>).
 * Fail closed (P70-RETURN-BRIDGE-02): any path segment, duplicate parameter,
 * unknown parameter, non-UUID id, unsupported protocol version, or a link
 * with no target id at all is rejected.
 */
function parseCircleReturnTarget(pathParts: string[], parsed: URL): CircleReturnTargetIds | null {
  if (pathParts.length !== 0) return null

  const params = parsed.searchParams

  // Duplicate parameters fail closed across the board — including `v`
  // (`?v=1&v=2` must never be resolved by picking the first value).
  const versionValues = params.getAll('v')
  if (versionValues.length > 1) return null
  const versionParam = versionValues[0] ?? null
  // Absent version = current protocol (first-adoption tolerance); an
  // explicit version must match exactly — never guess across versions.
  if (versionParam !== null && versionParam !== String(CIRCLE_RETURN_PROTOCOL_VERSION)) {
    return null
  }

  const ids: CircleReturnTargetIds = {}
  for (const key of ['circleId', 'membershipId', 'orderId'] as const) {
    const values = params.getAll(key)
    if (values.length === 0) continue
    if (values.length > 1) return null
    const value = values[0]!
    if (!isValidPoloUuid(value)) return null
    ids[key] = value
  }

  if (ids.circleId === undefined && ids.membershipId === undefined && ids.orderId === undefined) {
    return null
  }

  const ALLOWED_PARAMS = new Set(['v', 'circleId', 'membershipId', 'orderId'])
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) return null
  }

  return ids
}

/**
 * Parse a deep link URL into structured target
 */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  try {
    const parsed = new URL(url)

    if (!isSupportedDeepLinkProtocol(parsed.protocol)) {
      return null
    }

    // For custom protocols, the hostname contains the first path segment
    // e.g., poloai://workspace/ws123 → hostname='workspace', pathname='/ws123'
    // e.g., poloai://allSessions/chat/abc → hostname='allSessions', pathname='/chat/abc'
    const host = parsed.hostname
    const pathParts = parsed.pathname.split('/').filter(Boolean)
    const windowMode = parseWindowMode(parsed)
    const rightSidebar = parseRightSidebar(parsed)
    const callbackId = parseCallbackId(parsed)

    // poloai://auth-callback?... (OAuth callbacks - return null to let existing handler process)
    if (host === 'auth-callback') {
      return null
    }

    // Legacy published provider entry: polo://open (F1 G6, P70-RETURN-BRIDGE-01).
    // Launch/focus compatibility ONLY — the provider link carries no params,
    // so no order/circle target is ever guessed from it. Any other polo://
    // shape (including a return target under the legacy scheme) fails closed.
    if (parsed.protocol.replace(/:$/, '').toLowerCase() === LEGACY_OPEN_DEEP_LINK_SCHEME) {
      const hasParams = [...parsed.searchParams.keys()].length > 0
      if (host === LEGACY_OPEN_DEEP_LINK_HOST && pathParts.length === 0 && !hasParams) {
        return { workspaceId: undefined, legacyLaunch: true }
      }
      return null
    }

    // poloai://circle-return?v=1&circleId=…&membershipId=…&orderId=… — the F1
    // versioned web→desktop return target (P70-RETURN-BRIDGE-02). The ids are
    // strict UUIDs; anything else about the link fails closed.
    if (host === CIRCLE_RETURN_DEEP_LINK_HOST) {
      const circleReturn = parseCircleReturnTarget(pathParts, parsed)
      if (!circleReturn) return null
      return { workspaceId: undefined, circleReturn }
    }

    if (host === 'join') {
      if (pathParts.length !== 1) return null
      const joinToken = decodeURIComponent(pathParts[0] ?? '')
      if (!joinToken) return null
      return {
        workspaceId: undefined,
        joinToken,
        windowMode,
      }
    }

    // poloai://product-spaces/refresh — enterprise creation or invite
    // completion asks the client to refresh the space list. It never changes
    // the current ProductSpace selection.
    if (host === 'product-spaces' && pathParts[0] === 'refresh') {
      return {
        workspaceId: undefined,
        productSpaceRefresh: true,
        windowMode,
      }
    }

    // Compound route prefixes
    const COMPOUND_ROUTE_PREFIXES = [
      'allSessions', 'flagged', 'state', 'sources', 'settings', 'skills'
    ]

    // poloai://allSessions/..., poloai://settings/..., etc. (compound routes)
    if (COMPOUND_ROUTE_PREFIXES.includes(host)) {
      // Reconstruct the full compound route from host + pathname
      const viewRoute = pathParts.length > 0 ? `${host}/${pathParts.join('/')}` : host
      return {
        workspaceId: undefined,
        view: viewRoute,
        windowMode,
        rightSidebar,
      }
    }

    // poloai://workspace/{workspaceId}/... (with workspace targeting)
    if (host === 'workspace') {
      const workspaceId = pathParts[0]
      if (!workspaceId) return null

      const result: DeepLinkTarget = { workspaceId, windowMode, rightSidebar }

      // Check what type of route follows the workspace ID
      const routeType = pathParts[1]

      // Parse compound routes: /workspace/{id}/{compoundRoute}
      // e.g., /workspace/ws123/allSessions/session/abc123
      if (routeType && COMPOUND_ROUTE_PREFIXES.includes(routeType)) {
        const viewRoute = pathParts.slice(1).join('/')
        result.view = viewRoute
        return result
      }

      // Parse /action/{actionName}/...
      if (routeType === 'action') {
        result.action = pathParts[2]
        result.actionParams = {}
        result.callbackId = callbackId
        // Handle path-based ID (e.g., /action/delete-session/{sessionId})
        if (pathParts[3]) {
          result.actionParams.id = pathParts[3]
        }
        parsed.searchParams.forEach((value, key) => {
          // Skip the window and sidebar params - they're handled separately
          if (key !== 'window' && key !== 'sidebar' && key !== 'callbackId') {
            result.actionParams![key] = value
          }
        })
        return result
      }

      return result
    }

    // poloai://action/... (no workspace - uses active window)
    if (host === 'action') {
      const result: DeepLinkTarget = {
        workspaceId: undefined,
        action: pathParts[0],
        actionParams: {},
        callbackId,
        windowMode,
        rightSidebar,
      }

      if (pathParts[1]) {
        result.actionParams!.id = pathParts[1]
      }

      parsed.searchParams.forEach((value, key) => {
        // Skip the window and sidebar params - they're handled separately
        if (key !== 'window' && key !== 'sidebar' && key !== 'callbackId') {
          result.actionParams![key] = value
        }
      })

      return result
    }

    return null
  } catch {
    mainLog.error('[DeepLink] Failed to parse URL', describeDeepLinkForLog(url))
    return null
  }
}

/**
 * Wait for window's renderer to signal ready
 */
function waitForWindowReady(window: BrowserWindow): Promise<void> {
  return new Promise((resolve) => {
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => {
        // TIMING NOTE: This 100ms delay allows React to mount and register
        // IPC listeners before we send the deep link. `did-finish-load` fires
        // when the HTML is loaded, but React's useEffect hooks haven't run yet.
        // A proper handshake (renderer signals "ready") would be cleaner but
        // adds complexity for minimal gain - this delay is sufficient for all
        // practical cases and only affects reload scenarios.
        setTimeout(resolve, 100)
      })
    } else {
      resolve()
    }
  })
}

/**
 * Build a deep link URL without the window query parameter
 */
function buildDeepLinkWithoutWindowParam(url: string): string {
  const parsed = new URL(url)
  parsed.searchParams.delete('window')
  return parsed.toString()
}

/**
 * Handle a deep link by navigating to the target
 */
export async function handleDeepLink(
  url: string,
  windowManager: WindowManager,
  sink?: EventSink,
  resolveClientId?: (webContentsId: number) => string | undefined,
  preferredClientId?: string,
  sourceWebContentsId?: number,
): Promise<DeepLinkResult> {
  const target = parseDeepLink(url)
  const logContext = describeDeepLinkForLog(url)

  if (!target) {
    // Return success for null targets (like auth-callback) - they're handled elsewhere
    if (url.includes('auth-callback')) {
      return { success: true }
    }
    return { success: false, error: 'Invalid deep link URL' }
  }

  mainLog.info('[DeepLink] Handling', logContext)

  if (target.action === 'send-message') {
    if (!target.callbackId || sourceWebContentsId == null) {
      return { success: false, error: 'send-message requires a valid callbackId and source webContents' }
    }

    const { getDeepLinkCallbackBridge } = await import('./deep-link-callback-bridge')
    const bridge = getDeepLinkCallbackBridge()
    const prepared = bridge.prepareSendMessage(target.callbackId, sourceWebContentsId, target.actionParams?.id)
    if (!prepared.ok) {
      bridge.sendError(target.callbackId, sourceWebContentsId, prepared.error)
      return { success: true }
    }
  } else if (target.callbackId && sourceWebContentsId != null) {
    const { getDeepLinkCallbackBridge } = await import('./deep-link-callback-bridge')
    const bridge = getDeepLinkCallbackBridge()
    const registered = bridge.registerCallback(target.callbackId, sourceWebContentsId)
    if (!registered.ok) {
      bridge.sendError(target.callbackId, sourceWebContentsId, registered.error)
      return { success: true }
    }
  }

  // If windowMode is set, create a new window instead of navigating in existing
  if (target.windowMode) {
    // Get workspaceId from target or from current window
    let wsId = target.workspaceId
    if (!wsId) {
      const focusedWindow = windowManager.getFocusedWindow()
      if (focusedWindow) {
        wsId = windowManager.getWorkspaceForWindow(focusedWindow.webContents.id) ?? undefined
      }
      if (!wsId) {
        const allWindows = windowManager.getAllWindows()
        if (allWindows.length > 0) {
          wsId = allWindows[0].workspaceId
        }
      }
    }

    if (!wsId) {
      mainLog.error('[DeepLink] No workspace available for new window', logContext)
      return { success: false, error: 'No workspace available for new window' }
    }

    // Build URL without window param for navigation inside the new window
    const navUrl = buildDeepLinkWithoutWindowParam(url)
    mainLog.info('[DeepLink] Creating new window', logContext)

    const window = windowManager.createWindow({
      workspaceId: wsId,
      focused: target.windowMode === 'focused',
      initialDeepLink: navUrl,
    })
    mainLog.info('[DeepLink] Window created', logContext)

    return { success: true, windowId: window.webContents.id }
  }

  // 1. Get target window (existing behavior for non-window-mode links)
  let window: BrowserWindow | null = null

  if (target.workspaceId) {
    // Workspace specified - focus or create window for that workspace
    window = windowManager.focusOrCreateWindow(target.workspaceId)
  } else {
    // No workspace - use focused window or last active
    window = windowManager.getFocusedWindow() ?? windowManager.getLastActiveWindow()

    if (!window) {
      // No windows at all - can't navigate without a workspace
      return { success: false, error: 'No active window to navigate' }
    }

    // Focus the window
    if (window.isMinimized()) {
      window.restore()
    }
    window.focus()
  }

  // 2. Wait for window to be ready (renderer loaded)
  await waitForWindowReady(window)

  // 2b. Circle-return candidate (P70-RETURN-BRIDGE-02/03): record the minimal
  // navigation candidate BEFORE any renderer subscription and push the typed
  // event. The store keeps the candidate pending until ack/cancel/logout, so
  // a late subscriber still reads the original target via getPending — no
  // fixed delay, no renderer-mount guessing. The event/record dedups by
  // candidateId on the consumer side; any event/read interleaving consumes
  // exactly once.
  if (target.circleReturn) {
    const store = getCircleReturnCandidateStore()
    const accountView = captureCircleReturnAccountView()
    // An in-flight account transition records an unbound (login-pending)
    // candidate — never an anchor to a dying account.
    const { candidate, duplicated } = store.recordCandidate(
      target.circleReturn,
      accountView.status === 'transition' ? { status: 'signed_out' } : accountView,
    )
    mainLog.info('[DeepLink] Circle-return candidate recorded', logContext, {
      candidateId: candidate.candidateId,
      duplicated,
    })

    if (sink) {
      // Same targeting precedence as NAVIGATE; the `all` fallback keeps the
      // event buffered for clients that reconnect mid-startup (the pending
      // RPC remains the authoritative late-subscription path).
      const wsId = target.workspaceId ?? windowManager.getWorkspaceForWindow(window.webContents.id)
      const resolvedClientId = resolveClientId?.(window.webContents.id)
      const clientId = resolvedClientId ?? (!resolveClientId ? preferredClientId : undefined)

      if (clientId) {
        sink(RPC_CHANNELS.circleReturn.CANDIDATE, { to: 'client', clientId }, candidate)
      } else if (wsId) {
        sink(RPC_CHANNELS.circleReturn.CANDIDATE, { to: 'workspace', workspaceId: wsId }, candidate)
      } else {
        sink(RPC_CHANNELS.circleReturn.CANDIDATE, { to: 'all' }, candidate)
      }
    }

    return { success: true, windowId: window.isDestroyed() ? -1 : window.webContents.id }
  }

  // 3. Send navigation command to renderer
  if (target.view || target.action || target.joinToken || target.productSpaceRefresh) {
    const navigation: DeepLinkNavigation = {
      view: target.view,
      action: target.action,
      actionParams: target.actionParams,
      callbackId: target.callbackId,
      joinToken: target.joinToken,
      productSpaceRefresh: target.productSpaceRefresh,
    }
    const wsId = target.workspaceId ?? windowManager.getWorkspaceForWindow(window.webContents.id)
    const resolvedClientId = resolveClientId?.(window.webContents.id)

    // Prefer the resolved target window client. Only use preferredClientId as
    // fallback when no resolver was provided (legacy call sites).
    const clientId = resolvedClientId ?? (!resolveClientId ? preferredClientId : undefined)

    if (sink && clientId) {
      sink(RPC_CHANNELS.deeplink.NAVIGATE, { to: 'client', clientId }, navigation)
    } else if (sink && wsId) {
      sink(RPC_CHANNELS.deeplink.NAVIGATE, { to: 'workspace', workspaceId: wsId }, navigation)
    }
  }

  return { success: true, windowId: window.isDestroyed() ? -1 : window.webContents.id }
}
