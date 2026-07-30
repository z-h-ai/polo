import type { MessageBoxOptions } from 'electron'
import {
  getTerminalIntegrationStatus,
  installTerminalIntegration,
  setTerminalSetupDismissed,
  wasTerminalSetupDismissed,
  type TerminalIntegrationOptions,
  type TerminalIntegrationStatus,
} from './terminal-integration'

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
  dependencies,
}: TerminalOnboardingOptions): Promise<TerminalIntegrationStatus> {
  const getStatus = dependencies?.getStatus ?? getTerminalIntegrationStatus
  const install = dependencies?.install ?? installTerminalIntegration
  const wasDismissed = dependencies?.wasDismissed ?? wasTerminalSetupDismissed
  const setDismissed = dependencies?.setDismissed ?? setTerminalSetupDismissed

  let status = getStatus(terminalOptions)
  if (isTerminalIntegrationReady(status) || wasDismissed(terminalOptions)) {
    return status
  }

  if (status.conflict) {
    const choice = await showMessageBox({
      type: 'warning',
      title: copy.conflictTitle,
      message: copy.conflictMessage,
      detail: `${status.conflict.path}\n\n${copy.conflictDetail}`,
      buttons: [copy.retry, copy.ok],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice.response !== 0) return status
  } else {
    const choice = await showMessageBox({
      type: 'info',
      title: copy.setupTitle,
      message: copy.setupTitle,
      detail: copy.setupDetail,
      buttons: [copy.completeNow, copy.notNow],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice.response !== 0) {
      setDismissed(terminalOptions, true)
      await showMessageBox({
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
    let failure: string | undefined
    try {
      status = install(terminalOptions)
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      status = getStatus(terminalOptions)
    }

    if (isTerminalIntegrationReady(status)) {
      setDismissed(terminalOptions, false)
      await showMessageBox({
        type: 'info',
        title: copy.completeTitle,
        message: copy.completeMessage,
        detail: copy.newTerminal,
        buttons: [copy.done],
      })
      return status
    }

    const choice = await showMessageBox({
      type: 'error',
      title: copy.failedTitle,
      message: copy.failedMessage,
      detail: `${failure ?? status.conflict?.path ?? copy.failedMessage}\n\n${copy.skippedDetail}`,
      buttons: [copy.retry, copy.notNow],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (choice.response !== 0) {
      // Deliberately keep setup incomplete so a later launch or Settings action
      // can retry. Failure is not recorded as a successful/dismissed setup.
      return status
    }
  }
}
