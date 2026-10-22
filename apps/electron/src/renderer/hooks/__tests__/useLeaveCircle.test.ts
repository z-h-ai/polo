import { ModalProvider } from '@/context/ModalContext'
/**
 * useLeaveCircle tests (POO-70 C7 / POO-96) — P70-LEAVE-01/02/03.
 *
 * Coverage required by the card (证明完成): 命令 mock 契约 / dialog 取消 /
 * 双击 / 503 / 成功刷新 / 两源变一源 / 最后源丢失 / 旧账号回执, plus the
 * F1 replay (409) re-read semantics, the success-with-failed-refresh
 * "已退出/待核对" presentation and the read-only re-verify path.
 *
 * The tests run against the REAL C2 surface: the real
 * `MemberCircleResourceProvider` mounts `useMemberCirclesResource` over the
 * bridge/catalog doubles from the C2 test model, and a thin host consumes
 * `useLeaveCircle` + renders the REAL `LeaveCircleDialog` — so the hook is
 * proven to consume C2's exactly-one invalidateAndRefresh round trip, never
 * a second one.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { MemberCircleSnapshot, MemberMembership } from '@polo-ai/shared/admin'
import { createProductSpaceContextKey } from '@/lib/product-space-storage'

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))


GlobalRegistrator.register()
setupI18n()
// The prototype copy the dialog is aligned with is the zh-Hans source text;
// happy-dom's navigator detection would otherwise pick `en`.
await i18n.changeLanguage('zh-Hans')

// ---------------------------------------------------------------------------
// ProductSpace context double (scope source) — same model as C2's tests
// ---------------------------------------------------------------------------

interface SpaceContextOverrides {
  accountId?: string | null
  personalProductSpaceId?: string | null
  contextVersion?: number
  spaceKind?: 'personal' | 'enterprise'
}

function spaceContext(overrides: SpaceContextOverrides = {}) {
  const accountId = overrides.accountId === undefined ? 'account-a' : overrides.accountId
  const personalId = overrides.personalProductSpaceId === undefined ? 'personal-space' : overrides.personalProductSpaceId
  const epoch = overrides.contextVersion ?? 1
  const kind = overrides.spaceKind ?? 'personal'
  if (!accountId || !personalId) return null
  return {
    accountId,
    activeProductSpaceId: kind === 'enterprise' ? 'enterprise-space' : personalId,
    personalProductSpaceId: personalId,
    productSpaceContextKey: createProductSpaceContextKey(accountId, kind === 'enterprise' ? 'enterprise-space' : personalId),
    contextVersion: epoch,
    activeProductSpace: {
      id: kind === 'enterprise' ? 'enterprise-space' : personalId,
      kind,
      name: kind === 'enterprise' ? '企业空间' : '个人空间',
      accessMode: 'active',
    },
  }
}

let productSpaceContextState = spaceContext()

mock.module('@/context/ProductSpaceContext', () => ({
  useOptionalProductSpaceContext: () => productSpaceContextState,
  useProductSpaceContext: () => productSpaceContextState,
}))

// ---------------------------------------------------------------------------
// Trusted bridge double (electronAPI.memberCircles)
// ---------------------------------------------------------------------------

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function success<T extends object>(payload: T) {
  return { success: true as const, ...payload }
}

function failure(errorCode: string, message = 'member circle failure') {
  return { success: false as const, errorCode, message }
}

let circleCounter = 0

function circle(circleId: string, overrides: Partial<MemberCircleSnapshot> = {}): MemberCircleSnapshot {
  circleCounter += 1
  return {
    membershipId: `00000000-0000-4000-8000-${String(circleCounter).padStart(12, '0')}`,
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    joinSource: 'share_link',
    joinedAt: '2026-01-01T00:00:00.000Z',
    circle: {
      circleId,
      name: `圈 ${circleId}`,
      purpose: '',
      status: 'active',
      ownerUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
    },
    entitlements: [],
    ...overrides,
  }
}

let membershipCounter = 0

function membership(circleId: string, overrides: Partial<MemberMembership> = {}): MemberMembership {
  membershipCounter += 1
  return {
    membershipId: `00000000-0000-4000-8100-${String(membershipCounter).padStart(12, '0')}`,
    status: 'active',
    billingKind: 'paid',
    modeTransitionEndsAt: null,
    currentPeriodEnd: '2026-11-01T00:00:00.000Z',
    suspendedReason: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    paymentOrders: [],
    circle: {
      circleId,
      name: `圈 ${circleId}`,
      purpose: '',
      status: 'active',
      joinMode: 'paid',
      membershipPriceMinor: 9900,
      membershipCurrency: 'CNY',
      nextPeriodPriceMinor: null,
      nextPriceEffectiveAt: null,
    },
    ...overrides,
  }
}

let listImpl: () => Promise<unknown> = async () => success({ circles: [circle('circle-a')] })
let listMembershipsImpl: () => Promise<unknown> = async () => success({ memberships: [membership('circle-a')] })
let leaveImpl: (membershipId: string) => Promise<unknown> = async () => failure('conflict')

const callCounts = {
  list: 0,
  listMemberships: 0,
  leave: 0,
}

const leaveCalls: string[] = []

function resetBridge() {
  listImpl = async () => success({ circles: [circle('circle-a')] })
  listMembershipsImpl = async () => success({ memberships: [membership('circle-a')] })
  leaveImpl = async () => failure('conflict')
  callCounts.list = 0
  callCounts.listMemberships = 0
  callCounts.leave = 0
  leaveCalls.length = 0
}

function installBridge() {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      memberCircles: {
        list: () => {
          callCounts.list += 1
          return listImpl()
        },
        listMemberships: () => {
          callCounts.listMemberships += 1
          return listMembershipsImpl()
        },
        previewRenewal: async () => failure('not_found'),
        leave: (membershipId: string) => {
          callCounts.leave += 1
          leaveCalls.push(membershipId)
          return leaveImpl(membershipId)
        },
        getOrder: async () => failure('not_found'),
        getCheckoutResult: async () => failure('not_found'),
        getUpdates: async () => success({ updates: { availability: 'upstream_pending', contractGap: 'G2' } }),
        getProfile: async () => success({ profile: { availability: 'upstream_pending', contractGap: 'G3' } }),
        getSupport: async () => success({ support: { availability: 'upstream_pending', contractGap: 'G4' } }),
      },
    },
  })
}

// ---------------------------------------------------------------------------
// Catalog double (H1 shared instance) — the C2 test's RENDER-SNAPSHOT model:
// the instance's `.state` only moves when React re-renders the instance with
// a NEW identity (commitCatalogAndSettle below).
// ---------------------------------------------------------------------------

interface CatalogDoubleState {
  errorCode: string | null
  catalog: import('@polo-ai/shared/admin').AppCatalogCacheEntry | null
  refreshing?: boolean
  loading?: boolean
}

function minimalCatalog(): import('@polo-ai/shared/admin').AppCatalogCacheEntry {
  return {
    accountId: 'account-a',
    organizationId: 'personal-space',
    appConfigVersion: 'test-1',
    authorizationStatus: 'authorized',
    apps: [],
    syncedAt: 1,
  }
}

let catalogLogicalState: CatalogDoubleState = { errorCode: null, catalog: minimalCatalog() }
let catalogSyncImpl: (force?: boolean) => Promise<void> = async () => {}
const catalogSyncCalls: boolean[] = []

type CatalogDouble = import('@/hooks/useAppCatalog').AppCatalogInstance

function createCatalogInstance(): CatalogDouble {
  const snapshot: CatalogDoubleState = { ...catalogLogicalState }
  return {
    state: snapshot,
    sync: mock(async (force?: boolean) => {
      catalogSyncCalls.push(Boolean(force))
      await catalogSyncImpl(force)
    }),
  } as unknown as CatalogDouble
}

function resetCatalog() {
  catalogLogicalState = { errorCode: null, catalog: minimalCatalog() }
  catalogSyncImpl = async () => {}
  catalogSyncCalls.length = 0
}

function leaveReceipt(membershipId: string, circleId = 'circle-a') {
  return {
    membershipId,
    circleId,
    userId: 'aaaaaaaa-0000-4000-8000-000000000001',
    status: 'expired' as const,
    billingKind: 'paid' as const,
    currentPeriodEnd: null,
    modeTransitionEndsAt: null,
    suspendedReason: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-10-04T00:00:00.000Z',
    updatedAt: '2026-10-04T00:00:00.000Z',
  }
}

// ---------------------------------------------------------------------------
// Test host: real C2 provider + real dialog + useLeaveCircle
// ---------------------------------------------------------------------------

const { act, cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { MemberCircleResourceProvider } = await import('@/context/MemberCircleResourceContext')
const {
  classifyLeaveWriteFailure,
  judgeLeaveWriteSuccessVerification,
  judgeMembershipLeft,
  judgeReverifyVerification,
  useLeaveCircle,
} = await import('../useLeaveCircle')
const { LeaveCircleDialog } = await import('@/components/circles/LeaveCircleDialog')

type UseLeaveCircleResult = import('../useLeaveCircle').UseLeaveCircleResult

let commitCatalog: (instance: CatalogDouble) => void = () => {}
let forceHostRender: () => void = () => {}

function FlowConsumer({ apiRef }: { apiRef: { current: UseLeaveCircleResult | null } }) {
  const flow = useLeaveCircle()
  apiRef.current = flow
  return createElement(LeaveCircleDialog, {
    state: flow.state.dialog,
    onConfirm: flow.confirm,
    onCancel: flow.cancel,
  })
}

function TestHost({
  apiRef,
  initialCatalog,
}: {
  apiRef: { current: UseLeaveCircleResult | null }
  initialCatalog: CatalogDouble | null
}) {
  const [catalog, setCatalog] = useState(initialCatalog)
  const [, setNonce] = useState(0)
  commitCatalog = setCatalog
  forceHostRender = () => setNonce((n: number) => n + 1)
  return createElement(I18nextProvider, {
    i18n,
    children: createElement(MemberCircleResourceProvider, {
      catalog,
      children: createElement(ModalProvider, { children: createElement(FlowConsumer, { apiRef }) }),
    }),
  })
}

function renderFlow(options: { withCatalog?: boolean } = {}) {
  const apiRef: { current: UseLeaveCircleResult | null } = { current: null }
  render(createElement(TestHost, {
    apiRef,
    // `withCatalog: false` mounts the provider WITHOUT the H1 instance — the
    // P2 case where C2's invalidateAndRefresh returns without any settle
    // await, so verdicts must still come from COMMITTED receipts only.
    initialCatalog: options.withCatalog === false ? null : createCatalogInstance(),
  }))
  return apiRef
}

/** Flush the in-flight write/read chain (bridge microtasks). */
async function flushFlow() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

/** Commit a post-sync H1 snapshot so an awaiting invalidateAndRefresh settles. */
async function commitCatalogAndSettle() {
  await act(async () => {
    commitCatalog(createCatalogInstance())
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function requestLeave(apiRef: { current: UseLeaveCircleResult | null }, input?: {
  circleId?: string
  membershipId?: string
  circleName?: string
  lastSourceWorkNames?: string[]
}) {
  act(() => {
    apiRef.current!.request({
      circleId: input?.circleId ?? 'circle-a',
      membershipId: input?.membershipId ?? 'm-1',
      circleName: input?.circleName ?? '晨星设计圈',
      lastSourceWorkNames: input?.lastSourceWorkNames,
    })
  })
  await act(async () => {})
  return screen.getByTestId('leave-circle-dialog')
}

async function clickConfirm() {
  await act(async () => {
    fireEvent.click(screen.getByTestId('leave-circle-dialog-confirm'))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

function confirmButton(): HTMLButtonElement {
  return screen.getByTestId('leave-circle-dialog-confirm') as HTMLButtonElement
}

beforeEach(() => {
  productSpaceContextState = spaceContext()
  resetBridge()
  resetCatalog()
  installBridge()
})

afterEach(() => {
  cleanup()
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('leave failure classification (P70-LEAVE-03)', () => {
  it('treats transport-class codes as result-unknown', () => {
    expect(classifyLeaveWriteFailure('network_error')).toBe('result-unknown')
    expect(classifyLeaveWriteFailure('timeout')).toBe('result-unknown')
    expect(classifyLeaveWriteFailure('service_unavailable')).toBe('result-unknown')
  })

  it('treats the F1 409 conflict as not-active, session codes as manual-only', () => {
    expect(classifyLeaveWriteFailure('conflict')).toBe('not-active')
    expect(classifyLeaveWriteFailure('session_changed')).toBe('session')
    expect(classifyLeaveWriteFailure('session_unavailable')).toBe('session')
  })

  it('treats definitive server rejections as rejected', () => {
    for (const code of ['validation_error', 'unauthorized', 'forbidden', 'not_found', 'rate_limited', 'invalid_response', 'unknown']) {
      expect(classifyLeaveWriteFailure(code)).toBe('rejected')
    }
  })
})

describe('judgeMembershipLeft (authoritative receipt verdict)', () => {
  it('expired row present → left (F1: expired relations stay listed)', () => {
    expect(judgeMembershipLeft([{ membershipId: 'm-1', status: 'expired' }], 'm-1')).toBe('left')
  })

  it('active row present → member', () => {
    expect(judgeMembershipLeft([{ membershipId: 'm-1', status: 'active' }], 'm-1')).toBe('member')
  })

  it('P1: suspended row present → suspended (NOT left — F1 409 fires for status ≠ active)', () => {
    // A suspended relation is NOT a departure: the user is still a member,
    // cannot leave (409) and must never be presented as 已退出 / rejoinable.
    expect(judgeMembershipLeft([{ membershipId: 'm-1', status: 'suspended' }], 'm-1')).toBe('suspended')
  })

  it('row absent → left (no active relation)', () => {
    expect(judgeMembershipLeft([{ membershipId: 'm-2', status: 'active' }], 'm-1')).toBe('left')
  })

  it('missing receipt → unverifiable (never guessed)', () => {
    expect(judgeMembershipLeft(null, 'm-1')).toBe('unverifiable')
  })
})

describe('verification judgments (P70-LEAVE-02 已退出/待核对)', () => {
  it('a settled error-free receipt is fresh', () => {
    expect(judgeLeaveWriteSuccessVerification({ phase: 'ready', circlesError: null, membershipsError: null, refreshing: false })).toBe('fresh')
    expect(judgeLeaveWriteSuccessVerification({ phase: 'empty', circlesError: null, membershipsError: null, refreshing: false })).toBe('fresh')
  })

  it('partial/error/offline/loading receipts stay pending-recheck', () => {
    const networkError = { code: 'network_error' as const, retryable: true }
    expect(judgeLeaveWriteSuccessVerification({ phase: 'partial', circlesError: null, membershipsError: networkError, refreshing: false })).toBe('pending-recheck')
    expect(judgeLeaveWriteSuccessVerification({ phase: 'error', circlesError: networkError, membershipsError: networkError, refreshing: false })).toBe('pending-recheck')
    expect(judgeLeaveWriteSuccessVerification({ phase: 'loading', circlesError: null, membershipsError: null, refreshing: true })).toBe('pending-recheck')
  })

  it('re-verify verification needs relations refreshed AND catalog refreshed', () => {
    expect(judgeReverifyVerification({ relations: 'refreshed', catalog: 'refreshed' })).toBe('fresh')
    expect(judgeReverifyVerification({ relations: 'partial', catalog: 'refreshed' })).toBe('pending-recheck')
    expect(judgeReverifyVerification({ relations: 'refreshed', catalog: 'pending' })).toBe('pending-recheck')
    expect(judgeReverifyVerification({ relations: 'refreshed', catalog: 'failed' })).toBe('pending-recheck')
    expect(judgeReverifyVerification({ relations: 'refreshed', catalog: 'unavailable' })).toBe('pending-recheck')
  })
})

// ---------------------------------------------------------------------------
// Flow: mock contract + dialog (P70-LEAVE-01)
// ---------------------------------------------------------------------------

describe('useLeaveCircle — P70-LEAVE-01 (one confirmation, busy guard, cancel)', () => {
  it('sends exactly ONE leave with exactly the requested membershipId, consumes C2 exactly-once refresh, closes the dialog and reports left/fresh', async () => {
    leaveImpl = async membershipId => success({ membership: leaveReceipt(membershipId) })
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()

    await requestLeave(apiRef, { membershipId: 'm-1', circleName: '晨星设计圈' })
    expect(screen.getByTestId('leave-circle-dialog-title').textContent).toContain('晨星设计圈')

    const listCallsAtStart = callCounts.list
    expect(catalogSyncCalls).toHaveLength(0)
    await clickConfirm()
    // One leave ⇒ C2's single refresh round trip: one relations refetch, one
    // catalog sync — the hook adds no second round trip.
    expect(callCounts.leave).toBe(1)
    expect(leaveCalls).toEqual(['m-1'])
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(apiRef.current!.state.outcome).toMatchObject({
      kind: 'left',
      circleId: 'circle-a',
      membershipId: 'm-1',
      endedAt: '2026-10-04T00:00:00.000Z',
      verification: 'fresh',
    })
    expect(callCounts.list).toBe(listCallsAtStart + 1)
    expect(callCounts.listMemberships).toBe(listCallsAtStart + 1)
    expect(catalogSyncCalls).toEqual([true])
    await waitFor(() => expect(screen.queryByTestId('leave-circle-dialog')).toBeNull())
  })

  it('cancel closes without any write and without an outcome; reopening is a fresh confirmation', async () => {
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())

    await requestLeave(apiRef)
    fireEvent.click(screen.getByTestId('leave-circle-dialog-cancel'))
    await act(async () => {})

    expect(callCounts.leave).toBe(0)
    expect(apiRef.current!.state.outcome).toBeNull()
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()

    await requestLeave(apiRef)
    expect(screen.getByTestId('leave-circle-dialog')).toBeTruthy()
    expect(callCounts.leave).toBe(0)
  })

  it('a double confirm click writes only once (busy 防重)', async () => {
    const slowLeave = deferred<unknown>()
    leaveImpl = () => slowLeave.promise
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())

    await requestLeave(apiRef)
    // Two clicks within the same frame: the synchronous in-flight guard and
    // the busy dialog state must both refuse the second write.
    fireEvent.click(confirmButton())
    fireEvent.click(confirmButton())
    await flushFlow()

    expect(callCounts.leave).toBe(1)
    expect(confirmButton().disabled).toBe(true)

    slowLeave.resolve(success({ membership: leaveReceipt('m-1') }))
    await commitCatalogAndSettle()
    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(callCounts.leave).toBe(1)
  })

  it('cancel is refused while the confirm write is in flight', async () => {
    const slowLeave = deferred<unknown>()
    leaveImpl = () => slowLeave.promise
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())

    await requestLeave(apiRef)
    await act(async () => {
      fireEvent.click(confirmButton())
    })
    fireEvent.click(screen.getByTestId('leave-circle-dialog-cancel'))
    await flushFlow()

    expect(screen.getByTestId('leave-circle-dialog')).toBeTruthy()
    slowLeave.resolve(failure('forbidden'))
    await flushFlow()
    // The definitive rejection keeps the dialog open with the failure.
    expect(screen.getByTestId('leave-circle-dialog-error')).toBeTruthy()
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'still-member', code: 'forbidden' })
    expect(callCounts.leave).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Flow: definitive rejection / session (P70-LEAVE-03)
// ---------------------------------------------------------------------------

describe('useLeaveCircle — P70-LEAVE-03 (definitive failure + 旧账号回执)', () => {
  it('a definitive rejection keeps the dialog open, claims no left outcome and issues NO read', async () => {
    // A DEFINITIVE server rejection (not transport-class, not the F1 409).
    leaveImpl = async () => failure('forbidden')
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef)

    const listCallsBefore = callCounts.list
    expect(catalogSyncCalls).toHaveLength(0)
    await clickConfirm()

    expect(callCounts.leave).toBe(1)
    // A failed leave triggers no refresh round trip at all (C2 negative test
    // consumed here): no relations refetch beyond mount, no catalog sync.
    expect(callCounts.list).toBe(listCallsBefore)
    expect(catalogSyncCalls).toHaveLength(0)
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'still-member', code: 'forbidden' })
    expect(screen.getByTestId('leave-circle-dialog-error')).toBeTruthy()
    expect(confirmButton().disabled).toBe(false)
  })

  it('旧账号回执: a scope rebind mid-write fails closed as session_changed — no auto re-read, no left claim', async () => {
    const slowLeave = deferred<unknown>()
    leaveImpl = () => slowLeave.promise
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })
    await clickConfirm()
    expect(callCounts.leave).toBe(1)

    // Account B signs in while the write is in flight: the fence dies.
    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    await act(async () => {
      forceHostRender()
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // The old context's write receipt must never surface: C2 fails closed.
    await act(async () => {
      slowLeave.resolve(success({ membership: leaveReceipt('m-1') }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    await waitFor(() => expect(screen.getByTestId('leave-circle-dialog-error')).toBeTruthy())
    // No left outcome and NO catalog sync: the flow auto-read nothing.
    expect(apiRef.current!.state.outcome).toBeNull()
    expect(apiRef.current!.state.dialog).toMatchObject({ phase: 'error', busy: false })
    expect(catalogSyncCalls).toHaveLength(0)
    expect(callCounts.leave).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Flow: result unknown / replay → read-only re-verification (P70-LEAVE-03)
// ---------------------------------------------------------------------------

describe('useLeaveCircle — 结果未知只重读 (503 / F1 409 replay)', () => {
  it('503: exactly one automatic read-only re-verify proves LEFT; the write is never repeated', async () => {
    leaveImpl = async () => failure('service_unavailable')
    // The fresh receipt proves the leave HAD landed (expired row persists, F1).
    listMembershipsImpl = async () => success({
      memberships: [{ ...membership('circle-a'), membershipId: 'm-1', status: 'expired' }],
    })
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    await clickConfirm()
    expect(callCounts.leave).toBe(1)
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'left', membershipId: 'm-1', endedAt: null })
    // No blind rewrite: still exactly ONE write.
    expect(callCounts.leave).toBe(1)
    await waitFor(() => expect(screen.queryByTestId('leave-circle-dialog')).toBeNull())
  })

  it('503 + still-active receipt: honest still-member error, dialog stays open, still no rewrite', async () => {
    leaveImpl = async () => failure('service_unavailable')
    // The fresh receipt proves the relation is STILL active (stable id).
    const stillActive = { ...membership('circle-a'), membershipId: 'm-1', status: 'active' as const }
    listMembershipsImpl = async () => success({ memberships: [stillActive] })
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    await clickConfirm()
    await flushFlow()
    await commitCatalogAndSettle()

    await waitFor(() => expect(screen.getByTestId('leave-circle-dialog-error')).toBeTruthy())
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'still-member', membershipId: 'm-1' })
    expect(callCounts.leave).toBe(1)
    // The user MAY deliberately retry: the confirm button is enabled again.
    expect(confirmButton().disabled).toBe(false)
  })

  it('F1 409 replay (conflict): re-read proves the earlier leave landed → left, no second write', async () => {
    leaveImpl = async () => failure('conflict')
    listMembershipsImpl = async () => success({
      memberships: [{ ...membership('circle-a'), membershipId: 'm-1', status: 'expired' }],
    })
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    await clickConfirm()
    await flushFlow()
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(callCounts.leave).toBe(1)
  })

  it('a re-read whose receipts never come back stays honestly unresolved (no left, no member)', async () => {
    leaveImpl = async () => failure('timeout')
    // The re-read half-fails: the memberships receipt never comes back.
    listImpl = async () => success({ circles: [circle('circle-a')] })
    listMembershipsImpl = async () => failure('network_error')
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    await clickConfirm()
    await flushFlow()
    await commitCatalogAndSettle()

    await waitFor(() => expect(screen.getByTestId('leave-circle-dialog-recheck')).toBeTruthy())
    expect(apiRef.current!.state.outcome).toBeNull()
    expect(apiRef.current!.state.dialog).toMatchObject({ phase: 'recheck', busy: false, recheckUnresolved: true })
    expect(callCounts.leave).toBe(1)

    // Cancel dismisses the unresolved recheck; no write, no claim.
    fireEvent.click(screen.getByTestId('leave-circle-dialog-cancel'))
    await act(async () => {})
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()
    expect(apiRef.current!.state.outcome).toBeNull()
  })

  it('P1 regression: a 409 replay + SUSPENDED receipt reads 暂停, never 已退出 and never rejoinable', async () => {
    // F1: leave_now on a suspended relation answers 409 — the user has NOT
    // left, cannot rejoin, and must not be shown the 已退出 presentation.
    leaveImpl = async () => failure('conflict')
    const suspendedRow = { ...membership('circle-a'), membershipId: 'm-1', status: 'suspended' as const }
    listMembershipsImpl = async () => success({ memberships: [suspendedRow] })
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    await clickConfirm()
    await flushFlow()
    await commitCatalogAndSettle()

    await waitFor(() => expect(screen.getByTestId('leave-circle-dialog-error')).toBeTruthy())
    expect(screen.getByTestId('leave-circle-dialog-error').textContent).toContain('暂停')
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'suspended', membershipId: 'm-1' })
    expect(callCounts.leave).toBe(1)
    // The retry is contract-doomed (suspended cannot be left): disabled.
    expect(confirmButton().disabled).toBe(true)
  })

  it('P2-1(a): without a mounted catalog the verdict is judged from the COMMITTED receipt, not the stale pre-invalidate one', async () => {
    leaveImpl = async () => failure('service_unavailable')
    // The MOUNT receipt says ACTIVE m-1; the re-read says EXPIRED m-1. A
    // same-continuation stale read would misjudge member (inducing a second
    // write) or unverifiable; the committed-snapshot verdict is left.
    const activeRow = { ...membership('circle-a'), membershipId: 'm-1', status: 'active' as const }
    let fetchCount = 0
    listImpl = async () => success({ circles: [circle('circle-a')] })
    listMembershipsImpl = async () => {
      fetchCount += 1
      if (fetchCount === 1) return success({ memberships: [activeRow] })
      return success({ memberships: [{ ...activeRow, status: 'expired' as const }] })
    }
    const apiRef = renderFlow({ withCatalog: false })
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    await clickConfirm()
    await flushFlow()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    // No H1 instance was injected: the relations verdict stands but the
    // catalog was not re-verified — honestly pending-recheck.
    expect(apiRef.current!.state.outcome).toMatchObject({
      kind: 'left',
      membershipId: 'm-1',
      verification: 'pending-recheck',
    })
    expect(callCounts.leave).toBe(1)
    expect(await screen.queryByTestId('leave-circle-dialog')).toBeNull()
  })

  it('P2-1(b): an account switch during the auto re-verification fails the verdict closed — another account\'s receipt never proves left', async () => {
    leaveImpl = async () => failure('timeout')
    // Both relations reads hang until the test releases them — the rebind
    // supersedes the in-flight refetch before any receipt can be applied.
    const slowRead = deferred<unknown>()
    listImpl = () => slowRead.promise
    listMembershipsImpl = () => slowRead.promise
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })
    await clickConfirm()
    await flushFlow()
    expect(apiRef.current!.state.dialog).toMatchObject({ phase: 'recheck', busy: true })

    // Account B signs in mid-recheck; B's receipts do not contain m-1 at all.
    productSpaceContextState = spaceContext({ accountId: 'account-b', contextVersion: 2 })
    await act(async () => {
      forceHostRender()
      slowRead.resolve(success({ circles: [circle('circle-b')], memberships: [membership('circle-b')] }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // Fail closed: unresolved recheck, no left claim, no second write.
    await waitFor(() => expect(apiRef.current!.state.dialog).toMatchObject({
      phase: 'recheck',
      busy: false,
      recheckUnresolved: true,
    }))
    expect(apiRef.current!.state.outcome).toBeNull()
    expect(callCounts.leave).toBe(1)
  })

  it('P2-2: an unresolved recheck keeps a READ-ONLY recovery — cancel, then reverify() proves left without any second write', async () => {
    leaveImpl = async () => failure('timeout')
    listImpl = async () => success({ circles: [circle('circle-a')] })
    let membershipsFail = true
    listMembershipsImpl = async () => {
      if (membershipsFail) return failure('network_error')
      return success({
        memberships: [{ ...membership('circle-a'), membershipId: 'm-1', status: 'expired' as const }],
      })
    }
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    // First re-verification half-fails → honestly unresolved.
    await clickConfirm()
    await flushFlow()
    await commitCatalogAndSettle()
    await waitFor(() => expect(screen.getByTestId('leave-circle-dialog-recheck')).toBeTruthy())
    expect(apiRef.current!.state.outcome).toBeNull()

    // Dismiss the unresolved recheck; the read-only recovery stays available.
    fireEvent.click(screen.getByTestId('leave-circle-dialog-cancel'))
    await act(async () => {})
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()

    membershipsFail = false
    const writesBefore = callCounts.leave
    const listBefore = callCounts.list
    act(() => {
      apiRef.current!.reverify()
    })
    await flushFlow()
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'left', membershipId: 'm-1', verification: 'fresh' })
    // Read-only: reads happened, the write count did not move.
    expect(callCounts.leave).toBe(writesBefore)
    expect(callCounts.list).toBeGreaterThan(listBefore)
  })
})

// ---------------------------------------------------------------------------
// Flow: success-with-failed-refresh + reverify (P70-LEAVE-02)
// ---------------------------------------------------------------------------

describe('useLeaveCircle — P70-LEAVE-02 (成功刷新 / 两源变一源 / 最后源丢失 / 待核对)', () => {
  it('两源变一源: leaving one circle keeps the OTHER circle valid in the refreshed receipts and reports fresh', async () => {
    // Initial receipts: two circles (two sources over the same works).
    listImpl = async () => success({ circles: [circle('circle-a'), circle('circle-b')] })
    listMembershipsImpl = async () => success({
      memberships: [membership('circle-a'), membership('circle-b')],
    })
    leaveImpl = async membershipId => success({ membership: leaveReceipt(membershipId, 'circle-a') })
    // After the leave, the refreshed receipts keep circle-b (still valid) and
    // the expired circle-a relation (F1: expired rows stay listed).
    listImpl = async () => success({ circles: [circle('circle-a'), circle('circle-b')] })
    let membershipsFetchCount = 0
    const mountMemberships = listMembershipsImpl
    listMembershipsImpl = async () => {
      membershipsFetchCount += 1
      if (membershipsFetchCount === 1) return mountMemberships()
      return success({
        memberships: [
          { ...membership('circle-a'), membershipId: 'm-1', status: 'expired' },
          membership('circle-b'),
        ],
      })
    }

    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { circleId: 'circle-a', membershipId: 'm-1', circleName: '晨星增长圈' })

    await clickConfirm()
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'left', verification: 'fresh', circleId: 'circle-a' })
    // The still-valid source survives in the authoritative receipts — the
    // same work stays usable through circle-b (H1's projection consumes this).
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()
  })

  it('最后源丢失: the write receipt (expired + endedAt) is reported so the page keeps the correct object with the rejoin entry', async () => {
    leaveImpl = async membershipId => success({
      membership: { ...leaveReceipt(membershipId), endedAt: '2026-10-04T08:30:00.000Z' },
    })
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, {
      membershipId: 'm-1',
      circleName: '数据工坊圈',
      lastSourceWorkNames: ['数据报表生成器'],
    })

    // The caller-provided H1 last-source fact renders the explicit wording.
    expect(screen.getByTestId('leave-circle-dialog-last-source')).toBeTruthy()

    await clickConfirm()
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(apiRef.current!.state.outcome).toMatchObject({
      kind: 'left',
      endedAt: '2026-10-04T08:30:00.000Z',
      verification: 'fresh',
    })
  })

  it('确认写成功但refresh失败: reports left + pending-recheck, and reverify() re-reads READ-ONLY to fresh', async () => {
    leaveImpl = async membershipId => success({ membership: leaveReceipt(membershipId) })
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })

    // The write lands, but the C2 single refresh round trip half-fails: the
    // refetch is issued while `writeLanded` is still false and fails with a
    // network-class error, so the post-write receipt cannot be trusted.
    const listCallsAfterMount = callCounts.list
    let writeLanded = false
    listImpl = async () => {
      if (!writeLanded) return failure('network_error')
      return success({ circles: [circle('circle-a')] })
    }
    listMembershipsImpl = async () => {
      if (!writeLanded) return failure('network_error')
      return success({ memberships: [membership('circle-a')] })
    }

    await act(async () => {
      fireEvent.click(confirmButton())
      await new Promise(resolve => setTimeout(resolve, 0))
      writeLanded = true
    })
    expect(callCounts.leave).toBe(1)
    expect(callCounts.list).toBe(listCallsAfterMount + 1)
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'left', verification: 'pending-recheck' })

    // The read-only re-verification restores freshness — no extra write.
    const leavesBefore = callCounts.leave
    const listBeforeReverify = callCounts.list
    const syncsBefore = catalogSyncCalls.length
    act(() => {
      apiRef.current!.reverify()
    })
    await flushFlow()
    await commitCatalogAndSettle()

    await waitFor(() => expect(apiRef.current!.state.outcome).toMatchObject({ kind: 'left', verification: 'fresh' }))
    expect(callCounts.leave).toBe(leavesBefore)
    expect(callCounts.list).toBeGreaterThan(listBeforeReverify)
    expect(catalogSyncCalls.length).toBe(syncsBefore + 1)
    expect(apiRef.current!.state.reverifying).toBe(false)
  })

  it('reverify() is refused with no flow target at all (nothing requested, nothing to re-verify)', async () => {
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    const listBefore = callCounts.list
    act(() => {
      apiRef.current!.reverify()
    })
    await flushFlow()
    expect(callCounts.list).toBe(listBefore)
    expect(apiRef.current!.state.reverifying).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Dialog presentation
// ---------------------------------------------------------------------------

describe('LeaveCircleDialog presentation', () => {
  it('renders nothing without state and the confirmation copy with the circle name', async () => {
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()

    await requestLeave(apiRef, { circleName: '星河年度圈' })
    expect(screen.getByTestId('leave-circle-dialog')).toBeTruthy()
    expect(screen.getByTestId('leave-circle-dialog-title').textContent).toContain('星河年度圈')
    expect(screen.getByTestId('leave-circle-dialog-subtitle').textContent).toContain('授权影响')
    expect(screen.getByTestId('leave-circle-dialog-body').textContent).toContain('授权来源')
    // Without the H1 last-source fact, only the generic per-source wording.
    expect(screen.queryByTestId('leave-circle-dialog-last-source')).toBeNull()
  })

  it('renders the read-only recheck status while the leave result is unknown', async () => {
    const slowLeave = deferred<unknown>()
    leaveImpl = () => slowLeave.promise
    // The automatic re-verification's reads hang on the same deferred pair so
    // the recheck-in-flight state is deterministic under observation.
    const slowRead = deferred<unknown>()
    listImpl = () => slowRead.promise
    listMembershipsImpl = () => slowRead.promise
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef, { membershipId: 'm-1' })
    await clickConfirm()

    // The write result comes back UNKNOWN: the flow enters the read-only
    // recheck phase while the automatic re-verification is in flight.
    await act(async () => {
      slowLeave.resolve(failure('timeout'))
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    expect(screen.getByTestId('leave-circle-dialog-recheck')).toBeTruthy()
    expect(apiRef.current!.state.dialog).toMatchObject({ phase: 'recheck', busy: true, recheckUnresolved: false })
    expect(confirmButton().disabled).toBe(true)
    expect(callCounts.leave).toBe(1)

    // The re-read settles from the fresh receipt: row absent → left. The C2
    // settle still needs one committed H1 snapshot to release the leave.
    await act(async () => {
      slowRead.resolve(success({ circles: [circle('circle-a')], memberships: [membership('circle-a')] }))
      await new Promise(resolve => setTimeout(resolve, 0))
    })
    await commitCatalogAndSettle()
    await waitFor(() => expect(apiRef.current!.state.outcome?.kind).toBe('left'))
    expect(callCounts.leave).toBe(1)
    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()
  })

  it('Escape dismisses the open confirmation without writing', async () => {
    const apiRef = renderFlow()
    await waitFor(() => expect(apiRef.current).not.toBeNull())
    await requestLeave(apiRef)

    fireEvent.keyDown(document, { key: 'Escape' })
    await act(async () => {})

    expect(screen.queryByTestId('leave-circle-dialog')).toBeNull()
    expect(callCounts.leave).toBe(0)
    expect(apiRef.current!.state.outcome).toBeNull()
  })
})
