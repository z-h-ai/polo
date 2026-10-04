import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { MemberCircleSupportState } from '@polo-ai/shared/admin'
import type {
  MemberCircleSupportReadState,
  MemberCirclesResource,
} from '@/hooks/useMemberCircles'
import type { CircleSupportTarget } from '../CircleSupportPanel'

// -------------------------------------------------------------------------
// Isolated-process host (own bun process; same pattern as
// MyCirclesPage.interaction.isolated.ts): the ProductSpace binding is a
// mutable module double, the trusted C1 bridge is a recorded window stub.
// -------------------------------------------------------------------------

GlobalRegistrator.register()
setupI18n()

let productSpaceContextState: unknown = {
  accountId: 'account-a-fixture',
  activeProductSpaceId: 'personal-space',
  personalProductSpaceId: 'personal-space',
  productSpaceContextKey: '["product-space",1,"account-a-fixture","personal-space"]',
  contextVersion: 1,
  activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
}

function accountBinding(accountId: string, contextVersion: number) {
  return {
    accountId,
    activeProductSpaceId: 'personal-space',
    personalProductSpaceId: 'personal-space',
    productSpaceContextKey: `["product-space",1,"${accountId}","personal-space"]`,
    contextVersion,
    activeProductSpace: { id: 'personal-space', kind: 'personal', name: '个人空间', accessMode: 'active' },
  }
}

// Recorded bridge: every invoked method name lands in calledMethods so the
// tests can prove the panel issues READS ONLY (P70-SUPPORT-02: no fake
// support request — no ticket/message/POST surface is ever touched).
let calledMethods: string[] = []
let supportCalls = 0
let holdSupport = false
const pendingSupportResolvers: Array<() => void> = []
// Per-account getSupport payloads: a receipt issued for one account must
// never render after a scope rebind (错账号 / session fence).
const supportResultByAccount: Record<string, MemberCircleRpcSupportResult> = {}
let currentAccount = 'account-a-fixture'

type MemberCircleRpcSupportResult =
  | { success: true; support: MemberCircleSupportState }
  | { success: false; errorCode: string; message: string }

let fetchCalls: string[] = []

// The C2 relations hook reads the ProductSpace binding through this context;
// the mutable double above is the harness's only binding authority.
mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
}))

function recorded(name: string, run: () => Promise<unknown>) {
  return () => {
    calledMethods.push(name)
    return run()
  }
}

beforeEach(() => {
  calledMethods = []
  supportCalls = 0
  holdSupport = false
  pendingSupportResolvers.length = 0
  fetchCalls = []
  currentAccount = 'account-a-fixture'
  productSpaceContextState = accountBinding('account-a-fixture', 1)
  supportResultByAccount['account-a-fixture'] = {
    success: true,
    support: { availability: 'upstream_pending', contractGap: 'G4' },
  }
  supportResultByAccount['account-b-fixture'] = {
    success: true,
    support: { availability: 'upstream_pending', contractGap: 'G4' },
  }
  // Network is disabled in this process: any fetch attempt is recorded and
  // rejected, so "no fake support request" is observable, not assumed.
  Object.defineProperty(window, 'fetch', {
    configurable: true,
    value: (...args: unknown[]) => {
      fetchCalls.push(String(args[0]))
      return Promise.reject(new Error('network disabled in test'))
    },
  })
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      memberCircles: {
        list: recorded('list', () => Promise.resolve({ success: true, circles: [] })),
        listMemberships: recorded('listMemberships', () => Promise.resolve({ success: true, memberships: [] })),
        previewRenewal: recorded('previewRenewal', () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'stub' })),
        leave: recorded('leave', () => Promise.resolve({ success: false, errorCode: 'conflict', message: 'stub' })),
        getOrder: recorded('getOrder', () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'stub' })),
        getCheckoutResult: recorded('getCheckoutResult', () => Promise.resolve({ success: false, errorCode: 'not_found', message: 'stub' })),
        getUpdates: recorded('getUpdates', () => Promise.resolve({ success: true, updates: { availability: 'upstream_pending', contractGap: 'G2' } })),
        getProfile: recorded('getProfile', () => Promise.resolve({ success: true, profile: { availability: 'upstream_pending', contractGap: 'G3' } })),
        getSupport: recorded('getSupport', () => {
          supportCalls += 1
          if (holdSupport) {
            return new Promise(resolve => {
              pendingSupportResolvers.push(() => resolve(supportResultByAccount[currentAccount]))
            })
          }
          return Promise.resolve(supportResultByAccount[currentAccount])
        }),
      },
    },
  })
})

// Clipboard double: happy-dom has no usable clipboard bridge, so the tests
// install one (or leave it missing to exercise the honest failure path).
let clipboardWrites: string[] = []

function installClipboard(mode: 'ok' | 'reject' | 'missing') {
  clipboardWrites = []
  const value = mode === 'missing'
    ? undefined
    : {
        writeText: (text: string) => {
          if (mode === 'reject') return Promise.reject(new Error('write denied'))
          clipboardWrites.push(text)
          return Promise.resolve()
        },
      }
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value })
}

// -------------------------------------------------------------------------
// Fixtures — the C9-assembled target (own circle/order facts ONLY)
// -------------------------------------------------------------------------

function orderTargetFixture(): CircleSupportTarget {
  return {
    kind: 'order',
    circleId: 'circle-design',
    orderId: 'SUB-20261002-0182',
    circleName: 'Morning Star Design Circle',
    issueSummary: 'Could not verify the original order and eligibility',
  }
}

const CONFIGURED_SUPPORT: MemberCircleSupportState = {
  availability: 'available',
  configured: true,
  guidance: 'Scan the QR code in your bank app to contact support.',
}

// -------------------------------------------------------------------------
// Render harness
// -------------------------------------------------------------------------

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { MemberCircleResourceProvider } = await import('@/context/MemberCircleResourceContext')
const {
  CircleSupportPanel,
  redactSensitiveFacts,
  supportCopyFacts,
} = await import('../CircleSupportPanel')

afterEach(() => {
  cleanup()
})

interface TreeOptions {
  accountId: string
  contextVersion?: number
  target: CircleSupportTarget
  onBack?: () => void
  onRecheck?: () => void
}

/** Full-provider tree: the REAL C2 hook drives supportState via the stub. */
function providerTree(options: TreeOptions) {
  const contextVersion = options.contextVersion ?? 1
  productSpaceContextState = accountBinding(options.accountId, contextVersion)
  currentAccount = options.accountId
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(
      MemberCircleResourceProvider,
      null,
      createElement(CircleSupportPanel, {
        target: options.target,
        onBack: options.onBack ?? (() => {}),
        onRecheck: options.onRecheck,
      }),
    ),
  )
}

function makeInjectedResource(
  supportState: MemberCircleSupportReadState,
): MemberCirclesResource {
  return {
    state: {
      phase: 'ready',
      scope: {
        accountId: 'account-a-fixture',
        personalProductSpaceId: 'personal-space',
        contextKey: '["product-space",1,"account-a-fixture","personal-space"]',
        epoch: 1,
      },
      circles: [],
      memberships: [],
      circlesError: null,
      membershipsError: null,
      refreshing: false,
      updatedAt: 1,
    },
    circles: [],
    memberships: [],
    updateStates: {},
    profileStates: {},
    supportState,
    getCircle: () => ({ availability: 'unknown_circle' as const }),
    refresh: async () => ({ skipped: true as const, reason: 'no_scope' as const }),
    invalidateAndRefresh: async () => ({ relations: 'skipped' as const, catalog: 'unavailable' as const, circleId: null, orderId: null }),
    previewRenewal: async () => ({ success: false as const, errorCode: 'not_found' as const, message: 'injected' }),
    leave: async () => ({ success: false as const, errorCode: 'conflict' as const, message: 'injected' }),
    getOrder: async () => ({ success: false as const, errorCode: 'not_found' as const, message: 'injected' }),
    getCheckoutResult: async () => ({ success: false as const, errorCode: 'not_found' as const, message: 'injected' }),
    getUpdates: async () => ({ success: true as const, updates: { availability: 'upstream_pending' as const, contractGap: 'G2' as const } }),
    refreshUpdates: async () => ({ success: true as const, updates: { availability: 'upstream_pending' as const, contractGap: 'G2' as const } }),
    getProfile: async () => ({ success: true as const, profile: { availability: 'upstream_pending' as const, contractGap: 'G3' as const } }),
    getSupport: async () => ({ success: true as const, support: { availability: 'upstream_pending' as const, contractGap: 'G4' as const } }),
    refreshSupport: async () => ({ success: true as const, support: { availability: 'upstream_pending' as const, contractGap: 'G4' as const } }),
  }
}

interface InjectedOptions {
  supportState: MemberCircleSupportReadState
  target: CircleSupportTarget
  onBack?: () => void
  onRecheck?: () => void
}

/** Injected-resource tree: a pre-built C2 receipt, no bridge involvement. */
function renderInjected(options: InjectedOptions) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(MemberCircleResourceProvider, {
        resource: makeInjectedResource(options.supportState),
        children: createElement(CircleSupportPanel, {
          target: options.target,
          onBack: options.onBack ?? (() => {}),
          onRecheck: options.onRecheck,
        }),
      }),
    ),
  )
}

// -------------------------------------------------------------------------
// P70-SUPPORT-01 — real configuration, and the mount read contract
// -------------------------------------------------------------------------

describe('CircleSupportPanel mount read and configured support (P70-SUPPORT-01)', () => {
  it('issues the FIRST authoritative read on mount (loading → configured), then never again', async () => {
    supportResultByAccount['account-a-fixture'] = { success: true, support: CONFIGURED_SUPPORT }
    holdSupport = true
    const view = render(providerTree({ accountId: 'account-a-fixture', target: orderTargetFixture() }))

    expect(screen.getByTestId('circle-support-panel')).toBeTruthy()
    expect(screen.getByTestId('circle-support-loading')).toBeTruthy()
    expect(screen.queryByTestId('circle-support-configured')).toBeNull()

    await act(async () => {
      for (const resolve of pendingSupportResolvers.splice(0)) resolve()
    })
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-configured')).toBeTruthy()
    })
    // The provider's guidance text renders verbatim — no fabricated QR asset.
    expect(screen.getByTestId('circle-support-configured').textContent)
      .toBe('Scan the QR code in your bank app to contact support.')
    // The ready receipt stops the mount effect from re-reading: exactly one
    // authoritative getSupport, no polling (P70-SUPPORT-03: no auto recheck).
    expect(supportCalls).toBe(1)

    view.unmount()
  })

  it('renders configured-without-guidance as the platform fact, never a sample code', async () => {
    supportResultByAccount['account-a-fixture'] = {
      success: true,
      support: { availability: 'available', configured: true, guidance: null },
    }
    render(providerTree({ accountId: 'account-a-fixture', target: orderTargetFixture() }))
    const configured = await waitFor(() => screen.getByTestId('circle-support-configured'))
    expect(configured.textContent).toBe(
      'A support QR code is configured on the platform. Follow the support guidance to get in touch.',
    )
    expect(configured.querySelector('img')).toBeNull()
  })
})

// -------------------------------------------------------------------------
// P70-SUPPORT-01 — unconfigured vs load-failed vs upstream-pending are
// DISTINCT ready facts (G4, verbatim from C2)
// -------------------------------------------------------------------------

describe('CircleSupportPanel distinct support states (P70-SUPPORT-01 / G4)', () => {
  it('renders UNCONFIGURED as its own state — distinct from failure and from configured', () => {
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'available', configured: false, guidance: null } },
      target: orderTargetFixture(),
    })
    expect(screen.getByTestId('circle-support-unconfigured').textContent)
      .toBe('The platform has no support QR code configured yet')
    expect(screen.queryByTestId('circle-support-configured')).toBeNull()
    expect(screen.queryByTestId('circle-support-load-failed')).toBeNull()
    expect(screen.queryByTestId('circle-support-error')).toBeNull()
    expect(screen.queryByTestId('circle-support-forbidden')).toBeNull()
  })

  it('renders the upstream-reported LOAD_FAILED state distinct from unconfigured', () => {
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'load_failed' } },
      target: orderTargetFixture(),
    })
    expect(screen.getByTestId('circle-support-load-failed')).toBeTruthy()
    expect(screen.queryByTestId('circle-support-unconfigured')).toBeNull()
    expect(screen.queryByTestId('circle-support-configured')).toBeNull()
    // A read failure can still be reloaded by hand, and the processing-status
    // fact stays honest (contacting support ≠ acceptance).
    expect(screen.getByTestId('circle-support-reload')).toBeTruthy()
    expect(screen.getByTestId('circle-support-status-fact')).toBeTruthy()
  })

  it('renders G4 upstream_pending as awaiting-upstream — NOT empty success, NOT an error', () => {
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'upstream_pending', contractGap: 'G4' } },
      target: orderTargetFixture(),
    })
    expect(screen.getByTestId('circle-support-pending-upstream')).toBeTruthy()
    expect(screen.queryByTestId('circle-support-error')).toBeNull()
    expect(screen.queryByTestId('circle-support-load-failed')).toBeNull()
    expect(screen.queryByTestId('circle-support-unconfigured')).toBeNull()
    expect(screen.queryByTestId('circle-support-configured')).toBeNull()
    // Copy of the user's OWN facts stays available in this state.
    expect(screen.getByTestId('circle-support-copy')).toBeTruthy()
    // Injected receipt: the bridge was never touched.
    expect(calledMethods.length).toBe(0)
  })
})

// -------------------------------------------------------------------------
// P70-SUPPORT-01 — bridge read failure (503) and manual-only recovery
// -------------------------------------------------------------------------

describe('CircleSupportPanel read failure and manual reload (P70-SUPPORT-01/03)', () => {
  it('renders a 503-class bridge failure distinct from unconfigured and recovers ONLY by manual reload', async () => {
    supportResultByAccount['account-a-fixture'] = {
      success: false,
      errorCode: 'service_unavailable',
      message: 'upstream 503',
    }
    render(providerTree({ accountId: 'account-a-fixture', target: orderTargetFixture() }))
    expect(await waitFor(() => screen.getByTestId('circle-support-error'))).toBeTruthy()
    expect(screen.queryByTestId('circle-support-unconfigured')).toBeNull()
    expect(screen.queryByTestId('circle-support-configured')).toBeNull()

    const callsBeforeReload = supportCalls
    supportResultByAccount['account-a-fixture'] = { success: true, support: CONFIGURED_SUPPORT }
    fireEvent.click(screen.getByTestId('circle-support-reload'))
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-configured')).toBeTruthy()
    })
    expect(supportCalls).toBe(callsBeforeReload + 1)
  })

  it('renders the permission-blocked state INSTEAD of support content, with no reload affordance (错账号)', async () => {
    supportResultByAccount['account-a-fixture'] = {
      success: false,
      errorCode: 'unauthorized',
      message: 'identity is not allowed to read support configuration',
    }
    render(providerTree({ accountId: 'account-a-fixture', target: orderTargetFixture() }))
    expect(await waitFor(() => screen.getByTestId('circle-support-forbidden'))).toBeTruthy()
    expect(screen.queryByTestId('circle-support-configured')).toBeNull()
    expect(screen.queryByTestId('circle-support-unconfigured')).toBeNull()
    expect(screen.queryByTestId('circle-support-reload')).toBeNull()
  })

  it('never renders a support receipt that crossed a scope rebind (wrong account)', async () => {
    supportResultByAccount['account-a-fixture'] = { success: true, support: CONFIGURED_SUPPORT }
    supportResultByAccount['account-b-fixture'] = {
      success: true,
      support: { availability: 'upstream_pending', contractGap: 'G4' },
    }
    holdSupport = true
    const view = render(providerTree({ accountId: 'account-a-fixture', target: orderTargetFixture() }))

    // A → B rebind while BOTH reads are held: A's configured receipt must be
    // discarded by the C2 scope fence, B's own upstream fact may render.
    await act(async () => {
      view.rerender(providerTree({ accountId: 'account-b-fixture', contextVersion: 2, target: orderTargetFixture() }))
    })
    await act(async () => {
      for (const resolve of pendingSupportResolvers.splice(0)) resolve()
    })
    await waitFor(() => {
      expect(screen.queryByTestId('circle-support-pending-upstream')).toBeTruthy()
    })
    expect(screen.queryByTestId('circle-support-configured')).toBeNull()
  })
})

// -------------------------------------------------------------------------
// P70-SUPPORT-02 — the copy allowlist
// -------------------------------------------------------------------------

describe('CircleSupportPanel copy allowlist (P70-SUPPORT-02)', () => {
  it('copies EXACTLY the own order/circle/issue facts — nothing else', async () => {
    installClipboard('ok')
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'available', configured: false, guidance: null } },
      target: orderTargetFixture(),
    })
    const textarea = screen.getByTestId('circle-support-info-text') as HTMLTextAreaElement
    expect(textarea.value).toBe(
      'Order: SUB-20261002-0182\n'
      + 'Circle: Morning Star Design Circle (circle-design)\n'
      + 'Issue: Could not verify the original order and eligibility',
    )
    fireEvent.click(screen.getByTestId('circle-support-copy'))
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-copy-status').textContent)
        .toBe('Copied. Provide it yourself through the external support channel.')
    })
    // The clipboard text is EXACTLY the allowlisted lines — no token, no
    // verification code, no phone number can appear because the target type
    // has no such field and the builder emits nothing else.
    expect(clipboardWrites).toEqual([
      'Order: SUB-20261002-0182\n'
      + 'Circle: Morning Star Design Circle (circle-design)\n'
      + 'Issue: Could not verify the original order and eligibility',
    ])
    expect(calledMethods.length).toBe(0)
    expect(fetchCalls.length).toBe(0)
  })

  it('redacts phone-shaped digit runs in the free-text summary as defense in depth', () => {
    expect(redactSensitiveFacts('call 13812345678 about order SUB-20261002-0182'))
      .toBe('call 138****78 about order SUB-20261002-0182')
    const facts = supportCopyFacts({
      kind: 'circle',
      circleId: null,
      orderId: null,
      circleName: null,
      issueSummary: 'contact 13812345678',
    })
    expect(facts).toEqual([{ kind: 'issue', value: 'contact 138****78' }])
  })

  it('emits only present facts, in the fixed order, with identifiers kept intact', () => {
    // Only a circleId (no name): the identifier itself is the fact.
    expect(supportCopyFacts({
      kind: 'circle',
      circleId: 'circle-b',
      orderId: null,
      circleName: null,
      issueSummary: 'join failed',
    })).toEqual([
      { kind: 'circle', value: 'circle-b' },
      { kind: 'issue', value: 'join failed' },
    ])
    // Digit-rich order ids pass through unmangled — redaction targets only
    // phone-shaped runs in the free-text summary.
    expect(supportCopyFacts({
      kind: 'order',
      circleId: null,
      orderId: '2026100213812345678001',
      circleName: null,
      issueSummary: '',
    })).toEqual([{ kind: 'order', value: '2026100213812345678001' }])
  })

  it('falls back to MANUAL copy with an honest failure hint when the clipboard is unavailable', async () => {
    installClipboard('missing')
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'upstream_pending', contractGap: 'G4' } },
      target: orderTargetFixture(),
    })
    fireEvent.click(screen.getByTestId('circle-support-copy'))
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-copy-status').textContent)
        .toBe('Copy failed. Select the text above and copy it manually.')
    })
    // The readonly textarea stays as the manual copy source.
    expect((screen.getByTestId('circle-support-info-text') as HTMLTextAreaElement).value.length).toBeGreaterThan(0)
  })

  it('reports copy failure when the clipboard write rejects', async () => {
    installClipboard('reject')
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'upstream_pending', contractGap: 'G4' } },
      target: orderTargetFixture(),
    })
    fireEvent.click(screen.getByTestId('circle-support-copy'))
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-copy-status').textContent)
        .toBe('Copy failed. Select the text above and copy it manually.')
    })
    expect(clipboardWrites.length).toBe(0)
  })
})

// -------------------------------------------------------------------------
// P70-SUPPORT-03 — back to the original object, manual-only recheck
// -------------------------------------------------------------------------

describe('CircleSupportPanel return to the original object (P70-SUPPORT-03)', () => {
  it('goes back through onBack exactly once, mutating nothing and issuing no request', () => {
    const target: CircleSupportTarget = Object.freeze({ ...orderTargetFixture() })
    let backCalls = 0
    const onBack = () => { backCalls += 1 }
    installClipboard('missing')
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'available', configured: true, guidance: 'g' } },
      target,
      onBack,
    })
    fireEvent.click(screen.getByTestId('circle-support-back'))
    expect(backCalls).toBe(1)
    // No bridge call, no fetch, no clipboard write: closing the help entry
    // cannot change the original order/circle facts.
    expect(calledMethods.length).toBe(0)
    expect(fetchCalls.length).toBe(0)
    expect(clipboardWrites.length).toBe(0)
  })

  it('labels the back button by the original object kind (order vs circle)', () => {
    const view = renderInjected({
      supportState: { phase: 'ready', state: { availability: 'upstream_pending', contractGap: 'G4' } },
      target: orderTargetFixture(),
      onBack: () => {},
    })
    expect(screen.getByTestId('circle-support-back').textContent).toBe('Back to the order')
    view.unmount()

    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'upstream_pending', contractGap: 'G4' } },
      target: { kind: 'circle', circleId: 'circle-design', orderId: null, circleName: 'Morning Star Design Circle', issueSummary: 'x' },
      onBack: () => {},
    })
    expect(screen.getByTestId('circle-support-back').textContent).toBe('Back to the circle')
  })

  it('re-verifies the original object ONLY on an explicit click — never automatically', () => {
    let recheckCalls = 0
    const onRecheck = () => { recheckCalls += 1 }
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'upstream_pending', contractGap: 'G4' } },
      target: orderTargetFixture(),
      onBack: () => {},
      onRecheck,
    })
    // Mount + state settle + copy interactions must not trigger a recheck.
    fireEvent.click(screen.getByTestId('circle-support-copy'))
    expect(recheckCalls).toBe(0)
    fireEvent.click(screen.getByTestId('circle-support-recheck'))
    expect(recheckCalls).toBe(1)
  })

  it('renders no recheck button when C9 provides no onRecheck', () => {
    renderInjected({
      supportState: { phase: 'ready', state: { availability: 'upstream_pending', contractGap: 'G4' } },
      target: orderTargetFixture(),
      onBack: () => {},
    })
    expect(screen.queryByTestId('circle-support-recheck')).toBeNull()
  })

  it('issues READ-ONLY bridge traffic on the full-provider path — no fake support request', async () => {
    installClipboard('ok')
    supportResultByAccount['account-a-fixture'] = { success: true, support: CONFIGURED_SUPPORT }
    let backCalls = 0
    const onBack = () => { backCalls += 1 }
    render(providerTree({ accountId: 'account-a-fixture', target: orderTargetFixture(), onBack }))
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-configured')).toBeTruthy()
    })
    fireEvent.click(screen.getByTestId('circle-support-copy'))
    await waitFor(() => {
      expect(screen.getByTestId('circle-support-copy-status').textContent).toContain('Copied')
    })
    fireEvent.click(screen.getByTestId('circle-support-back'))
    expect(backCalls).toBe(1)

    // Every bridge touch is one of the read methods; nothing resembling a
    // ticket/message/POST surface was ever called, and no fetch happened.
    const allowed = new Set(['list', 'listMemberships', 'getSupport'])
    expect(calledMethods.length).toBeGreaterThan(0)
    expect(calledMethods.every(name => allowed.has(name))).toBe(true)
    expect(fetchCalls.length).toBe(0)
  })
})
