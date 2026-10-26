/**
 * Review #3 — quit-cancelled dialog decision logic.
 *
 * Mocks the electron boundary (same discipline as phone-auth-challenge-window
 * tests) and covers: single-flight presentation (a repeated cancelled quit
 * never stacks a second dialog), the retry path re-entering quit, the
 * continue path staying a no-op, the slot clearing after an answer, and the
 * electron message-box response mapping (including Escape → cancelId).
 */

import { describe, it, expect, mock, beforeEach } from 'bun:test'

const dialogCalls: Array<{ options: any; ownerWindow: any }> = []
let nextDialogResponse = 0
const quitCalls = mock(() => {})

mock.module('electron', () => ({
  app: { quit: quitCalls },
  BrowserWindow: {
    getFocusedWindow: mock(() => null),
    getAllWindows: mock(() => []),
  },
  dialog: {
    showMessageBox: mock(async (ownerOrOptions: any, maybeOptions?: any) => {
      const ownerWindow = maybeOptions ? ownerOrOptions : null
      const options = maybeOptions ?? ownerOrOptions
      dialogCalls.push({ options, ownerWindow })
      return { response: nextDialogResponse }
    }),
  },
}))

const i18nCalls: string[] = []
mock.module('@polo-ai/shared/i18n', () => ({
  i18n: {
    t: (key: string) => {
      i18nCalls.push(key)
      return `localized:${key}`
    },
  },
}))

const { QuitCancelPromptCoordinator, showQuitCancelledDialog, handleQuitCancellation } =
  await import('../quit-cancel-dialog')

const logger = { info: mock(() => {}), error: mock(() => {}) }

describe('QuitCancelPromptCoordinator', () => {
  it('is single-flight: a repeated cancelled quit never stacks a second dialog', async () => {
    const coordinator = new QuitCancelPromptCoordinator()
    let resolveFirst!: (action: 'retry' | 'continue') => void
    const host = mock((_reason: string) =>
      new Promise<'retry' | 'continue'>(resolve => { resolveFirst = resolve }))

    const first = coordinator.present('local-app-runtime', { showPrompt: host })
    const second = coordinator.present('cli-managed-broker', { showPrompt: host })

    expect(first).toBeDefined()
    expect(second).toBeUndefined()
    expect(host).toHaveBeenCalledTimes(1)
    expect(coordinator.isPresenting()).toBe(true)

    resolveFirst('continue')
    await first!
    expect(coordinator.isPresenting()).toBe(false)
  })

  it('presents again only after the previous dialog was answered', async () => {
    const coordinator = new QuitCancelPromptCoordinator()
    const host = mock(async () => 'continue' as const)

    await coordinator.present('local-app-runtime', { showPrompt: host })
    const retry = coordinator.present('cli-managed-broker', { showPrompt: host })
    expect(retry).toBeDefined()
    expect(host).toHaveBeenCalledTimes(2)
    expect((retry!)).resolves.toBe('continue')
  })
})

describe('showQuitCancelledDialog', () => {
  beforeEach(() => {
    dialogCalls.length = 0
    i18nCalls.length = 0
  })

  it('localizes all strings inside the call and maps response 0 to retry', async () => {
    nextDialogResponse = 0
    const action = await showQuitCancelledDialog('local-app-runtime')

    expect(action).toBe('retry')
    expect(i18nCalls).toContain('appQuit.cancelled.title')
    expect(i18nCalls).toContain('appQuit.cancelled.localAppMessage')
    expect(i18nCalls).toContain('appQuit.cancelled.detail')
    expect(i18nCalls).toContain('appQuit.cancelled.retry')
    expect(i18nCalls).toContain('appQuit.cancelled.continue')
    expect(i18nCalls).not.toContain('appQuit.cancelled.cliBrokerMessage')
    expect(dialogCalls[0]!.options.buttons).toEqual([
      'localized:appQuit.cancelled.retry',
      'localized:appQuit.cancelled.continue',
    ])
    expect(dialogCalls[0]!.options.defaultId).toBe(0)
    // Escape/close lands on "keep using the app" — never stuck half-quitting.
    expect(dialogCalls[0]!.options.cancelId).toBe(1)
  })

  it('uses the CLI broker message for cli-managed-broker and maps response 1 to continue', async () => {
    nextDialogResponse = 1
    const action = await showQuitCancelledDialog('cli-managed-broker')

    expect(action).toBe('continue')
    expect(i18nCalls).toContain('appQuit.cancelled.cliBrokerMessage')
    expect(i18nCalls).not.toContain('appQuit.cancelled.localAppMessage')
  })
})

describe('handleQuitCancellation', () => {
  beforeEach(() => {
    dialogCalls.length = 0
    quitCalls.mockClear()
    logger.info.mockClear()
    logger.error.mockClear()
    nextDialogResponse = 0
  })

  it('retry re-enters quit instead of bypassing the guarded cleanup', async () => {
    nextDialogResponse = 0
    handleQuitCancellation('local-app-runtime', logger)

    await Bun.sleep(0)
    expect(quitCalls).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Retrying quit'))
  })

  it('continue keeps the app fully interactive without quitting', async () => {
    nextDialogResponse = 1
    handleQuitCancellation('cli-managed-broker', logger)

    await Bun.sleep(0)
    expect(quitCalls).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('keep using the app'))
  })

  it('a cancellation while the dialog is open is ignored (no stacking, no double quit)', async () => {
    nextDialogResponse = 0
    handleQuitCancellation('local-app-runtime', logger)
    handleQuitCancellation('local-app-runtime', logger)

    await Bun.sleep(0)
    expect(dialogCalls).toHaveLength(1)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('already visible'),
    )
    // One user decision → one retry, regardless of repeated events.
    expect(quitCalls).toHaveBeenCalledTimes(1)
  })

  it('uses a custom retry entry point when provided', async () => {
    nextDialogResponse = 0
    const onRetry = mock(() => {})
    handleQuitCancellation('local-app-runtime', logger, onRetry)

    await Bun.sleep(0)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(quitCalls).not.toHaveBeenCalled()
  })
})
