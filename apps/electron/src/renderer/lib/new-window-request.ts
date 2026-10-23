/**
 * POO-117 P117-05/P117-07 — renderer-side new-main-window request.
 *
 * Every avatar-menu / keyboard-shortcut entry shares this helper so the
 * request has one observable outcome path:
 *
 * - one in-flight request at a time (a second click while the window chain is
 *   still running would mint a duplicate request — the first click owns it);
 * - a failure never dies as a console-only log: it surfaces a toast with a
 *   reason-specific, retry-oriented message.
 *
 * Main-process-initiated requests (native menu, webview shortcut) have no
 * renderer caller to await — they report failures through the
 * `onMenuNewWindowFailed` broadcast, consumed in App.tsx with the same toasts.
 */

import { toast } from 'sonner'
import { i18n } from '@polo-ai/shared/i18n'
import type { NewWindowFailureReason } from '../../shared/types'

let requestInFlight = false

/** i18n keys resolved at call time (never at module level). */
const FAILURE_MESSAGE_KEYS: Record<NewWindowFailureReason, string> = {
  window_manager_missing: 'toast.newWindowFailedGeneric',
  workspace_unresolved: 'toast.newWindowFailedNoWorkspace',
  create_failed: 'toast.newWindowFailedCreate',
  show_timeout: 'toast.newWindowFailedTimeout',
  scope_unavailable: 'toast.newWindowFailedScope',
  show_failed: 'toast.newWindowFailedShow',
}

export function newWindowFailureMessage(reason: NewWindowFailureReason | undefined): string {
  return i18n.t(FAILURE_MESSAGE_KEYS[reason ?? 'window_manager_missing'])
}

/**
 * Request a new managed main window. Resolves after the observable outcome;
 * shows a toast on failure. Re-entrant calls while a request is still running
 * are dropped (the in-flight request owns the outcome).
 */
export async function requestNewMainWindow(): Promise<void> {
  if (requestInFlight) {
    console.debug('[new-window] request already in flight — dropping re-entry')
    return
  }
  requestInFlight = true
  try {
    const result = await window.electronAPI.menuNewWindow()
    if (!result.ok) {
      toast.error(newWindowFailureMessage(result.reason))
    }
  } catch (error) {
    // Transport-level rejection (channel missing, connection down) — still a
    // failed request, never a silent one.
    console.error('[new-window] request rejected:', error)
    toast.error(i18n.t('toast.newWindowFailedCreate'))
  } finally {
    requestInFlight = false
  }
}
