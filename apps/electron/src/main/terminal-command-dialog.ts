import type { MessageBoxOptions } from 'electron'
import {
  getTerminalIntegrationStatus,
  installTerminalIntegration,
  setTerminalSetupDismissed,
  toTerminalIntegrationErrorPayload,
  uninstallTerminalIntegration,
  type TerminalIntegrationOptions,
  type TerminalIntegrationStatus,
} from './terminal-integration'
import type { TerminalIntegrationErrorPayload } from '../shared/types'

interface TerminalCommandCopy {
  title: string
  description: string
  enableDetail: string
  enable: string
  repair: string
  disable: string
  close: string
  retry: string
  newTerminal: string
  failedTitle: string
}

interface TerminalCommandDialogOptions {
  terminalOptions: TerminalIntegrationOptions
  copy: TerminalCommandCopy
  showMessageBox: (options: MessageBoxOptions) => Promise<{ response: number }>
  formatStatus: (status: TerminalIntegrationStatus) => string
  formatError: (error: TerminalIntegrationErrorPayload) => string
  logError: (error: unknown) => void
  dependencies?: {
    getStatus?: typeof getTerminalIntegrationStatus
    install?: typeof installTerminalIntegration
    uninstall?: typeof uninstallTerminalIntegration
    setDismissed?: typeof setTerminalSetupDismissed
  }
}

function ready(status: TerminalIntegrationStatus): boolean {
  return status.installed && status.pathReady && !status.needsRepair && !status.conflict
}

/** Only invoked from Help. Opening or closing this dialog never configures a shell. */
export async function runTerminalCommandDialog({
  terminalOptions, copy, showMessageBox, formatStatus, formatError, logError, dependencies,
}: TerminalCommandDialogOptions): Promise<void> {
  const getStatus = dependencies?.getStatus ?? getTerminalIntegrationStatus
  const install = dependencies?.install ?? installTerminalIntegration
  const uninstall = dependencies?.uninstall ?? uninstallTerminalIntegration
  const setDismissed = dependencies?.setDismissed ?? setTerminalSetupDismissed
  let operation: 'status' | 'install' | 'uninstall' = 'status'
  try {
    while (true) {
      let status: TerminalIntegrationStatus
      try {
        status = await ({ status: getStatus, install, uninstall })[operation](terminalOptions)
      } catch (error) {
        logError(error)
        const { response } = await showMessageBox({
          type: 'error', title: copy.failedTitle, message: copy.failedTitle,
          detail: `${formatError(toTerminalIntegrationErrorPayload(error, operation))}\n\n${copy.description}`,
          buttons: [copy.retry, copy.close], defaultId: 1, cancelId: 1, noLink: true,
        })
        if (response !== 0) return
        continue
      }

      // Legacy preferences do not control startup anymore. A failed compatibility
      // write must not turn verified command success into an install/remove error.
      try {
        if (operation === 'install' && ready(status)) setDismissed(terminalOptions, false)
        if (operation === 'uninstall' && !status.installed) setDismissed(terminalOptions, true)
      } catch (error) {
        logError(error)
      }

      if (!status.supported) {
        await showMessageBox({
          type: 'info', title: copy.title, message: copy.title,
          detail: formatStatus(status), buttons: [copy.close],
        })
        return
      }

      const actions: Array<'status' | 'install' | 'uninstall'> = []
      const buttons: string[] = []
      if (status.conflict) {
        actions.push('status')
        buttons.push(copy.retry)
      } else if (!ready(status)) {
        actions.push('install')
        buttons.push(status.installed ? copy.repair : copy.enable)
      }
      // A conflict can coexist with our launcher; removal still verifies ownership.
      if (status.installed) {
        actions.push('uninstall')
        buttons.push(copy.disable)
      }
      buttons.push(copy.close)
      const { response } = await showMessageBox({
        type: status.conflict ? 'warning' : 'info',
        title: copy.title, message: formatStatus(status),
        detail: [copy.description, copy.enableDetail, ready(status) ? copy.newTerminal : ''].filter(Boolean).join('\n\n'),
        buttons, defaultId: buttons.length - 1, cancelId: buttons.length - 1, noLink: true,
      })
      const next = actions[response]
      if (!next) return
      operation = next
    }
  } catch (error) {
    // A failed native dialog must never become an unhandled menu callback rejection.
    logError(error)
  }
}
