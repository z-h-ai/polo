import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ReactElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { getDefaultStore } from 'jotai'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { activeTabIdAtom, openTabsAtom } from '@/atoms/tab-browser'
import { HOME_TAB_ID, POLO_TAB, POLO_TAB_ID, type TabInstance } from '../../../../shared/tab-browser-types'
import type { ProductSpaceContextValue } from '@/context/ProductSpaceContext'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

/**
 * POO-142 review F4/F5: TabContent-level integration for the membership
 * transition banner's mount contract.
 *
 * F2 counterpart: a verified personal-only (unaffiliated) account DOES see
 * the banner above every tab surface; an affiliated (enterprise) account
 * never does and issues no relations read at all.
 *
 * F4 跨 tab 不重复拉取: the banner + the shared MemberCircleResourceProvider
 * live at the TabContent ROOT, above the per-tab surfaces — activating a
 * different tab must neither re-run the relations pull nor remount the
 * banner (same DOM node across tab switches).
 *
 * F5 卸载 lease: the banner's single-flight refresh lock is instance state;
 * a keyed scope remount (modelled here as unmount → fresh mount, exactly
 * what the App-level key does on an account/ProductSpace switch) drops the
 * lock with the instance — an in-flight refresh of the dead instance can
 * never park the fresh mount's button in `aria-busy`.
 */

GlobalRegistrator.register()
setupI18n()

// The banner pulls the Vite-hosted theme singleton through
// client-workbench → client-workbench-style; stub it like the banner's own
// interaction test does.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

// The home surface is out of scope here (its wiring has dedicated coverage):
// a probe keeps the tab-switch assertions focused on the banner/provider.
mock.module('@/components/circles/ClientHomeRouter', () => ({
  ClientHomeRouter: () => createElement('div', { 'data-testid': 'home-router-probe' }),
}))

const accountId = 'account-banner-int'
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

const bridgeCalls = { list: 0, listMemberships: 0 }
Object.defineProperty(window, 'electronAPI', {
  configurable: true,
  value: {
    memberCircles: {
      list: async () => {
        bridgeCalls.list += 1
        return { success: true as const, circles: [] }
      },
      listMemberships: async () => {
        bridgeCalls.listMemberships += 1
        return { success: true as const, memberships: [] }
      },
    },
  },
})

function contextValue(overrides: Record<string, unknown> = {}): ProductSpaceContextValue {
  return {
    accountId,
    activeProductSpaceId: personalId,
    activeProductSpace: personalSpace,
    productSpaces: [personalSpace],
    allProductSpaces: [personalSpace],
    membershipListVerified: true,
    personalProductSpaceId: personalId,
    productSpaceContextKey: `["product-space",1,"${accountId}","${personalId}"]`,
    contextVersion: 1,
    pendingSwitch: null,
    onSelectProductSpace: () => {},
    onRefreshProductSpaces: async () => [personalSpace],
    onConfirmStopAndSwitch: () => {},
    onRetryFailedStops: () => {},
    onRetryTargetLoad: () => {},
    onCancelSwitch: () => {},
    onDismissTargetAccessLost: () => {},
    onStopSwitchExecution: () => {},
    ...overrides,
  } as unknown as ProductSpaceContextValue
}

function tree(value: ProductSpaceContextValue): ReactElement {
  const { ProductSpaceProvider } =
    require('@/context/ProductSpaceContext') as typeof import('@/context/ProductSpaceContext')
  const { TabShellProvider } =
    require('@/context/TabShellContext') as typeof import('@/context/TabShellContext')
  const { TabContent } =
    require('../TabContent') as typeof import('../TabContent')
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(ProductSpaceProvider, {
      value,
      children: createElement(
        TabShellProvider,
        {
          workspaceId: 'ws-poo142',
          productSpaceScope: { accountId, productSpaceId: personalId },
          children: createElement(TabContent, {
            renderPolo: () => createElement('div', { 'data-testid': 'polo-probe' }),
          }),
        },
      ),
    }),
  )
}

function settle(): Promise<void> {
  return new Promise(done => setTimeout(done, 20))
}

beforeEach(async () => {
  await i18n.changeLanguage('zh-Hans')
  bridgeCalls.list = 0
  bridgeCalls.listMemberships = 0
  localStorage.clear()
})

afterEach(() => {
  const { cleanup } = require('@testing-library/react') as { cleanup: () => void }
  cleanup()
  const store = getDefaultStore()
  store.set(openTabsAtom, [POLO_TAB] as TabInstance[])
  store.set(activeTabIdAtom, HOME_TAB_ID)
  localStorage.clear()
})

const { act, fireEvent, render, screen, waitFor } = await import('@testing-library/react')

describe('TabContent membership banner integration (POO-142 F2/F4/F5)', () => {
  it('F2 counterpart: a verified personal-only account sees the banner above the tab surfaces', async () => {
    render(tree(contextValue()))
    const banner = await waitFor(() => {
      const node = screen.getByTestId(BANNER)
      expect(node.getAttribute('role')).toBe('status')
      return node
    })
    expect(banner.textContent).toContain('当前账号尚未加入企业。通过邀请加入后，审批通过会自动生效。')
    // Exactly ONE relations round serves the banner AND the (stubbed) home
    // surface: the banner shares THE provider, it is not a second read
    // surface.
    await waitFor(() => expect(bridgeCalls.list).toBe(1))
    expect(bridgeCalls.listMemberships).toBe(1)
  })

  it('F2: an affiliated (enterprise) account never sees the banner and issues no relations read', async () => {
    const ent = enterpriseSpace
    render(tree(contextValue({
      activeProductSpaceId: ent.id,
      activeProductSpace: ent,
      productSpaces: [personalSpace, ent],
      allProductSpaces: [personalSpace, ent],
    })))
    await act(async () => {
      await settle()
    })
    // Hydration settled, home surface mounted, and the banner is nowhere.
    expect(screen.getByTestId('home-router-probe')).toBeTruthy()
    expect(screen.queryByTestId(BANNER)).toBeNull()
    expect(screen.queryByTestId(REFRESH)).toBeNull()
    // The enterprise scope denies circle reads by contract — no round ran.
    expect(bridgeCalls.list).toBe(0)
    expect(bridgeCalls.listMemberships).toBe(0)
  })

  it('F4 跨 tab: activating another tab neither re-runs the relations pull nor remounts the banner', async () => {
    render(tree(contextValue()))
    const banner = await waitFor(() => screen.getByTestId(BANNER))
    await waitFor(() => expect(bridgeCalls.list).toBe(1))

    // home → polo: the surfaces swap UNDER the banner.
    act(() => {
      getDefaultStore().set(activeTabIdAtom, POLO_TAB_ID)
    })
    expect(screen.getByTestId('polo-probe')).toBeTruthy()
    expect(screen.queryByTestId('home-router-probe')).toBeNull()
    // Same DOM node: the banner was NOT remounted for the new tab.
    expect(screen.getByTestId(BANNER)).toBe(banner)
    expect(bridgeCalls.list).toBe(1)

    // polo → home again: still one round, still the same instance.
    act(() => {
      getDefaultStore().set(activeTabIdAtom, HOME_TAB_ID)
    })
    expect(screen.getByTestId(BANNER)).toBe(banner)
    expect(bridgeCalls.list).toBe(1)
    expect(bridgeCalls.listMemberships).toBe(1)
  })

  it('F5 卸载 lease: an in-flight refresh lock dies with the instance and never parks the fresh mount', async () => {
    // Scope 1: a manual refresh whose spaces read is held in flight.
    let releaseFirst!: () => void
    const gatedFirst = new Promise<ProductSpaceSummary[] | null>(resolve => {
      releaseFirst = () => resolve([personalSpace])
    })
    const first = render(tree(contextValue({
      onRefreshProductSpaces: () => gatedFirst,
    })))
    await waitFor(() => expect(screen.getByTestId(BANNER)).toBeTruthy())
    fireEvent.click(screen.getByTestId(REFRESH))
    await waitFor(() => {
      const button = screen.getByTestId(REFRESH)
      expect(button.getAttribute('aria-busy')).toBe('true')
      expect((button as unknown as HTMLButtonElement).disabled).toBe(true)
    })
    // The click re-ran both channels: the relations round + the gated read.
    await waitFor(() => expect(bridgeCalls.list).toBe(2))

    // The keyed scope remount: the instance HOLDING the lock dies.
    first.unmount()
    expect(screen.queryByTestId(BANNER)).toBeNull()

    // The dead instance's read settles AFTER the unmount — its completion
    // must not throw and must not leak into any newer instance.
    await act(async () => {
      releaseFirst()
      await gatedFirst
    })
    await settle()

    // Scope 2 (the remounted scope): the lock is NOT inherited — the button
    // is immediately usable, and clicking it starts a real new round.
    let releaseSecond!: () => void
    const gatedSecond = new Promise<ProductSpaceSummary[] | null>(resolve => {
      releaseSecond = () => resolve([personalSpace])
    })
    render(tree(contextValue({
      onRefreshProductSpaces: () => gatedSecond,
    })))
    await waitFor(() => expect(screen.getByTestId(BANNER)).toBeTruthy())
    const freshButton = await waitFor(() => {
      const node = screen.getByTestId(REFRESH)
      expect((node as unknown as HTMLButtonElement).disabled).toBe(false)
      expect(node.getAttribute('aria-busy')).toBe('false')
      return node
    })
    // The fresh provider ran exactly its own auto round.
    await waitFor(() => expect(bridgeCalls.list).toBe(3))

    fireEvent.click(freshButton)
    await waitFor(() => {
      expect(screen.getByTestId(REFRESH).getAttribute('aria-busy')).toBe('true')
    })
    await waitFor(() => expect(bridgeCalls.list).toBe(4))
    releaseSecond()
  })
})
