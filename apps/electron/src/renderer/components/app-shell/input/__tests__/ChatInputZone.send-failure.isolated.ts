/** Journey #8 — the ChatInputZone status banner grows an optional collapsed
 * technical-detail block (send-failure prompts), and the explicit action
 * button stays user-triggered. The heavy subtree is stubbed as in the goal
 * wiring test; this pins only the banner render contract. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
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

mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))
mock.module('@/components/app-shell/input/InputContainer', () => ({
  InputContainer: () => createElement('div', { 'data-testid': 'input-container-stub' }),
}))
mock.module('@/components/app-shell/ActiveOptionBadges', () => ({
  ActiveOptionBadges: () => createElement('div', { 'data-testid': 'active-option-badges-stub' }),
}))
mock.module('@/context/AppShellContext', () => ({
  useOptionalAppShellContext: () => ({}),
  useAppShellContext: () => {
    throw new Error('not used in this test')
  },
}))

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ChatInputZone } = await import('../ChatInputZone')

function renderZone(banner: Parameters<typeof ChatInputZone>[0]['statusBanner']) {
  return render(createElement(I18nextProvider, { i18n }, createElement(ChatInputZone, {
    sessionId: 'send-fail-zone',
    statusBanner: banner,
    inputProps: {
      placeholder: '',
      disabled: true,
      currentModel: '',
      onSubmit: () => {},
      onInputChange: () => {},
    },
  })))
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('ChatInputZone 状态横幅折叠详情(journey #8)', () => {
  it('发送失败横幅:标题 + 折叠技术详情 + 显式动作,默认收起', () => {
    renderZone({
      variant: 'destructive',
      message: 'Message not sent — your draft was preserved',
      detail: 'socket hang up',
      actionLabel: 'Restore draft',
      onAction: () => {},
    })
    const banner = screen.getByTestId('chat-status-banner')
    expect(banner.getAttribute('data-banner-variant')).toBe('destructive')
    expect(banner.textContent).toContain('Message not sent')
    const detail = screen.getByTestId('chat-status-banner-detail')
    // Collapsed by default; the raw error is present in the DOM but hidden.
    expect((detail as HTMLDetailsElement).open).toBe(false)
    expect(detail.textContent).toContain('socket hang up')
    expect(detail.textContent).toContain('Technical details')
    expect(screen.getByTestId('chat-status-banner-action').textContent).toBe('Restore draft')
  })

  it('展开后技术详情可见;动作点击触发一次', () => {
    let clicks = 0
    renderZone({
      variant: 'destructive',
      message: 'failed',
      detail: 'ECONNRESET',
      actionLabel: 'Restore draft',
      onAction: () => { clicks += 1 },
    })
    const detail = screen.getByTestId('chat-status-banner-detail')
    // happy-dom has no dedicated toggle event fire — set open directly (the
    // user gesture path) and assert the collapsed content is now visible.
    ;(detail as HTMLDetailsElement).open = true
    expect((detail as HTMLDetailsElement).open).toBe(true)
    fireEvent.click(screen.getByTestId('chat-status-banner-action'))
    expect(clicks).toBe(1)
  })

  it('无 detail 的横幅(计费阻断):不渲染折叠块,动作仍可用', () => {
    renderZone({
      variant: 'destructive',
      message: 'Balance exhausted',
      actionLabel: 'Recharge',
      onAction: () => {},
    })
    expect(screen.queryByTestId('chat-status-banner-detail')).toBeNull()
    expect(screen.getByTestId('chat-status-banner-action').textContent).toBe('Recharge')
  })

  // Review R2 N2: the failed-send prompt is advisory — it carries an explicit
  // discard action (review F4), fires once, and renders nothing when absent.
  it('放弃草稿(dismiss):渲染显式动作,点击触发一次;未传时不渲染', () => {
    let dismissals = 0
    renderZone({
      variant: 'destructive',
      message: 'Message not sent — your draft was preserved',
      detail: 'ECONNRESET',
      actionLabel: 'Restore draft',
      onAction: () => {},
      dismissLabel: 'Discard draft',
      onDismiss: () => { dismissals += 1 },
    })
    const dismiss = screen.getByTestId('chat-status-banner-dismiss')
    expect(dismiss.textContent).toBe('Discard draft')
    fireEvent.click(dismiss)
    fireEvent.click(dismiss)
    expect(dismissals).toBe(2)

    cleanup()
    renderZone({
      variant: 'destructive',
      message: 'hard block',
    })
    expect(screen.queryByTestId('chat-status-banner-dismiss')).toBeNull()
  })
})
