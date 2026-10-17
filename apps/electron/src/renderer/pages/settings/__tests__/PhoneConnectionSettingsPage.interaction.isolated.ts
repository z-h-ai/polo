/**
 * PhoneConnectionSettingsPage 渲染交互测试（POL-13 卡步骤 6）。
 *
 * bun test 无内置 DOM —— 与本仓 renderer 组件测试先例一致：本文件命名为
 * `*.interaction.isolated.ts`，由 scripts/run-isolated-tests.sh 以
 * `bun test --isolate` 单独进程运行（GlobalRegistrator 会污染全局）。
 * 覆盖：渲染、倒计时（含过期/重签发）、撤销二次确认流、错误态、relay 状态卡。
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, setupI18n } from '@polo-ai/shared/i18n/setupI18n'
import { createElement } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { I18nextProvider } from 'react-i18next'

GlobalRegistrator.register()
setupI18n()

mock.module('@polo-ai/ui', () => ({
  Spinner: () => null,
}))
mock.module('@/components/app-shell/PanelHeader', () => ({
  PanelHeader: ({ title }: { title?: string }) => createElement('header', null, title),
}))
mock.module('@/components/ui/HeaderMenu', () => ({
  HeaderMenu: () => null,
}))
mock.module('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
}))
mock.module('@/components/settings', () => ({
  SettingsSection: ({
    children,
    title,
    description,
  }: {
    children?: ReactNode
    title?: string
    description?: string
  }) =>
    createElement(
      'section',
      null,
      createElement('h2', null, title),
      description ? createElement('p', { 'data-testid': 'section-description' }, description) : null,
      children,
    ),
  SettingsCard: ({ children }: { children?: ReactNode }) =>
    createElement('div', null, children),
  SettingsRow: ({ label, description }: { label: string; description?: string }) =>
    createElement(
      'div',
      { 'data-testid': 'settings-row', 'data-label': label },
      createElement('span', null, label),
      description ? createElement('span', { 'data-testid': 'settings-row-value' }, description) : null,
    ),
}))
// Radix Dialog 在 happy-dom 下依赖指针/焦点管理 —— 按先例换最小假实现，
// open 时渲染 children 即可覆盖「二次确认弹层」的交互语义。
mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement('h3', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    createElement('p', { 'data-testid': 'dialog-description' }, children),
  DialogFooter: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}))
// 二维码库渲染 SVG 路径 —— 换透传桩，把 payload 暴露到 DOM 便于断言
// （PRD §⑤：payload = JSON {code, wsUrl?}，wsUrl 仅 LAN 提示）。
mock.module('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) =>
    createElement('div', { 'data-testid': 'qr-payload', 'data-value': value }),
}))
const toastSuccess = mock(() => {})
const toastError = mock(() => {})
mock.module('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
}))

type PhoneDeviceView = {
  id: string
  name: string
  platform: 'ios' | 'android'
  macDeviceId: string
  pushToken: string | null
  lastSeenAt: string | null
  boundAt: string
  revoked: boolean
}

type PairingResult = { code: string; macDeviceId: string; expiresAt: number }
type HostInfo = { macDeviceId: string; wsUrl: string | null }

type FakePhoneLinkApi = {
  phoneDeviceCreatePairingCode: () => Promise<PairingResult>
  phoneDeviceList: () => Promise<{ devices: PhoneDeviceView[] }>
  phoneDeviceRevoke: (deviceId: string) => Promise<{ revokedCount: number; devices: PhoneDeviceView[] }>
  phoneLinkGetHostInfo: () => Promise<HostInfo>
  phoneLinkOnRelayStatus: (callback: (payload: { status: string }) => void) => () => void
  emitRelayStatus: (status: string) => void
}

function makeDevice(id: string, overrides: Partial<PhoneDeviceView> = {}): PhoneDeviceView {
  return {
    id,
    name: `Phone ${id}`,
    platform: 'ios',
    macDeviceId: 'mac-0123456789abcdef',
    pushToken: null,
    lastSeenAt: null,
    boundAt: '2026-10-01T00:00:00.000Z',
    revoked: false,
    ...overrides,
  }
}

function makeFakeApi(overrides: {
  pairing?: () => Promise<PairingResult>
  list?: () => Promise<{ devices: PhoneDeviceView[] }>
  revoke?: (deviceId: string) => Promise<{ revokedCount: number; devices: PhoneDeviceView[] }>
} = {}): FakePhoneLinkApi {
  const listeners = new Set<(payload: { status: string }) => void>()
  return {
    phoneDeviceCreatePairingCode:
      overrides.pairing ??
      (async () => ({ code: '135790', macDeviceId: 'mac-0123456789abcdef', expiresAt: Date.now() + 300_000 })),
    phoneDeviceList:
      overrides.list ??
      (async () => ({
        devices: [makeDevice('d1', { name: 'iPhone 15 Pro' }), makeDevice('d2', { name: 'iPhone SE' })],
      })),
    phoneDeviceRevoke:
      overrides.revoke ??
      (async (deviceId: string) => ({ revokedCount: 1, devices: [makeDevice(deviceId, { revoked: true })] })),
    phoneLinkGetHostInfo: async () => ({
      macDeviceId: 'mac-0123456789abcdef',
      wsUrl: 'ws://192.168.1.20:9100',
    }),
    phoneLinkOnRelayStatus: callback => {
      listeners.add(callback)
      return () => {
        listeners.delete(callback)
      }
    },
    emitRelayStatus: status => {
      for (const listener of listeners) listener({ status })
    },
  }
}

let fakeApi: FakePhoneLinkApi

beforeEach(() => {
  toastSuccess.mockClear()
  toastError.mockClear()
  fakeApi = makeFakeApi()
  ;(window as unknown as { electronAPI: unknown }).electronAPI = fakeApi
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  i18n.changeLanguage('en')
})

const { cleanup, render, screen, waitFor } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { default: PhoneConnectionSettingsPage } = await import('../PhoneConnectionSettingsPage')

function renderPage() {
  return render(createElement(I18nextProvider, { i18n }, createElement(PhoneConnectionSettingsPage)))
}

describe('PhoneConnectionSettingsPage 渲染', () => {
  it('renders the page shell, pairing QR payload and bound-device count', async () => {
    renderPage()

    // 顶部标题 + N/5 计数（en 复数：count=2 → other）
    expect(
      await screen.findByText('Bound Phones (2 / 5)'),
    ).toBeTruthy()
    expect(screen.getByText('iPhone 15 Pro')).toBeTruthy()
    expect(screen.getByText('iPhone SE')).toBeTruthy()

    // 二维码 payload = JSON {code, wsUrl}；hostInfo 已拉取所以带 LAN 提示
    const qr = await screen.findByTestId('qr-payload')
    expect(qr.getAttribute('data-value')).toBe(
      JSON.stringify({ code: '135790', wsUrl: 'ws://192.168.1.20:9100' }),
    )

    // D02：倒计时 5:00（300s 整）
    expect(screen.getByTestId('pairing-countdown').textContent).toBe(
      'Pairing code expires in 5:00',
    )
  })

  it('keeps 高级信息 collapsed by default and reveals macDeviceId/wsUrl on toggle', async () => {
    const user = userEvent.setup({ document: window.document })
    renderPage()

    expect(screen.queryByText("This Mac's device ID")).toBeNull()
    await user.click(screen.getByTestId('phone-connection-advanced-toggle'))

    const rows = await screen.findAllByTestId('settings-row-value')
    const values = rows.map(row => row.textContent)
    expect(values).toContain('mac-0123456789abcdef')
    expect(values).toContain('ws://192.168.1.20:9100')
  })

  it('shows the offline default for the relay status card until a status event arrives', async () => {
    const { act } = await import('@testing-library/react')
    renderPage()

    expect(await screen.findByText('Not ready')).toBeTruthy()

    await act(async () => {
      fakeApi.emitRelayStatus('online-relay')
    })
    expect(screen.getByText('Ready')).toBeTruthy()

    await act(async () => {
      fakeApi.emitRelayStatus('offline')
    })
    expect(screen.getByText('Not ready')).toBeTruthy()
  })
})

describe('PhoneConnectionSettingsPage 倒计时与重签发', () => {
  it('flips to the expired state and issues a fresh code on Regenerate', async () => {
    const user = userEvent.setup({ document: window.document })
    let calls = 0
    fakeApi = makeFakeApi({
      pairing: async () => {
        calls += 1
        // 首签发已即时过期（模拟主进程时钟折算后的绝对过期时间）
        return {
          code: calls === 1 ? '135790' : '24680A',
          macDeviceId: 'mac-0123456789abcdef',
          expiresAt: Date.now() - 1_000,
        }
      },
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = fakeApi
    renderPage()

    expect(await screen.findByText('Pairing code expired')).toBeTruthy()
    // 过期置灰（D02：过期后二维码不可扫）—— 置灰 class 在 QR 外层包装上
    expect(screen.getByTestId('qr-payload').parentElement?.parentElement?.getAttribute('class')).toContain(
      'opacity-40',
    )

    await user.click(screen.getByRole('button', { name: 'Regenerate' }))

    await waitFor(() => {
      expect(calls).toBe(2)
    })
    await waitFor(() => {
      expect(screen.getByTestId('qr-payload').getAttribute('data-value')).toContain('24680A')
    })
  })
})

describe('PhoneConnectionSettingsPage 撤销流', () => {
  it('requires the confirm dialog and reloads the list after unbinding', async () => {
    const user = userEvent.setup({ document: window.document })
    const revoked: string[] = []
    fakeApi = makeFakeApi({
      revoke: async (deviceId: string) => {
        revoked.push(deviceId)
        return { revokedCount: 1, devices: [] }
      },
      list: async () => ({
        devices: revoked.length
          ? [makeDevice('d2', { name: 'iPhone SE' })]
          : [makeDevice('d1', { name: 'iPhone 15 Pro' }), makeDevice('d2', { name: 'iPhone SE' })],
      }),
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = fakeApi
    renderPage()

    // 每行都有撤销入口；点击行内按钮只应开确认框，不直接调 revoke
    await screen.findByText('iPhone 15 Pro')
    const unbindButtons = screen.getAllByRole('button', { name: 'Unbind' })
    expect(unbindButtons.length).toBeGreaterThanOrEqual(2)
    await user.click(unbindButtons[0])
    expect(revoked).toEqual([])

    // P12 二次确认语义：弹层含「即时受理、最长 60s 全网断开」说明
    expect(screen.getByTestId('dialog')).toBeTruthy()
    expect(screen.getByText('Unbind “iPhone 15 Pro”?')).toBeTruthy()
    expect(
      screen.getByText(
        'Unbinding takes effect immediately and disconnects across the network within 60 seconds at most.',
      ),
    ).toBeTruthy()

    // 弹层内的 destructive 确认按钮（与取消按钮同名「Unbind」，靠样式区分）
    const dialogButtons = screen.getByTestId('dialog').querySelectorAll('button')
    const confirmButton = Array.from(dialogButtons).find(
      button => button.textContent === 'Unbind' && button.className.includes('destructive'),
    )
    expect(confirmButton).toBeTruthy()
    await user.click(confirmButton!)

    await waitFor(() => {
      expect(revoked).toEqual(['d1'])
    })
    expect(toastSuccess).toHaveBeenCalledWith('Device unbound')

    // 事实源是 admin Device 表：受理后列表重拉为 1 台
    await waitFor(() => {
      expect(screen.getByText('Bound Phone (1 / 5)')).toBeTruthy()
    })
    // 确认框关闭
    expect(screen.queryByTestId('dialog')).toBeNull()
  })

  it('keeps the dialog open and surfaces a toast when unbind fails', async () => {
    const user = userEvent.setup({ document: window.document })
    fakeApi = makeFakeApi({
      revoke: async () => {
        throw new Error('revoke rejected by admin')
      },
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = fakeApi
    renderPage()

    await user.click((await screen.findAllByRole('button', { name: 'Unbind' }))[0])
    const dialogButtons = screen.getByTestId('dialog').querySelectorAll('button')
    const confirmButton = Array.from(dialogButtons).find(
      button => button.textContent === 'Unbind' && button.className.includes('destructive'),
    )
    await user.click(confirmButton!)

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('revoke rejected by admin')
    })
    expect(screen.getByTestId('dialog')).toBeTruthy()
  })
})

describe('PhoneConnectionSettingsPage 错误态', () => {
  it('shows the list error state and recovers via Retry', async () => {
    const user = userEvent.setup({ document: window.document })
    let shouldFail = true
    fakeApi = makeFakeApi({
      list: async () => {
        if (shouldFail) throw new Error('list exploded')
        return { devices: [makeDevice('d1')] }
      },
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = fakeApi
    renderPage()

    expect(await screen.findByText('list exploded')).toBeTruthy()
    shouldFail = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByText('Bound Phone (1 / 5)')).toBeTruthy()
  })

  it('falls back to the generic pairing failure message and supports Retry', async () => {
    const user = userEvent.setup({ document: window.document })
    let shouldFail = true
    fakeApi = makeFakeApi({
      pairing: async () => {
        if (shouldFail) throw new Error('boom')
        return { code: '135790', macDeviceId: 'mac-0123456789abcdef', expiresAt: Date.now() + 300_000 }
      },
    })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = fakeApi
    renderPage()

    expect(await screen.findByText('boom')).toBeTruthy()
    shouldFail = false
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByTestId('qr-payload')).toBeTruthy()
  })
})
