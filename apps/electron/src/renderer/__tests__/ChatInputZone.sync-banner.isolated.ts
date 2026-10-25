/** POO-144: the ChatInputZone status banner renders the space AI-config sync
 * states — the failed variant exposes the only retry entry, user-triggered.
 * ChatPage owns the issue→banner mapping; this file pins the banner rendering
 * contract (message, action button, click dispatch). Heavy subtree
 * (InputContainer/ActiveOptionBadges/Sentry) is stubbed at the module edge. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'

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

class DOMMatrixStub {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
  multiply = () => this
  static fromMatrix = () => new DOMMatrixStub()
}
;(globalThis as unknown as Record<string, unknown>).DOMMatrix = DOMMatrixStub
;(globalThis as unknown as Record<string, unknown>).Path2D = class Path2DStub {
  moveTo() {} lineTo() {} bezierCurveTo() {} quadraticCurveTo() {} arc() {}
  arcTo() {} rect() {} ellipse() {} closePath() {} addPath() {}
}
mock.module('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: 'data:application/javascript,',
}))

mock.module('@/components/app-shell/input/InputContainer', () => ({
  InputContainer: (props: Record<string, unknown>) =>
    createElement('div', { 'data-testid': 'input-container-stub', 'data-disabled': String(props.disabled ?? 'false') }),
}))
mock.module('@/components/app-shell/ActiveOptionBadges', () => ({
  ActiveOptionBadges: () => createElement('div', { 'data-testid': 'active-option-badges-stub' }),
}))
mock.module('@sentry/electron/renderer', () => new Proxy({}, {
  get: () => () => {},
}))

const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const { ChatInputZone } = await import('../components/app-shell/input/ChatInputZone')
type ChatInputStatusBanner = import('../components/app-shell/input/ChatInputZone').ChatInputStatusBanner

function renderZone(statusBanner: ChatInputStatusBanner | null) {
  return render(createElement(ChatInputZone, {
    sessionId: 'sync-banner-unit-session',
    showOptionBadges: false,
    statusBanner,
    inputProps: {
      placeholder: '',
      disabled: true,
      currentModel: '',
      onSubmit: () => {},
      onInputChange: () => {},
    },
  }))
}

beforeEach(() => {
  cleanup()
})

afterEach(() => {
  cleanup()
})

describe('ChatInputZone 状态横幅 × AI 配置同步（POO-144）', () => {
  it('failed 横幅渲染重试按钮，点击触发一次重试回调', () => {
    const onRetry = mock(() => {})
    renderZone({
      variant: 'destructive',
      message: 'AI 配置同步失败',
      actionLabel: '重试',
      onAction: onRetry,
    })
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('AI 配置同步失败')
    const retry = screen.getByTestId('chat-status-banner-action')
    expect(retry.textContent).toBe('重试')
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('syncing 横幅只有提示文案，不渲染任何操作按钮', () => {
    renderZone({ variant: 'info', message: '正在同步空间 AI 配置…' })
    expect(screen.getByRole('status').textContent).toContain('正在同步空间 AI 配置…')
    expect(screen.queryByTestId('chat-status-banner-action')).toBeNull()
  })

  it('无横幅时不渲染 status 区域', () => {
    renderZone(null)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('横幅存在时输入容器保持 disabled（同步中/失败均阻断发送入口）', () => {
    renderZone({ variant: 'info', message: '正在同步空间 AI 配置…' })
    expect(screen.getByTestId('input-container-stub').getAttribute('data-disabled')).toBe('true')
  })
})
