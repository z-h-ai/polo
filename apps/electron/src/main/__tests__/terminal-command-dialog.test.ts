import { describe, expect, it } from 'bun:test'
import type { MessageBoxOptions } from 'electron'
import { runTerminalCommandDialog } from '../terminal-command-dialog'
import type { TerminalIntegrationStatus } from '../terminal-integration'

const status = (overrides: Partial<TerminalIntegrationStatus> = {}): TerminalIntegrationStatus => ({
  supported: true, installed: false, pathReady: false, needsRepair: false,
  statusCode: 'not_installed', launcherPath: '/fixture/.local/bin/polo', ...overrides,
})
const ready = status({ installed: true, pathReady: true, statusCode: 'ready' })
const copy = {
  title: 'polo command', description: 'Internal AI needs no terminal setup',
  enableDetail: 'Creates ~/.local/bin/polo and a shell PATH block',
  enable: 'Enable', repair: 'Repair', disable: 'Disable', close: 'Close',
  retry: 'Retry', newTerminal: 'Open a new Terminal', failedTitle: 'Setup failed',
}

async function run({
  initial = status(), choices = [] as string[],
  getStatus, install, uninstall, setDismissed, dialogFails = false,
}: {
  initial?: TerminalIntegrationStatus
  choices?: string[]
  getStatus?: () => Promise<TerminalIntegrationStatus>
  install?: () => Promise<TerminalIntegrationStatus>
  uninstall?: () => Promise<TerminalIntegrationStatus>
  setDismissed?: (value: boolean) => void
  dialogFails?: boolean
} = {}) {
  const dialogs: MessageBoxOptions[] = []
  const operations: string[] = []
  const dismissed: boolean[] = []
  const errors: unknown[] = []
  await runTerminalCommandDialog({
    terminalOptions: { platform: 'darwin', resourcesPath: '/fixture/Resources', appExecutable: '/fixture/App', appVersion: '0.23.0' },
    copy, formatStatus: value => value.statusCode,
    formatError: error => error.errorCode, logError: error => errors.push(error),
    showMessageBox: async options => {
      dialogs.push(options)
      if (dialogFails) throw new Error('dialog unavailable')
      const choice = choices.shift() ?? 'Close'
      const response = options.buttons!.indexOf(choice)
      if (response === -1) throw new Error(`Unexpected choice ${choice}`)
      return { response }
    },
    dependencies: {
      getStatus: async () => { operations.push('status'); return getStatus ? getStatus() : initial },
      install: async () => { operations.push('install'); return install ? install() : ready },
      uninstall: async () => { operations.push('uninstall'); return uninstall ? uninstall() : status() },
      setDismissed: (_options, value) => { dismissed.push(value); setDismissed?.(value) },
    },
  })
  return { dialogs, operations, dismissed, errors }
}

describe('on-demand terminal command dialog', () => {
  it('only inspects when opened and closing leaves the shell alone', async () => {
    const result = await run()
    expect(result.operations).toEqual(['status'])
    expect(result.dismissed).toEqual([])
    expect(result.dialogs[0]?.buttons).toEqual(['Enable', 'Close'])
    expect(result.dialogs[0]?.detail).toContain(copy.description)
    expect(result.dialogs[0]?.detail).toContain(copy.enableDetail)
    expect(result.dialogs[0]?.defaultId).toBe(1)
  })

  it('installs only after Enable and shows verified readiness', async () => {
    const result = await run({ choices: ['Enable', 'Close'] })
    expect(result.operations).toEqual(['status', 'install'])
    expect(result.dismissed).toEqual([false])
    expect(result.dialogs[1]?.message).toBe('ready')
    expect(result.dialogs[1]?.detail).toContain(copy.newTerminal)
  })

  it('supports explicit repair and disable without treating an existing command as missing', async () => {
    const result = await run({
      initial: status({ installed: true, needsRepair: true, statusCode: 'repair_required' }),
      choices: ['Repair', 'Disable', 'Close'],
    })
    expect(result.dialogs[0]?.buttons).toEqual(['Repair', 'Disable', 'Close'])
    expect(result.operations).toEqual(['status', 'install', 'uninstall'])
    expect(result.dismissed).toEqual([false, true])
    expect(result.dialogs[2]?.message).toBe('not_installed')
  })

  it('leaves a working command alone until Disable is clicked', async () => {
    const result = await run({ initial: ready })
    expect(result.operations).toEqual(['status'])
    expect(result.dialogs[0]?.buttons).toEqual(['Disable', 'Close'])
  })

  it('keeps verified install success when legacy preference storage fails', async () => {
    const diagnostic = new Error('EISDIR: legacy terminal-setup.json is a directory')
    const result = await run({ choices: ['Enable', 'Close'], setDismissed: () => { throw diagnostic } })
    expect(result.operations).toEqual(['status', 'install'])
    expect(result.errors).toEqual([diagnostic])
    expect(result.dialogs[1]?.message).toBe('ready')
    expect(result.dialogs[1]?.detail).toContain(copy.newTerminal)
    expect(result.dialogs.some(dialog => dialog.title === copy.failedTitle)).toBe(false)
  })

  it('keeps verified disable success when legacy preference storage fails', async () => {
    const diagnostic = new Error('EACCES: legacy preference write denied')
    const result = await run({ initial: ready, choices: ['Disable', 'Close'], setDismissed: () => { throw diagnostic } })
    expect(result.operations).toEqual(['status', 'uninstall'])
    expect(result.errors).toEqual([diagnostic])
    expect(result.dialogs[1]?.message).toBe('not_installed')
    expect(result.dialogs[1]?.buttons).toEqual(['Enable', 'Close'])
    expect(result.dialogs.some(dialog => dialog.title === copy.failedTitle)).toBe(false)
  })

  it('rechecks conflicts without overwriting an unrelated polo command', async () => {
    const result = await run({
      initial: status({ conflict: { code: 'command_conflict', path: '/other/polo' }, statusCode: 'command_conflict' }),
      choices: ['Retry', 'Close'],
    })
    expect(result.operations).toEqual(['status', 'status'])
    expect(result.dialogs[0]?.buttons).toEqual(['Retry', 'Close'])
  })

  it('does not claim readiness or clear preferences after incomplete verification', async () => {
    const result = await run({ choices: ['Enable', 'Close'], install: async () => status({ installed: true, needsRepair: true, statusCode: 'repair_required' }) })
    expect(result.dismissed).toEqual([])
    expect(result.dialogs[1]?.message).toBe('repair_required')
    expect(result.dialogs[1]?.detail).not.toContain(copy.newTerminal)
  })

  it('localizes failures and retries installation only on an explicit click', async () => {
    let attempts = 0
    const result = await run({ choices: ['Enable', 'Retry', 'Close'], install: async () => {
      if (++attempts === 1) throw new Error('sensitive filesystem diagnostic')
      return ready
    } })
    expect(result.operations).toEqual(['status', 'install', 'install'])
    expect(result.errors).toHaveLength(1)
    expect(result.dialogs[1]?.detail).toContain('install_failed')
    expect(result.dialogs[1]?.detail).not.toContain('sensitive filesystem diagnostic')
    expect(result.dismissed).toEqual([false])
  })

  it('contains status and dialog failures without changing user files', async () => {
    const failed = await run({ getStatus: async () => { throw new Error('status diagnostic') } })
    expect(failed.operations).toEqual(['status'])
    expect(failed.dialogs[0]?.detail).toContain('status_failed')
    const brokenDialog = await run({ dialogFails: true })
    expect(brokenDialog.operations).toEqual(['status'])
    expect(brokenDialog.errors).toHaveLength(1)
  })

  it('does not offer mutations on platforms managed by their installer', async () => {
    const result = await run({ initial: status({ supported: false, statusCode: 'managed_by_installer' }) })
    expect(result.dialogs[0]?.buttons).toEqual(['Close'])
    expect(result.operations).toEqual(['status'])
  })
})
