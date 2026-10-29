/**
 * useSessionMenuActions — exportSession coverage (D3: session-menu export entry).
 *
 * The export action talks to the main process over the dedicated
 * `__session:exportToFile` IPC (mocked here via window.electronAPI) and must:
 *   - success: toast.success + reveal the written file (showInFolder)
 *   - cancel (null): stay completely silent
 *   - failure: toast.error only
 *   - ignore a second tap while a save dialog is still pending
 */
import { describe, it, expect, mock, afterEach } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { SessionMeta } from '@/atoms/sessions'

// Hook-level tests need a DOM. Register only when no window exists yet
// (shared bun test process) — same pattern as the other hook tests.
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
// Pin the language — assertions expect English toast strings and the i18n
// singleton is shared across test files in a single-process run.
void i18n.changeLanguage('en')

const toastSuccess = mock((_message: string) => {})
const toastError = mock((_message: string) => {})
mock.module('sonner', () => ({
  toast: {
    success: toastSuccess,
    error: toastError,
  },
}))

const exportSessionToFile = mock((_sessionId: string) =>
  Promise.resolve<string | null>(null),
)
const showInFolder = mock((_path: string) => Promise.resolve())
const sessionCommand = mock((_sessionId: string, _command: unknown) =>
  Promise.resolve({ success: false }),
)

// electronAPI double — only the surface the export action touches.
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    exportSessionToFile,
    showInFolder,
    sessionCommand,
    openUrl: mock((_url: string) => {}),
  },
})

const { renderHook, act, cleanup } = await import('@testing-library/react')
const { useSessionMenuActions } = await import('../useSessionMenuActions')

const ITEM: SessionMeta = { id: 'session-export-1', workspaceId: 'ws-1' }

function renderActions() {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(I18nextProvider, { i18n }, children)
  return renderHook(() => useSessionMenuActions({ item: ITEM }), { wrapper })
}

afterEach(() => {
  cleanup()
  toastSuccess.mockClear()
  toastError.mockClear()
  exportSessionToFile.mockClear()
  showInFolder.mockClear()
  sessionCommand.mockClear()
})

describe('useSessionMenuActions.exportSession', () => {
  it('exposes the exportSession action', () => {
    const { result } = renderActions()
    expect(typeof result.current.exportSession).toBe('function')
  })

  it('on success: toasts success and reveals the exported file', async () => {
    exportSessionToFile.mockImplementation(() =>
      Promise.resolve('/Users/tester/Downloads/my-chat.json'),
    )
    const { result } = renderActions()

    await act(async () => {
      await result.current.exportSession()
    })

    expect(exportSessionToFile.mock.calls).toEqual([['session-export-1']])
    expect(toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess.mock.calls[0][0]).toBe('Conversation exported')
    expect(toastError.mock.calls.length).toBe(0)
    // Reveal happens after the toast, with the exact written path.
    expect(showInFolder.mock.calls).toEqual([['/Users/tester/Downloads/my-chat.json']])
  })

  it('on cancel (null): shows no toast and does not reveal anything', async () => {
    exportSessionToFile.mockImplementation(() => Promise.resolve(null))
    const { result } = renderActions()

    await act(async () => {
      await result.current.exportSession()
    })

    expect(exportSessionToFile.mock.calls.length).toBe(1)
    expect(toastSuccess.mock.calls.length).toBe(0)
    expect(toastError.mock.calls.length).toBe(0)
    expect(showInFolder.mock.calls.length).toBe(0)
  })

  it('on failure: shows an error toast and does not reveal anything', async () => {
    exportSessionToFile.mockImplementation(() =>
      Promise.reject(new Error('Session manager not initialized')),
    )
    const { result } = renderActions()

    await act(async () => {
      await result.current.exportSession()
    })

    expect(toastError.mock.calls.length).toBe(1)
    expect(toastError.mock.calls[0][0]).toBe('Failed to export conversation')
    expect(toastSuccess.mock.calls.length).toBe(0)
    expect(showInFolder.mock.calls.length).toBe(0)
  })

  it('ignores a second tap while an export is still pending', async () => {
    let resolveDialog: (path: string | null) => void = () => {}
    exportSessionToFile.mockImplementation(
      () =>
        new Promise<string | null>((resolve) => {
          resolveDialog = resolve
        }),
    )
    const { result } = renderActions()

    let firstRun!: Promise<void>
    act(() => {
      firstRun = result.current.exportSession()
    })
    // Second tap while the save dialog is pending → no-op.
    await act(async () => {
      await result.current.exportSession()
    })
    expect(exportSessionToFile.mock.calls.length).toBe(1)

    resolveDialog('/Users/tester/Downloads/late.json')
    await act(async () => {
      await firstRun
    })

    expect(exportSessionToFile.mock.calls.length).toBe(1)
    expect(toastSuccess.mock.calls.length).toBe(1)
    // After completion a new tap fires again.
    exportSessionToFile.mockImplementation(() => Promise.resolve(null))
    await act(async () => {
      await result.current.exportSession()
    })
    expect(exportSessionToFile.mock.calls.length).toBe(2)
  })
})


describe('useSessionMenuActions.share', () => {
  function setClipboard(writeText: (value: string) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  }

  // POO-166: sharing no longer asks through a confirm dialog — the first tap
  // publishes immediately (sessionCommand fires synchronously in the same
  // task, with no dialog round-trip in between).
  it('publishes on the first tap without a confirm round-trip, then toasts the copied link', async () => {
    const writeText = mock(async (_value: string) => {})
    setClipboard(writeText)
    sessionCommand.mockImplementation((_sessionId, _command) =>
      Promise.resolve({ success: true, url: 'https://app.polo.z-h-ai.com/s/abc123' }),
    )
    const { result } = renderActions()

    await act(async () => {
      await result.current.share()
    })

    expect(sessionCommand.mock.calls).toEqual([['session-export-1', { type: 'shareToViewer' }]])
    expect(writeText.mock.calls).toEqual([['https://app.polo.z-h-ai.com/s/abc123']])
    expect(toastSuccess.mock.calls.length).toBe(1)
    expect(toastSuccess.mock.calls[0][0]).toBe('Link copied to clipboard')
    expect(toastError.mock.calls.length).toBe(0)
  })

  it('reports a failed publish without claiming success', async () => {
    setClipboard(async () => {})
    sessionCommand.mockImplementation((_sessionId, _command) =>
      Promise.resolve({ success: false, error: 'Session manager not initialized' }),
    )
    const { result } = renderActions()

    await act(async () => {
      await result.current.share()
    })

    expect(sessionCommand.mock.calls.length).toBe(1)
    expect(toastError.mock.calls.length).toBe(1)
    expect(toastError.mock.calls[0][0]).toBe('Failed to share')
    expect(toastSuccess.mock.calls.length).toBe(0)
  })
})

describe('useSessionMenuActions.copySessionId', () => {
  function setClipboard(writeText: (value: string) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  }

  it('copies the exact Polo ID and confirms only after the clipboard accepts it', async () => {
    let accept!: () => void
    const writeText = mock((_value: string) => new Promise<void>((resolve) => { accept = resolve }))
    setClipboard(writeText)
    const { result } = renderActions()
    let copying!: Promise<void>
    act(() => { copying = result.current.copySessionId() })
    expect(writeText.mock.calls).toEqual([['session-export-1']])
    expect(toastSuccess).not.toHaveBeenCalled()
    await act(async () => { accept(); await copying })
    expect(toastSuccess).toHaveBeenCalledWith('Session ID copied')
  })

  it('uses the newly selected session after rerender', async () => {
    const writeText = mock(async (_value: string) => {})
    setClipboard(writeText)
    const { result, rerender } = renderHook(({ item }) => useSessionMenuActions({ item }), {
      initialProps: { item: ITEM },
      wrapper: ({ children }) => createElement(I18nextProvider, { i18n }, children),
    })
    await act(async () => { await result.current.copySessionId() })
    rerender({ item: { ...ITEM, id: 'session-next' } })
    await act(async () => { await result.current.copySessionId() })
    expect(writeText.mock.calls).toEqual([['session-export-1'], ['session-next']])
  })

  it('reports denied clipboard access without claiming success', async () => {
    setClipboard(async () => { throw new Error('clipboard denied') })
    const { result } = renderActions()
    await act(async () => { await result.current.copySessionId() })
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('Failed to copy session ID. Try again.')
  })

  it('reports an unavailable clipboard without throwing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    const { result } = renderActions()
    await act(async () => { await result.current.copySessionId() })
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('Failed to copy session ID. Try again.')
  })
})
