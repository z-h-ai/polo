import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { i18n, LOCALE_REGISTRY, setupI18n } from '@polo-ai/shared/i18n'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

// Bun does not execute Vite import.meta.glob in the theme loader. The banner
// pulls it in via client-workbench → client-workbench-style → ThemeContext.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

GlobalRegistrator.register()
setupI18n()

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { MemberCircleResourceProvider } = await import('@/context/MemberCircleResourceContext')
const { MembershipTransitionBanner } = await import('../MembershipTransitionBanner')

const accountId = 'account-a'
const personalId = 'space-personal'
const personalSpace = {
  id: personalId,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
} as unknown as ProductSpaceSummary
const enterpriseSpace = {
  id: 'space-ent',
  kind: 'enterprise',
  enterpriseId: 'enterprise-1',
  name: '北辰智能科技',
  role: 'member',
  accessMode: 'active',
  payer: { kind: 'enterprise', enterpriseId: 'enterprise-1' },
} as unknown as ProductSpaceSummary

const BANNER = 'membership-transition-banner'
const REFRESH = 'membership-transition-refresh'

type CirclesListResult =
  | { success: true; circles: unknown[] }
  | { success: false; errorCode: string; message: string }
type MembershipsListResult =
  | { success: true; memberships: unknown[] }
  | { success: false; errorCode: string; message: string }

interface CirclesBridgeConfig {
  circlesResult: CirclesListResult | Promise<CirclesListResult>
  membershipsResult: MembershipsListResult | Promise<MembershipsListResult>
  /** Per-test override for the memberships read (slow/pending rounds). */
  listMembershipsOverride?: () => Promise<MembershipsListResult>
}

const bridgeCalls = { list: 0, listMemberships: 0 }
let bridge: CirclesBridgeConfig = {
  circlesResult: { success: true, circles: [] },
  membershipsResult: { success: true, memberships: [] },
}

Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    memberCircles: {
      list: async () => {
        bridgeCalls.list += 1
        return await bridge.circlesResult
      },
      listMemberships: async () => {
        bridgeCalls.listMemberships += 1
        if (bridge.listMembershipsOverride) return await bridge.listMembershipsOverride()
        return await bridge.membershipsResult
      },
    },
  },
})

function makeContextValue(overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    activeProductSpaceId: personalId,
    activeProductSpace: personalSpace,
    productSpaces: [personalSpace],
    allProductSpaces: [personalSpace],
    // The banner may only speak from an ONLINE-verified list (POO-142).
    membershipListVerified: true,
    personalProductSpaceId: personalId,
    productSpaceContextKey: JSON.stringify(['product-space', 1, accountId, personalId]),
    contextVersion: 1,
    pendingSwitch: null,
    onSelectProductSpace: mock(() => {}),
    onRefreshProductSpaces: mock(() => {}),
    onConfirmStopAndSwitch: mock(() => {}),
    onRetryFailedStops: mock(() => {}),
    onRetryTargetLoad: mock(() => {}),
    onCancelSwitch: mock(() => {}),
    onDismissTargetAccessLost: mock(() => {}),
    ...overrides,
  }
}

function tree(value: Record<string, unknown>, bannerProps: Record<string, unknown> = {}): ReactElement {
  const Provider = ProductSpaceProvider as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement
  const CirclesProvider = MemberCircleResourceProvider as unknown as (
    props: Record<string, unknown>,
  ) => ReactElement
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      Provider,
      { value },
      createElement(
        CirclesProvider,
        { catalog: null },
        createElement(MembershipTransitionBanner, bannerProps),
      ),
    ),
  )
}

function renderBanner(value: Record<string, unknown>, bannerProps: Record<string, unknown> = {}) {
  return render(tree(value, bannerProps))
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

function settle(): Promise<void> {
  return new Promise(done => setTimeout(done, 20))
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
  bridge = {
    circlesResult: { success: true, circles: [] },
    membershipsResult: { success: true, memberships: [] },
  }
  bridgeCalls.list = 0
  bridgeCalls.listMemberships = 0
})

afterEach(() => {
  cleanup()
})

describe('MembershipTransitionBanner', () => {
  it('shows the enterprise copy for a verified personal-only account with empty relations', async () => {
    renderBanner(makeContextValue())
    const banner = await waitFor(() => {
      const node = screen.getByTestId(BANNER)
      expect(node.getAttribute('role')).toBe('status')
      return node
    })
    expect(banner.textContent).toContain('当前账号尚未加入企业。通过邀请加入后，审批通过会自动生效。')
    expect(screen.getByTestId(REFRESH).textContent).toBe('刷新状态')
    expect(bridgeCalls.list).toBe(1)
  })

  it('never shows for affiliated accounts (enterprise of any mode, or circles-only)', async () => {
    renderBanner(makeContextValue({
      allProductSpaces: [personalSpace, enterpriseSpace],
      productSpaces: [personalSpace, enterpriseSpace],
      activeProductSpaceId: 'space-ent',
      activeProductSpace: enterpriseSpace,
    }))
    await settle()
    expect(screen.queryByTestId(BANNER)).toBeNull()
    // The enterprise scope denies circle reads by contract — no read issued.
    expect(bridgeCalls.list).toBe(0)
    cleanup()

    // Circles-only account: a positive relations receipt hides the banner.
    bridge = {
      circlesResult: { success: true, circles: [{ id: 'c1' }] },
      membershipsResult: { success: true, memberships: [{ id: 'm1' }] },
    }
    renderBanner(makeContextValue())
    await waitFor(() => expect(bridgeCalls.list).toBe(1))
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it('never shows from an unverified (cached/offline) space list', async () => {
    renderBanner(makeContextValue({ membershipListVerified: false }))
    await waitFor(() => expect(bridgeCalls.list).toBe(1))
    // The relations receipts DID settle empty — the missing online
    // verification alone is enough to keep the banner silent.
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it('stays unknown until BOTH relations receipts exist', async () => {
    const pending = deferred<MembershipsListResult>()
    bridge = {
      circlesResult: { success: true, circles: [] },
      membershipsResult: pending.promise,
    }
    renderBanner(makeContextValue())
    await settle()
    expect(screen.queryByTestId(BANNER)).toBeNull()
    pending.resolve({ success: true, memberships: [] })
    await waitFor(() => expect(screen.getByTestId(BANNER)).toBeTruthy())
  })

  it('renders the parameterized circle copy for the circle audience', async () => {
    renderBanner(makeContextValue(), { audience: 'circle' })
    const banner = await waitFor(() => screen.getByTestId(BANNER))
    expect(banner.textContent).toContain('当前账号尚未加入任何圈子。通过邀请加入后，审批通过会自动生效。')
  })

  it('hides while a space switch is pending', async () => {
    renderBanner(makeContextValue({
      pendingSwitch: { targetId: 'space-ent', phase: 'confirm', executions: [], statuses: {}, errorCode: null },
    }))
    await waitFor(() => expect(bridgeCalls.list).toBe(1))
    expect(screen.queryByTestId(BANNER)).toBeNull()
  })

  it('manual refresh re-reads both membership channels once and heals on a positive receipt', async () => {
    const refreshProductSpaces = mock(async () => [personalSpace])
    renderBanner(makeContextValue({ onRefreshProductSpaces: refreshProductSpaces }))
    await waitFor(() => expect(screen.getByTestId(BANNER)).toBeTruthy())
    expect(bridgeCalls.list).toBe(1)

    bridge = {
      circlesResult: { success: true, circles: [] },
      membershipsResult: { success: true, memberships: [{ id: 'm-late' }] },
    }
    fireEvent.click(screen.getByTestId(REFRESH))
    await waitFor(() => expect(refreshProductSpaces).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(bridgeCalls.list).toBe(2))
    await waitFor(() => expect(bridgeCalls.listMemberships).toBe(2))
    // A positive membership receipt from the refresh heals the banner away.
    await waitFor(() => expect(screen.queryByTestId(BANNER)).toBeNull())
  })

  it('disables the refresh button while a round is in flight (single-flight)', async () => {
    const pending = deferred<MembershipsListResult>()
    let firstRound = true
    bridge = {
      circlesResult: { success: true, circles: [] },
      membershipsResult: { success: true, memberships: [] },
      listMembershipsOverride: async () => {
        if (firstRound) {
          firstRound = false
          return { success: true, memberships: [] }
        }
        return await pending.promise
      },
    }
    renderBanner(makeContextValue())
    await waitFor(() => expect(screen.getByTestId(BANNER)).toBeTruthy())

    fireEvent.click(screen.getByTestId(REFRESH))
    const busy = await waitFor(() => {
      const button = screen.getByTestId(REFRESH)
      expect(button.getAttribute('aria-busy')).toBe('true')
      expect((button as unknown as HTMLButtonElement).disabled).toBe(true)
      expect(button.textContent).toBe('正在刷新…')
      return button
    })
    // A second click during the in-flight round starts no second round.
    fireEvent.click(busy)
    await settle()
    expect(bridgeCalls.list).toBe(2)
    pending.resolve({ success: true, memberships: [] })
    await waitFor(() => {
      const button = screen.getByTestId(REFRESH)
      expect((button as unknown as HTMLButtonElement).disabled).toBe(false)
      expect(button.textContent).toBe('刷新状态')
    })
  })

  it('keeps the banner through a failed manual refresh instead of clearing it', async () => {
    const refreshProductSpaces = mock(async () => null)
    renderBanner(makeContextValue({ onRefreshProductSpaces: refreshProductSpaces }))
    await waitFor(() => expect(screen.getByTestId(BANNER)).toBeTruthy())
    bridge = {
      circlesResult: { success: false, errorCode: 'network_error', message: 'down' },
      membershipsResult: { success: false, errorCode: 'network_error', message: 'down' },
    }
    fireEvent.click(screen.getByTestId(REFRESH))
    await waitFor(() => expect(refreshProductSpaces).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(bridgeCalls.list).toBe(2))
    // Failed reads keep the previous receipts: still proven-empty, still
    // shown, button retryable.
    expect(screen.getByTestId(BANNER)).toBeTruthy()
    expect((screen.getByTestId(REFRESH) as unknown as HTMLButtonElement).disabled).toBe(false)
  })

  it('renders the four keys in every supported locale', async () => {
    const keys = [
      'membershipTransition.circle.message',
      'membershipTransition.enterprise.message',
      'membershipTransition.refresh',
      'membershipTransition.refreshing',
    ] as const
    for (const code of Object.keys(LOCALE_REGISTRY) as Array<keyof typeof LOCALE_REGISTRY>) {
      const messages = LOCALE_REGISTRY[code].messages
      for (const key of keys) {
        expect(typeof messages[key]).toBe('string')
        expect((messages[key] as string).length).toBeGreaterThan(0)
      }
    }
    await i18n.changeLanguage('en')
    renderBanner(makeContextValue())
    const banner = await waitFor(() => screen.getByTestId(BANNER))
    expect(banner.textContent).toContain('This account has not joined an enterprise yet.')
    expect(screen.getByTestId(REFRESH).textContent).toBe('Refresh status')
  })
})
