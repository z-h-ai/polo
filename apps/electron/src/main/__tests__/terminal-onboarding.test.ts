import { describe, expect, it } from 'bun:test'
import type { MessageBoxOptions } from 'electron'
import {
  runTerminalOnboarding,
  type TerminalSetupCopy,
} from '../terminal-onboarding'
import type {
  TerminalIntegrationOptions,
  TerminalIntegrationStatus,
} from '../terminal-integration'

const terminalOptions: TerminalIntegrationOptions = {
  platform: 'darwin',
  resourcesPath: '/Applications/Polo AI.app/Contents/Resources',
  appExecutable: '/Applications/Polo AI.app/Contents/MacOS/Polo AI',
  appVersion: '0.10.0',
}

const copy: TerminalSetupCopy = {
  conflictTitle: 'Conflict',
  conflictMessage: 'Conflict message',
  conflictDetail: 'Open Settings',
  setupTitle: 'Complete setup',
  setupDetail: 'Setup detail',
  completeNow: 'Complete now',
  notNow: 'Not now',
  completeTitle: 'Complete',
  completeMessage: 'Setup complete',
  newTerminal: 'Open a new Terminal',
  failedTitle: 'Failed',
  failedMessage: 'Not ready',
  skippedTitle: 'Skipped',
  skippedMessage: 'Unavailable',
  skippedDetail: 'Retry or open Settings',
  retry: 'Retry',
  ok: 'OK',
  done: 'Done',
}

function status(overrides?: Partial<TerminalIntegrationStatus>): TerminalIntegrationStatus {
  return {
    supported: true,
    installed: false,
    pathReady: false,
    needsRepair: false,
    statusCode: 'not_installed',
    launcherPath: '/Users/test/.local/bin/polo',
    ...overrides,
  }
}

describe('terminal onboarding', () => {
  it('does readiness detection without writing on later startup', async () => {
    let installs = 0
    let dialogs = 0
    const result = await runTerminalOnboarding({
      terminalOptions,
      copy,
      showMessageBox: async () => {
        dialogs++
        return { response: 0 }
      },
      dependencies: {
        getStatus: () => status({ installed: true, needsRepair: true }),
        install: () => {
          installs++
          return status()
        },
        wasDismissed: () => true,
      },
    })

    expect(result.needsRepair).toBe(true)
    expect(installs).toBe(0)
    expect(dialogs).toBe(0)
  })

  it('does not show success when command verification remains incomplete', async () => {
    const dialogs: MessageBoxOptions[] = []
    const dismissed: boolean[] = []
    const result = await runTerminalOnboarding({
      terminalOptions,
      copy,
      showMessageBox: async (options) => {
        dialogs.push(options)
        return { response: dialogs.length === 1 ? 0 : 1 }
      },
      dependencies: {
        getStatus: () => status(),
        install: () => status({
          installed: true,
          needsRepair: true,
          statusCode: 'repair_required',
        }),
        wasDismissed: () => false,
        setDismissed: (_options, value) => dismissed.push(value),
      },
    })

    expect(result.pathReady).toBe(false)
    expect(result.needsRepair).toBe(true)
    expect(dialogs.map((dialog) => dialog.title)).toEqual(['Complete setup', 'Failed'])
    expect(dialogs.some((dialog) => dialog.title === 'Complete')).toBe(false)
    expect(dialogs[1]?.buttons).toEqual(['Retry', 'Not now'])
    expect(dismissed).toEqual([])
  })

  it('retries only after an explicit click and succeeds after full verification', async () => {
    const dialogs: MessageBoxOptions[] = []
    const dismissed: boolean[] = []
    let installs = 0
    const ready = status({
      installed: true,
      pathReady: true,
      needsRepair: false,
      statusCode: 'ready',
    })

    const result = await runTerminalOnboarding({
      terminalOptions,
      copy,
      showMessageBox: async (options) => {
        dialogs.push(options)
        if (options.title === 'Complete') return { response: 0 }
        return { response: 0 }
      },
      dependencies: {
        getStatus: () => status(),
        install: () => {
          installs++
          return installs === 1
            ? status({ installed: true, needsRepair: true, statusCode: 'repair_required' })
            : ready
        },
        wasDismissed: () => false,
        setDismissed: (_options, value) => dismissed.push(value),
      },
    })

    expect(installs).toBe(2)
    expect(result).toBe(ready)
    expect(dialogs.map((dialog) => dialog.title)).toEqual([
      'Complete setup',
      'Failed',
      'Complete',
    ])
    expect(dismissed).toEqual([false])
  })

  it('keeps a conflict incomplete and provides a retry entry', async () => {
    let installs = 0
    let dismissed = false
    const dialogs: MessageBoxOptions[] = []
    const conflict = status({
      conflict: { code: 'command_conflict', path: '/opt/tools/polo' },
      statusCode: 'command_conflict',
      statusParams: { path: '/opt/tools/polo' },
    })

    const result = await runTerminalOnboarding({
      terminalOptions,
      copy,
      showMessageBox: async (options) => {
        dialogs.push(options)
        return { response: 1 }
      },
      dependencies: {
        getStatus: () => conflict,
        install: () => {
          installs++
          return status()
        },
        wasDismissed: () => false,
        setDismissed: () => {
          dismissed = true
        },
      },
    })

    expect(result).toBe(conflict)
    expect(installs).toBe(0)
    expect(dismissed).toBe(false)
    expect(dialogs[0]?.buttons).toEqual(['Retry', 'OK'])
    expect(dialogs[0]?.detail).toContain('Open Settings')
  })
})
