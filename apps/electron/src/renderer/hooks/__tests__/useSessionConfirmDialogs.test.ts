/**
 * Session confirm dialogs (share-create + delete).
 *
 * - Spec builders: the share ask names the session, states the public-link
 *   consequence and is NOT destructive (the link is revocable); the delete
 *   ask names the session, states the irreversible loss and IS destructive.
 * - useShareSessionConfirm (the production shape: requestShare + the hook's
 *   confirmElement): cancel never publishes; confirm runs the same
 *   `shareSessionToViewer` write the old one-tap path ran.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}
setupI18n()
// Pin the language — assertions expect English strings and the i18n singleton
// is shared across test files in a single-process run.
void i18n.changeLanguage('en')

const toastSuccess = mock((_message: string) => {})
const toastError = mock((_message: string) => {})
mock.module('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}))

const sessionCommand = mock((_sessionId: string, _command: unknown) =>
  Promise.resolve({ success: false }),
)

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    sessionCommand,
    openUrl: mock((_url: string) => {}),
  },
})

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ModalProvider } = await import('@/context/ModalContext')
const { useShareSessionConfirm, shareSessionConfirmSpec, deleteSessionConfirmSpec } = await import('../useSessionConfirmDialogs')

// Same minimal translator shape the spec builders accept.
const t = ((key: string, options?: Record<string, unknown>) =>
  i18n.t(key, { ...(options ?? {}) })) as unknown as (key: string, options?: Record<string, unknown>) => string

function setClipboard(writeText: (value: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
}

function Harness() {
  const { requestShare, confirmElement } = useShareSessionConfirm()
  return createElement('div', null,
    createElement('button', {
      'data-testid': 'ask-share',
      onClick: () => requestShare({ id: 'session-share-1', name: 'My chat' }),
    }, 'ask'),
    confirmElement)
}

function tree() {
  return createElement(I18nextProvider, { i18n }, createElement(ModalProvider, null,
    createElement(Harness)))
}

afterEach(() => {
  cleanup()
  toastSuccess.mockClear()
  toastError.mockClear()
  sessionCommand.mockClear()
})

describe('session confirmation dialog specs', () => {
  it('share ask names the session, states the public-link consequence, and is not destructive', () => {
    const spec = shareSessionConfirmSpec('My chat', t)
    expect(spec.title).toBe('Share “My chat”?')
    expect(spec.description).toContain('Anyone with the link can view this conversation')
    expect(spec.description).toContain('until you stop sharing')
    expect(spec.confirmLabel).toBe('Create link')
    expect(spec.destructive).toBe(false)
    expect(spec.testId).toBe('share-session-confirm-dialog')
  })

  it('delete ask names the session and is destructive with the Delete button', () => {
    const spec = deleteSessionConfirmSpec('My chat', t)
    expect(spec.title).toBe('Delete “My chat”?')
    expect(spec.description).toContain('permanently deleted')
    expect(spec.description).toContain("can't be undone")
    expect(spec.confirmLabel).toBe('Delete')
    expect(spec.destructive).toBe(true)
    expect(spec.testId).toBe('delete-session-confirm-dialog')
  })
})

describe('useShareSessionConfirm (first-create share ask)', () => {
  it('cancel (or ESC/outside) never publishes — no shareToViewer RPC', async () => {
    render(tree())
    fireEvent.click(screen.getByTestId('ask-share'))

    // The ask names the session before anything is sent.
    expect(screen.getByTestId('share-session-confirm-dialog')).not.toBeNull()
    expect(screen.getByText('Share “My chat”?')).not.toBeNull()
    expect(sessionCommand.mock.calls.length).toBe(0)

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    await waitFor(() => expect(screen.queryByTestId('share-session-confirm-dialog')).toBeNull())
    expect(sessionCommand.mock.calls.length).toBe(0)
    expect(toastSuccess.mock.calls.length).toBe(0)
  })

  it('confirm publishes the link and copies it — the old one-tap write, now gated', async () => {
    setClipboard(async (_value) => {})
    sessionCommand.mockImplementation(() =>
      Promise.resolve({ success: true, url: 'https://app.polo.z-h-ai.com/s/abc123' }))
    render(tree())
    fireEvent.click(screen.getByTestId('ask-share'))

    expect(screen.getByTestId('share-session-confirm-dialog')).not.toBeNull()
    fireEvent.click(screen.getByTestId('confirm-dialog-action'))

    await waitFor(() => expect(screen.queryByTestId('share-session-confirm-dialog')).toBeNull())
    expect(sessionCommand.mock.calls).toEqual([['session-share-1', { type: 'shareToViewer' }]])
    expect(toastSuccess.mock.calls.length).toBe(1)
    expect(toastError.mock.calls.length).toBe(0)
  })

  it('a failed publish settles the dialog and reports the failure via toast (no success claim)', async () => {
    setClipboard(async () => {})
    sessionCommand.mockImplementation(() =>
      Promise.resolve({ success: false, error: 'Session manager not initialized' }))
    render(tree())
    fireEvent.click(screen.getByTestId('ask-share'))
    fireEvent.click(screen.getByTestId('confirm-dialog-action'))

    // `shareSessionToViewer` surfaces `success: false` as an error toast —
    // the write attempt is settled, so the dialog closes either way.
    await waitFor(() => expect(screen.queryByTestId('share-session-confirm-dialog')).toBeNull())
    expect(toastError.mock.calls.length).toBe(1)
    expect(toastError.mock.calls[0][0]).toBe('Failed to share')
    expect(toastSuccess.mock.calls.length).toBe(0)
  })

  it('a rejected publish keeps the dialog open with the error inline for a deliberate retry', async () => {
    setClipboard(async () => {})
    let attempts = 0
    sessionCommand.mockImplementation(() => {
      attempts += 1
      if (attempts === 1) return Promise.reject(new Error('transport down'))
      return Promise.resolve({ success: true, url: 'https://app.polo.z-h-ai.com/s/abc123' })
    })
    render(tree())
    fireEvent.click(screen.getByTestId('ask-share'))
    fireEvent.click(screen.getByTestId('confirm-dialog-action'))

    await waitFor(() => expect(screen.getByTestId('confirm-dialog-error').textContent).toContain('transport down'))
    expect(screen.queryByTestId('share-session-confirm-dialog')).not.toBeNull()

    // Retry succeeds: dialog closes, exactly two RPC attempts were made.
    fireEvent.click(screen.getByTestId('confirm-dialog-action'))
    await waitFor(() => expect(screen.queryByTestId('share-session-confirm-dialog')).toBeNull())
    expect(attempts).toBe(2)
    expect(toastSuccess.mock.calls.length).toBe(1)
  })
})
