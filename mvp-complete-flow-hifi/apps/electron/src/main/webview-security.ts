import { app, session, shell } from 'electron'
import { classifyExternalUrl, formatBlockedUrlError } from '@polo-ai/shared/utils/url-safety'
import { BROWSER_PANE_SESSION_PARTITION } from './browser-pane-manager'
import { describeUrlForLog } from './deep-link-log'
import { windowLog } from './logger'

export function installWebviewSecurityHandlers(): void {
  const ses = session.fromPartition(BROWSER_PANE_SESSION_PARTITION)
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

  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'webview') return

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
