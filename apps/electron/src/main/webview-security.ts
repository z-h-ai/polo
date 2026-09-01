import { app, session, shell } from 'electron'
import { classifyExternalUrl, formatBlockedUrlError } from '@polo-ai/shared/utils/url-safety'
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager'
import { describeUrlForLog } from './deep-link-log'
import { windowLog } from './logger'
import {
  isTabAppPartition,
  tabAppPartitionForScope,
} from '../shared/tab-browser-partition'

const allow = new Set([
  'fullscreen',
  'pointerLock',
  'window-management',
  'notifications',
  'geolocation',
  'media',
  'clipboard-read',
  'clipboard-sanitized-write',
  'idle-detection',
])

const handledPartitions = new Set<string>()

/**
 * Installs the webview permission policy on a session partition. The base
 * browser-pane partition is handled eagerly; ProductSpace-scoped tab-app
 * partitions are attached when their guest webview is created — before the
 * guest's first navigation.
 */
function attachWebviewPermissionHandlers(partitionName: string): void {
  if (handledPartitions.has(partitionName)) return
  handledPartitions.add(partitionName)
  const ses = session.fromPartition(partitionName)

  if (typeof ses.setPermissionCheckHandler === 'function') {
    ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
      const allowed = allow.has(permission)
      if (!allowed) {
        windowLog.warn(
          `[webview-security] permission check denied: ${permission}`,
          describeUrlForLog(requestingOrigin),
        )
      }
      return allowed
    })
  }

  if (typeof ses.setPermissionRequestHandler === 'function') {
    ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      const allowed = allow.has(permission)
      if (!allowed) {
        const requestingOrigin = (
          details as { requestingOrigin?: string } | undefined
        )?.requestingOrigin ?? 'unknown'
        windowLog.warn(
          `[webview-security] permission request denied: ${permission}`,
          describeUrlForLog(requestingOrigin),
        )
      }
      callback(allowed)
    })
  }
}

interface WebviewScopeResolver {
  getWorkspaceForWebContentsId?: (webContentsId: number) => string | null
  getAccountId?: () => Promise<string | null> | string | null
  getProductSpaceId?: () => string | null
}

const trustedWebviewScopeResolver: WebviewScopeResolver = {}

/**
 * Wires the Main-trusted scope resolver (window manager + Admin account +
 * ProductSpace fence). Called from the app bootstrap; without it scoped
 * tab-app partitions cannot be identified and simply receive no policy —
 * which is fail-closed for webviews, since the browser-pane base partition
 * policy is installed regardless.
 */
export function setWebviewScopeResolver(resolver: WebviewScopeResolver): void {
  trustedWebviewScopeResolver.getWorkspaceForWebContentsId = resolver.getWorkspaceForWebContentsId
  trustedWebviewScopeResolver.getAccountId = resolver.getAccountId
  trustedWebviewScopeResolver.getProductSpaceId = resolver.getProductSpaceId
}

/** Test seam: resets the handled-partition cache and the scope resolver. */
export function __resetWebviewSecurityForTests(): void {
  handledPartitions.clear()
  delete trustedWebviewScopeResolver.getWorkspaceForWebContentsId
  delete trustedWebviewScopeResolver.getAccountId
  delete trustedWebviewScopeResolver.getProductSpaceId
}

export function installWebviewSecurityHandlers(): void {
  attachWebviewPermissionHandlers(BROWSER_PANE_SESSION_PARTITION)

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

    // Tab webapps run in per-account+ProductSpace+Workspace partitions. The
    // Electron Session type does not expose its partition name, so the
    // partition is re-derived here from Main-trusted state and the policy
    // is installed before the guest navigates.
    void Promise.resolve(trustedWebviewScopeResolver.getAccountId?.() ?? null)
      .then(accountId => {
        const host = contents.hostWebContents
        if (!host || !accountId) return
        const workspaceId = trustedWebviewScopeResolver.getWorkspaceForWebContentsId?.(host.id)
        const productSpaceId = trustedWebviewScopeResolver.getProductSpaceId?.()
        if (!workspaceId || !productSpaceId) return
        const partition = tabAppPartitionForScope({ accountId, productSpaceId, workspaceId })
        if (isTabAppPartition(partition)) {
          attachWebviewPermissionHandlers(partition)
        }
      })
      .catch(() => {
        // Resolver failures are fail-closed: no policy attach happens for an
        // unresolvable scope.
      })

    contents.setWindowOpenHandler((details) => {
      const classification = classifyExternalUrl(details.url)
      if (classification.kind === 'dangerous' || classification.kind === 'internal-deeplink') {
        const reason = classification.kind === 'internal-deeplink'
          ? 'internal_deeplink'
          : formatBlockedUrlError(classification)
        windowLog.warn(
          `[webview-security] blocked popup: ${reason}`,
          describeUrlForLog(details.url),
        )
        return { action: 'deny' }
      }

      void shell.openExternal(details.url).catch((error) => {
        windowLog.warn(
          `[webview-security] failed to open popup externally: ${error instanceof Error ? error.message : String(error)}`,
          describeUrlForLog(details.url),
        )
      })
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return
      } catch {
        // Invalid URLs fall through to blocking.
      }

      event.preventDefault()
      windowLog.warn(
        '[webview-security] blocked navigation',
        describeUrlForLog(url),
      )
    })
  })
}
