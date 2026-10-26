import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron'
import { i18n } from '@polo-ai/shared/i18n'
import type { LocalAppQuitGuardLogger } from './quit-guard'

/** Why the quit was cancelled — mirrors the two guarded shutdown paths in the
 * before-quit handler (local app runtimes, managed CLI brokers). */
export type QuitCancelReason = 'local-app-runtime' | 'cli-managed-broker'

export type QuitCancelPromptAction = 'retry' | 'continue'

export interface QuitCancelledPromptHost {
  showPrompt(reason: QuitCancelReason): Promise<QuitCancelPromptAction>
}

/**
 * Single-flight presentation for the quit-cancelled dialog. While a dialog is
 * open, repeated before-quit cancellations must NOT stack another one: the
 * caller focuses-or-ignores (we ignore; the open dialog stays the single
 * decision surface). The active slot clears once the user answers, so the
 * next real cancellation can present again.
 */
export class QuitCancelPromptCoordinator {
  private activePrompt?: Promise<QuitCancelPromptAction>

  present(
    reason: QuitCancelReason,
    host: QuitCancelledPromptHost,
  ): Promise<QuitCancelPromptAction> | undefined {
    if (this.activePrompt) return undefined
    const promise = host.showPrompt(reason).finally(() => {
      if (this.activePrompt === promise) this.activePrompt = undefined
    })
    this.activePrompt = promise
    return promise
  }

  isPresenting(): boolean {
    return this.activePrompt !== undefined
  }
}

/** Localized system dialog explaining why the quit was cancelled, offering
 * "retry quit" (re-runs the guarded shutdown) vs "keep using the app".
 * i18n is resolved inside the function per the main-process convention
 * (see phone-auth-challenge-window.ts). */
export async function showQuitCancelledDialog(
  reason: QuitCancelReason,
): Promise<QuitCancelPromptAction> {
  const messageKey = reason === 'local-app-runtime'
    ? 'appQuit.cancelled.localAppMessage'
    : 'appQuit.cancelled.cliBrokerMessage'
  const options: MessageBoxOptions = {
    type: 'warning',
    title: i18n.t('appQuit.cancelled.title'),
    message: i18n.t(messageKey),
    detail: i18n.t('appQuit.cancelled.detail'),
    buttons: [
      i18n.t('appQuit.cancelled.retry'),
      i18n.t('appQuit.cancelled.continue'),
    ],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  }
  const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  // Escape / close resolve to cancelId → 'continue': the app must always end
  // up fully interactive, never stuck half-quitting.
  const { response } = owner
    ? await dialog.showMessageBox(owner, options)
    : await dialog.showMessageBox(options)
  return response === 0 ? 'retry' : 'continue'
}

export const quitCancelPrompts = new QuitCancelPromptCoordinator()

/**
 * React to a cancelled quit: present the localized dialog (single-flight) and
 * dispatch the user's choice. "retry" re-enters app.quit() which re-runs the
 * guarded cleanup — exit is still only allowed once shutdown succeeds; this
 * deliberately adds NO force-quit path that bypasses cleanup.
 */
export function handleQuitCancellation(
  reason: QuitCancelReason,
  logger: LocalAppQuitGuardLogger,
  onRetry: () => void = () => app.quit(),
): void {
  const action = quitCancelPrompts.present(reason, { showPrompt: showQuitCancelledDialog })
  if (!action) {
    logger.info('Quit-cancelled dialog already visible; ignoring repeated cancellation')
    return
  }
  void action.then((chosen) => {
    if (chosen === 'retry') {
      logger.info(`Retrying quit after cancelled cleanup (${reason})`)
      onRetry()
    } else {
      logger.info(`User chose to keep using the app after cancelled quit (${reason})`)
    }
  }).catch((error) => {
    logger.error('Quit-cancelled dialog failed:', error)
  })
}
