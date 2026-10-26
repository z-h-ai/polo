/** Journey #7 — the shared confirm dialog contract. Every window.confirm
 * replacement rides on this component, so these tests pin the safety rules
 * the task mandates: cancel/ESC never write, the confirm action fires exactly
 * once (double-click safe while busy), a failed action keeps the dialog open
 * with the error inline for a deliberate retry, and a superseded/unmounted
 * ask resolves as a cancel so a stale resolver can never fire a late write.
 * Driven through the real production shape — useConfirmDialog + confirmElement
 * — because ConfirmDialog is a controlled component: the hook owns spec state.
 * Real Radix Dialog under happy-dom; ModalProvider is real. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
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

const { cleanup, fireEvent, render, screen, waitFor, renderHook } = await import('@testing-library/react')
const { ModalProvider } = await import('@/context/ModalContext')
const { useConfirmDialog } = await import('../confirm-dialog')

// Test knobs read by the hook host at ask time (assigned per test).
let onConfirm: () => Promise<void> | void = () => {}
let hookCapture: ((promise: Promise<boolean>) => void) | null = null

/** The real production shape: requestConfirm + the hook's confirmElement. */
function HookHost() {
  const { requestConfirm, confirmElement } = useConfirmDialog()
  return createElement('div', null,
    createElement('button', {
      'data-testid': 'ask',
      onClick: () => {
        const promise = requestConfirm({
          testId: 'ask-dialog',
          title: 'Remove the thing?',
          onConfirm,
        })
        hookCapture?.(promise)
      },
    }),
    confirmElement)
}

function hookTree() {
  return createElement(I18nextProvider, { i18n }, createElement(ModalProvider, null,
    createElement(HookHost)))
}

beforeEach(() => {
  cleanup()
  hookCapture = null
  onConfirm = () => {}
})

afterEach(() => {
  cleanup()
})

describe('ConfirmDialog 取消路径（journey #7）', () => {
  it('取消按钮：按取消结算，onConfirm 永不执行，对话框关闭', async () => {
    let ran = 0
    onConfirm = () => { ran += 1 }
    render(hookTree())
    fireEvent.click(screen.getByTestId('ask'))

    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    await waitFor(() => expect(screen.queryByTestId('ask-dialog')).toBeNull())
    expect(screen.queryByTestId('confirm-dialog-cancel')).toBeNull()
    expect(ran).toBe(0)
  })

  it('ESC 关闭视为取消，无写入', async () => {
    let ran = 0
    onConfirm = () => { ran += 1 }
    render(hookTree())
    fireEvent.click(screen.getByTestId('ask'))
    expect(screen.getByTestId('ask-dialog')).not.toBeNull()

    fireEvent.keyDown(document.querySelector('[data-testid="ask-dialog"]')!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('ask-dialog')).toBeNull())
    expect(ran).toBe(0)
  })
})

describe('ConfirmDialog 确认路径（journey #7）', () => {
  it('确认：onConfirm 恰好一次，成功后按 true 结算并关闭', async () => {
    const outcomes: boolean[] = []
    hookCapture = promise => { void promise.then(v => outcomes.push(v)) }
    let ran = 0
    onConfirm = () => { ran += 1 }
    render(hookTree())
    fireEvent.click(screen.getByTestId('ask'))

    fireEvent.click(screen.getByTestId('confirm-dialog-action'))
    await waitFor(() => expect(screen.queryByTestId('ask-dialog')).toBeNull())
    expect(ran).toBe(1)
    expect(outcomes).toEqual([true])
  })

  it('确认中防重复：busy 时双按钮禁用，连点只跑一次', async () => {
    const outcomes: boolean[] = []
    hookCapture = promise => { void promise.then(v => outcomes.push(v)) }
    let resolveConfirm: () => void = () => {}
    let ran = 0
    onConfirm = () => new Promise<void>(resolve => {
      ran += 1
      resolveConfirm = resolve
    })
    render(hookTree())
    fireEvent.click(screen.getByTestId('ask'))

    fireEvent.click(screen.getByTestId('confirm-dialog-action'))
    expect(ran).toBe(1)
    await waitFor(() => {
      expect((screen.getByTestId('confirm-dialog-action') as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByTestId('confirm-dialog-cancel') as HTMLButtonElement).disabled).toBe(true)
    })
    // Second click during the in-flight write must be a no-op.
    fireEvent.click(screen.getByTestId('confirm-dialog-action'))
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'))
    expect(ran).toBe(1)

    resolveConfirm()
    await waitFor(() => expect(screen.queryByTestId('ask-dialog')).toBeNull())
    expect(ran).toBe(1)
    expect(outcomes).toEqual([true])
  })

  it('失败保留对象可重试：onConfirm 拒绝后对话框保持打开、内联报错，重试成功才结算', async () => {
    const outcomes: boolean[] = []
    hookCapture = promise => { void promise.then(v => outcomes.push(v)) }
    let attempts = 0
    onConfirm = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('server refused')
    }
    render(hookTree())
    fireEvent.click(screen.getByTestId('ask'))

    fireEvent.click(screen.getByTestId('confirm-dialog-action'))
    // First attempt failed: dialog stays open, error shown inline.
    await waitFor(() => expect(screen.getByTestId('confirm-dialog-error').textContent).toContain('server refused'))
    expect(screen.queryByTestId('ask-dialog')).not.toBeNull()
    expect(outcomes).toEqual([])

    // Retry succeeds: settles true, dialog closes.
    fireEvent.click(screen.getByTestId('confirm-dialog-action'))
    await waitFor(() => expect(screen.queryByTestId('ask-dialog')).toBeNull())
    expect(attempts).toBe(2)
    expect(outcomes).toEqual([true])
  })
})

describe('useConfirmDialog 待决请求的生命周期（journey #7）', () => {
  it('替换待决请求：旧的立即按取消结算，新请求正常确认', async () => {
    const outcomes: boolean[] = []
    hookCapture = promise => { void promise.then(v => outcomes.push(v)) }
    render(hookTree())

    fireEvent.click(screen.getByTestId('ask'))
    fireEvent.click(screen.getByTestId('ask'))
    await waitFor(() => expect(outcomes).toEqual([false]))
    // The second ask is still pending and rendered.
    expect(screen.queryByTestId('ask-dialog')).not.toBeNull()
    fireEvent.click(screen.getByTestId('confirm-dialog-action'))
    await waitFor(() => expect(outcomes).toEqual([false, true]))
  })

  it('宿主卸载：待决请求按取消结算，绝不晚写入', async () => {
    const outcomes: boolean[] = []
    hookCapture = promise => { void promise.then(v => outcomes.push(v)) }
    const { unmount } = render(hookTree())

    fireEvent.click(screen.getByTestId('ask'))
    await waitFor(() => expect(screen.queryByTestId('ask-dialog')).not.toBeNull())
    unmount()
    await waitFor(() => expect(outcomes).toEqual([false]))
  })
})

describe('useConfirmDialog hook 直测（journey #7）', () => {
  it('requestConfirm 返回 Promise<boolean>，未决时卸载结算为 false', async () => {
    function Wrapper({ children }: { children?: React.ReactNode | undefined }) {
      return createElement(I18nextProvider, { i18n }, createElement(ModalProvider, null, children))
    }
    const { result, unmount } = renderHook(() => useConfirmDialog(), { wrapper: Wrapper })
    // Object holder: TS narrows a plain `let` to null across the closure.
    const state: { settled: boolean | null } = { settled: null }
    void result.current.requestConfirm({ title: 'Ask?' }).then(v => { state.settled = v })
    unmount()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(state.settled).toBe(false)
  })
})
