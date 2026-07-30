import type { MessageBoxOptions } from 'electron'
import {
  getTerminalIntegrationStatus,
  installTerminalIntegration,
  setTerminalSetupDismissed,
  toTerminalIntegrationErrorPayload,
  wasTerminalSetupDismissed,
  type TerminalIntegrationOptions,
  type TerminalIntegrationStatus,
} from './terminal-integration'
import type { TerminalIntegrationErrorPayload } from '../shared/types'

export interface TerminalSetupCopy {
  conflictTitle: string
  conflictMessage: string
  conflictDetail: string
  setupTitle: string
  setupDetail: string
  completeNow: string
  notNow: string
  completeTitle: string
  completeMessage: string
  newTerminal: string
  failedTitle: string
  failedMessage: string
  skippedTitle: string
  skippedMessage: string
  skippedDetail: string
  retry: string
  ok: string
  done: string
}

interface TerminalOnboardingDependencies {
  getStatus?: (options: TerminalIntegrationOptions) => TerminalIntegrationStatus
  install?: (options: TerminalIntegrationOptions) => TerminalIntegrationStatus
  wasDismissed?: (options: TerminalIntegrationOptions) => boolean
  setDismissed?: (options: TerminalIntegrationOptions, dismissed: boolean) => void
}

export interface TerminalOnboardingOptions {
  terminalOptions: TerminalIntegrationOptions
  copy: TerminalSetupCopy
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  formatError: (error: TerminalIntegrationErrorPayload) => string
  logError?: (error: unknown) => void
  dependencies?: TerminalOnboardingDependencies
}

export function isTerminalIntegrationReady(status: TerminalIntegrationStatus): boolean {
  return status.installed
    && status.pathReady
    && !status.needsRepair
    && !status.conflict
}

/**
 * Readiness is always checked before prompting, but no launcher or shell file is
 * changed until the user explicitly chooses Complete/Retry.
 */
export async function runTerminalOnboarding({
  terminalOptions,
  copy,
  showMessageBox,
  formatError,
  logError = error => console.error('[terminal-integration] onboarding failed', error),
  dependencies,
}: TerminalOnboardingOptions): Promise<TerminalIntegrationStatus | null> {
  const getStatus = dependencies?.getStatus ?? getTerminalIntegrationStatus
  const install = dependencies?.install ?? installTerminalIntegration
  const wasDismissed = dependencies?.wasDismissed ?? wasTerminalSetupDismissed
  const setDismissed = dependencies?.setDismissed ?? setTerminalSetupDismissed

  const showMessageBoxSafely = async (
    options: MessageBoxOptions,
  ): Promise<{ response: number } | null> => {
    try {
      return await showMessageBox(options)
    } catch (error) {
      logError(error)
      return null
    }
  }

  const showFailure = async (
    failure: TerminalIntegrationErrorPayload,
  ): Promise<'retry' | 'stop'> => {
    const choice = await showMessageBoxSafely({
      type: 'error',
      title: copy.failedTitle,
      message: copy.failedMessage,
      detail: `${formatError(failure)}\n\n${copy.skippedDetail}`,
      buttons: [copy.retry, copy.notNow],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    return choice?.response === 0 ? 'retry' : 'stop'
  }

  let status: TerminalIntegrationStatus | null = null
  while (status === null) {
    try {
      status = getStatus(terminalOptions)
    } catch (error) {
      logError(error)
      const action = await showFailure({
        errorCode: 'status_failed',
        errorParams: { operation: 'status' },
      })
      if (action !== 'retry') return null
    }
  }

  let dismissed = false
  try {
    dismissed = wasDismissed(terminalOptions)
  } catch (error) {
    // A damaged dismissal preference must not block application startup.
    logError(error)
  }
  if (isTerminalIntegrationReady(status) || dismissed) return status

  if (status.conflict) {
    const choice = await showMessageBoxSafely({
      type: 'warning',
      title: copy.conflictTitle,
      message: copy.conflictMessage,
      detail: `${status.conflict.path}\n\n${copy.conflictDetail}`,
      buttons: [copy.retry, copy.ok],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice?.response !== 0) return status
  } else {
    const choice = await showMessageBoxSafely({
      type: 'info',
      title: copy.setupTitle,
      message: copy.setupTitle,
      detail: copy.setupDetail,
      buttons: [copy.completeNow, copy.notNow],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (!choice) return status
    if (choice.response !== 0) {
      try {
        setDismissed(terminalOptions, true)
      } catch (error) {
        logError(error)
      }
      await showMessageBoxSafely({
        type: 'warning',
        title: copy.skippedTitle,
        message: copy.skippedMessage,
        detail: copy.skippedDetail,
        buttons: [copy.ok],
      })
      return status
    }
  }

  while (true) {
    let failure: TerminalIntegrationErrorPayload | undefined
    try {
      status = install(terminalOptions)
    } catch (error) {
      logError(error)
      failure = toTerminalIntegrationErrorPayload(error, 'install')
      try {
        status = getStatus(terminalOptions)
      } catch (refreshError) {
        logError(refreshError)
        failure = {
          errorCode: 'status_failed',
          errorParams: { operation: 'status' },
        }
      }
    }

    if (isTerminalIntegrationReady(status)) {
      try {
        setDismissed(terminalOptions, false)
      } catch (error) {
        logError(error)
      }
      await showMessageBoxSafely({
        type: 'info',
        title: copy.completeTitle,
        message: copy.completeMessage,
        detail: copy.newTerminal,
        buttons: [copy.done],
      })
      return status
    }

    const choice = await showMessageBoxSafely({
      type: 'error',
      title: copy.failedTitle,
      message: copy.failedMessage,
      detail: `${
        failure
          ? formatError(failure)
          : status.conflict?.path ?? copy.failedMessage
      }\n\n${copy.skippedDetail}`,
      buttons: [copy.retry, copy.notNow],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice?.response !== 0) {
      // Deliberately keep setup incomplete so a later launch or Settings action
      // can retry. Failure is not recorded as a successful/dismissed setup.
      return status
    }
  }
}
