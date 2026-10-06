import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState, useRef } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { LeaveCircleDialogState } from '@/hooks/useLeaveCircle'

GlobalRegistrator.register()
setupI18n()
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))
const { render, screen, cleanup, waitFor, act, fireEvent } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ModalProvider, useModalRegistry } = await import('@/context/ModalContext')
const { LeaveCircleDialog } = await import('../LeaveCircleDialog')

const initial: LeaveCircleDialogState = {
  circleId: 'circle-a', membershipId: 'member-a', circleName: '原圈子',
  lastSourceWorkNames: [], busy: false, phase: 'confirm', failure: null, recheckUnresolved: false,
}
let registry: ReturnType<typeof useModalRegistry>
let update: (state: LeaveCircleDialogState) => void
let finish: () => void
const confirms = mock(() => {})
const cancels = mock(() => {})
function Host() {
  const [state, setState] = useState<LeaveCircleDialogState | null>(null)
  const [left, setLeft] = useState(false)
  const mainRef = useRef<HTMLElement>(null)
  registry = useModalRegistry()
  update = setState
  finish = () => { setLeft(true); setState(null) }
  return createElement('div', null,
    createElement('main', { ref: mainRef, tabIndex: -1, 'data-circle-id': initial.circleId, 'data-testid': 'current-circle-main' },
      left ? createElement('button', { key: 'reverify', 'data-testid': 'post-leave-reverify' }, '重新核对')
        : createElement('button', { key: 'leave', 'data-testid': 'subscription-leave', onClick: () => setState(initial) }, '退出圈子')),
    createElement('button', { 'data-testid': 'background-neighbor' }, '其他操作'),
    createElement(LeaveCircleDialog, { state, fallbackFocusRef: mainRef, onConfirm: confirms, onCancel: () => { cancels(); setState(null) } }),
  )
}
function mount() {
  return render(createElement(I18nextProvider, { i18n }, createElement(ModalProvider, null, createElement(Host))))
}
afterEach(() => { cleanup(); confirms.mockClear(); cancels.mockClear() })

describe('real Radix leave dialog focus and modal guard', () => {
  for (const invalid of ['hidden', 'other-circle'] as const) {
    it(`does not transfer success focus to an ${invalid} fallback`, async () => {
      mount()
      const user = userEvent.setup()
      await user.click(screen.getByTestId('subscription-leave'))
      const main = screen.getByTestId('current-circle-main')
      if (invalid === 'hidden') main.hidden = true
      else main.dataset.circleId = 'other-circle'
      await act(async () => finish())
      await waitFor(() => expect(screen.queryByTestId('leave-circle-dialog')).toBeNull())
      expect(document.activeElement).not.toBe(main)
    })
  }

  it('restores success focus to the explicit current circle main after its trigger unmounts', async () => {
    mount()
    const user = userEvent.setup()
    const trigger = screen.getByTestId('subscription-leave')
    await user.click(trigger)
    await user.click(screen.getByTestId('leave-circle-dialog-confirm'))
    await act(async () => finish())
    await waitFor(() => expect(screen.queryByTestId('leave-circle-dialog')).toBeNull())
    expect(trigger.isConnected).toBe(false)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('current-circle-main')))
    expect(confirms).toHaveBeenCalledTimes(1)
    expect(cancels).not.toHaveBeenCalled()
  })

  it('starts on Cancel, contains Tab/Shift-Tab, then restores the subscription entry', async () => {
    await i18n.changeLanguage('zh-Hans')
    mount()
    const user = userEvent.setup()
    const entry = screen.getByTestId('subscription-leave')
    await user.click(entry)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('leave-circle-dialog-cancel')))
    expect(registry.hasOpenModals()).toBe(true)
    await user.tab({ shift: true })
    expect(document.activeElement).toBe(screen.getByTestId('leave-circle-dialog-confirm'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByTestId('leave-circle-dialog-cancel'))
    await user.tab()
    expect(document.activeElement).toBe(screen.getByTestId('leave-circle-dialog-confirm'))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByTestId('leave-circle-dialog')).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(entry))
    expect(registry.hasOpenModals()).toBe(false)
  })

  it('blocks Escape, outside, Cancel, registry close and repeat confirm during the write; failed state can cancel', async () => {
    mount()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('subscription-leave'))
    await user.click(screen.getByTestId('leave-circle-dialog-confirm'))
    expect(confirms).toHaveBeenCalledTimes(1)
    await act(async () => update({ ...initial, busy: true }))
    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('leave-circle-dialog-cancel'))
    await user.click(screen.getByTestId('leave-circle-dialog-confirm'))
    fireEvent.pointerDown(document.body, { button: 0, pointerType: 'mouse' })
    await act(async () => { expect(registry.closeTopModal()).toBe(true) })
    expect(screen.getByTestId('leave-circle-dialog')).toBeTruthy()
    expect(cancels).not.toHaveBeenCalled()
    expect(confirms).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-slot=dialog-close]')).toBeNull()
    await act(async () => update({ ...initial, phase: 'error', failure: { code: 'rejected', kind: 'rejected', retryable: true } }))
    await user.click(screen.getByTestId('leave-circle-dialog-cancel'))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('subscription-leave')))
    expect(cancels).toHaveBeenCalledTimes(1)
  })
})
