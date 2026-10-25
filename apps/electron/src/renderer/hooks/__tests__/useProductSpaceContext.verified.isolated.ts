import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { setupI18n } from '@polo-ai/shared/i18n'
import type {
  ProductSpaceContextStorage,
  ProductSpaceContextStoragePatch,
} from '@polo-ai/shared/config/product-space-context'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

/**
 * POO-142 review F1: the hook-level verified state machine behind the
 * membership-transition banner. `membershipListVerified` is the ONLY fact
 * that lets the banner speak about memberships, so its transitions are
 * asserted here ON the hook (not on the component):
 *
 * - 登录成功选择后置位 — and never before the selection is published;
 * - 在线恢复发布后置位 (both publish paths: verified refresh and the trusted
 *   Catalog403 recovery transaction);
 * - 离线 restore 不置位 — a cached snapshot is ready-but-unverified forever,
 *   and the derived banner state stays `unknown`, never `unaffiliated`;
 * - 账号/space 切换时状态重置 — account replacement (clearAccount + a new
 *   bootstrap) and the contract-blocked teardown drop the fact; a plain
 *   refresh failure of the SAME scope keeps the last verified fact.
 */

GlobalRegistrator.register()
setupI18n()

const accountId = 'account-a'
const accountIdB = 'account-b'
const personalId = 'space-personal'
const personalSpace = {
  id: personalId,
  kind: 'personal',
  name: '我的空间',
  accessMode: 'active',
  payer: { kind: 'account' },
} as unknown as ProductSpaceSummary
function enterpriseSpace(
  id: string,
  name: string,
): ProductSpaceSummary {
  return {
    id,
    kind: 'enterprise',
    enterpriseId: `enterprise-${id}`,
    name,
    role: 'member',
    accessMode: 'active',
    payer: { kind: 'enterprise', enterpriseId: `enterprise-${id}` },
  } as unknown as ProductSpaceSummary
}

type ListResult =
  | { success: true; productSpaces: ProductSpaceSummary[]; personalProductSpaceId: string }
  | { success: false; errorCode: string; message: string; contractUnsupported?: boolean }

const bothSpaces = (): ListResult => ({
  success: true,
  personalProductSpaceId: personalId,
  productSpaces: [personalSpace, enterpriseSpace('space-ent', '北辰智能科技')],
})

let listResult: ListResult
let listCalls = 0
let cleanupResult: { success: boolean; results: Record<string, boolean> }
let catalogResult: { success: boolean; errorCode?: string }
let declaredActiveSpace: string | null | undefined
let activeContextAckSuccess: boolean
let switchResult: {
  success: boolean
  errorCode?: string
  executions?: Array<{ executionId: string; status: 'stopped' | 'failed' }>
}
let commitResult: { success: boolean; errorCode?: string }
let restoreOfflineViewCalls = 0
let restoreViewResult: {
  success: boolean
  errorCode?: string
  snapshot?: {
    contractVersion: number
    personalProductSpaceId: string
    productSpaces: ProductSpaceSummary[]
    activeProductSpaceId: string
  }
}
let productSpaceContextStorage: ProductSpaceContextStorage | null = null
const mainRestrictedSpaces = new Set<string>()

function configureIpc(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      productSpaceList: async () => {
        listCalls += 1
        return listResult
      },
      productSpaceListActiveExecutions: async () => ({ success: true as const, executions: [] }),
      productSpaceGetCatalog: async () => catalogResult,
      productSpacePrepareSwitch: async (targetProductSpaceId: string) => {
        if (!activeContextAckSuccess) {
          return { success: false as const, errorCode: 'runtime_commit_failed' }
        }
        if (!switchResult.success) {
          return {
            success: false as const,
            errorCode: switchResult.errorCode ?? 'runtime_stop_failed',
            executions: switchResult.executions ?? [],
          }
        }
        return {
          success: true as const,
          token: `token-${targetProductSpaceId}`,
          executions: [],
        }
      },
      productSpaceStopSwitchExecutions: async (token: string) => {
        if (!token.startsWith('token-')) {
          return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID' }
        }
        if (!switchResult.success) {
          return {
            success: false as const,
            errorCode: switchResult.errorCode ?? 'runtime_stop_failed',
            executions: switchResult.executions ?? [],
          }
        }
        return { success: true as const, executions: [] }
      },
      productSpaceCommitSwitch: async (token: string, targetProductSpaceId: string) => {
        if (!token.startsWith('token-')) {
          return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID' }
        }
        if (!commitResult.success) {
          return { success: false as const, errorCode: commitResult.errorCode ?? 'runtime_commit_failed' }
        }
        declaredActiveSpace = targetProductSpaceId
        return { success: true as const }
      },
      productSpaceCancelSwitch: async () => ({ success: true as const, outcome: 'cancelled' as const }),
      productSpaceRestoreOfflineView: async () => {
        restoreOfflineViewCalls += 1
        if (restoreViewResult?.success && restoreViewResult.snapshot) {
          return { success: true as const, snapshot: restoreViewResult.snapshot }
        }
        return {
          success: false as const,
          errorCode: restoreViewResult?.errorCode ?? 'PRODUCT_SPACE_CONTEXT_REQUIRED',
        }
      },
      productSpaceRevokeActiveContext: async () => ({ success: true }),
      productSpaceRestrictActiveSpace: async (
        _restrictAccountId: string,
        restrictSpaceId: string,
        restricted: boolean,
      ) => {
        if (restricted) mainRestrictedSpaces.add(restrictSpaceId)
        else mainRestrictedSpaces.delete(restrictSpaceId)
        return { success: true as const, restricted }
      },
      productSpaceGetRestrictionState: async (_queryAccountId: string, querySpaceId: string) => ({
        success: true as const,
        restricted: mainRestrictedSpaces.has(querySpaceId),
      }),
      productSpaceCleanupLegacyState: async () => cleanupResult,
      getProductSpaceContextStorage: async () => productSpaceContextStorage,
      updateProductSpaceContextStorage: async (
        _accountId: string,
        patch: ProductSpaceContextStoragePatch,
      ) => {
        const next: ProductSpaceContextStorage = { ...(productSpaceContextStorage ?? {}) }
        if (patch.verifiedContext === null) delete next.verifiedContext
        else if (patch.verifiedContext) next.verifiedContext = patch.verifiedContext
        if (patch.legacyCleanup === null) delete next.legacyCleanup
        else if (patch.legacyCleanup) next.legacyCleanup = patch.legacyCleanup
        productSpaceContextStorage = next
        return next
      },
    },
  })
}

const { renderHook, act, waitFor } = await import('@testing-library/react')
const { useProductSpaceContextState } = await import('../useProductSpaceContext')
const { resetProductSpaceStorageMemoryForTests } = await import('@/lib/product-space-storage')
const { deriveMembershipTransition } = await import('@/lib/membership-transition')

function useHarness() {
  return useProductSpaceContextState()
}

beforeEach(() => {
  resetProductSpaceStorageMemoryForTests()
  productSpaceContextStorage = null
  listResult = bothSpaces()
  listCalls = 0
  cleanupResult = { success: true, results: {} }
  catalogResult = { success: true }
  declaredActiveSpace = undefined
  activeContextAckSuccess = true
  switchResult = { success: true, executions: [] }
  commitResult = { success: true }
  restoreViewResult = { success: false, errorCode: 'PRODUCT_SPACE_CONTEXT_REQUIRED' }
  restoreOfflineViewCalls = 0
  mainRestrictedSpaces.clear()
  configureIpc()
})

afterEach(() => {
  resetProductSpaceStorageMemoryForTests()
})

async function boot(hook: { current: ReturnType<typeof useHarness> }, id = accountId) {
  let outcome: string | null = null as string | null
  await act(async () => {
    outcome = await hook.current.bootstrap(id)
  })
  return outcome
}

/** Offline-restore fixture: a stale verified snapshot + a completed ledger. */
function seedStaleVerifiedSnapshot(activeId = personalId) {
  productSpaceContextStorage = {
    verifiedContext: {
      list: {
        contractVersion: 1,
        personalProductSpaceId: personalId,
        productSpaces: [personalSpace],
      },
      activeProductSpaceId: activeId,
      verifiedAt: Date.now(),
    },
    legacyCleanup: { completedAt: Date.now(), results: { all: true } },
  } as unknown as ProductSpaceContextStorage
  restoreViewResult = {
    success: true,
    snapshot: {
      contractVersion: 1,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
      activeProductSpaceId: activeId,
    },
  }
  listResult = { success: false, errorCode: 'NETWORK_ERROR', message: 'offline' }
}

/** The banner derivation fed from the LIVE hook projection. */
function deriveFromHook(hook: { current: ReturnType<typeof useHarness> }) {
  return deriveMembershipTransition({
    membershipListVerified: hook.current.membershipListVerified,
    allProductSpaces: hook.current.allProductSpaces,
    circles: [],
    memberships: [],
    circleReadDenied: false,
    audience: 'enterprise',
  })
}

describe('useProductSpaceContextState membershipListVerified 状态机 (POO-142 F1)', () => {
  it('登录成功选择后置位；发布前（loading 停留在权威拉取上）绝不提前置位', async () => {
    // Park the bootstrap on its authoritative membership fetch: call 1 hangs
    // until the test releases it, so the pre-publication window is real.
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    let releaseList!: () => void
    const gatedList = new Promise<ListResult>(resolve => {
      releaseList = () => resolve(listResult)
    })
    Object.defineProperty(window.electronAPI, 'productSpaceList', {
      configurable: true,
      value: async () => {
        listCalls += 1
        return listCalls === 1 ? gatedList : listResult
      },
    })

    const { result } = renderHook(useHarness)
    let booting: Promise<string | null> = Promise.resolve(null)
    await act(async () => {
      booting = result.current.bootstrap(accountId)
    })
    await waitFor(() => {
      if (listCalls !== 1) throw new Error('bootstrap not parked on the gated fetch yet')
    })
    // Pre-publication: loading, nothing committed, and the verified fact is
    // NOT set — an in-flight online read is not yet an online-verified fact.
    expect(result.current.flowState).toBe('loading')
    expect(result.current.activeProductSpaceId).toBeNull()
    expect(result.current.membershipListVerified).toBe(false)

    await act(async () => {
      releaseList()
      expect(await booting).toBe('ready')
    })
    // 登录成功选择后置位.
    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.membershipListVerified).toBe(true)
  })

  it('离线 restore 不置位：快照可 ready，但缓存快照永不支撑 banner（推导保持 unknown）', async () => {
    seedStaleVerifiedSnapshot()
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    // The restore published the cached projection — and NOTHING else.
    expect(restoreOfflineViewCalls).toBe(1)
    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.allProductSpaces.map(space => space.id as string)).toEqual([personalId])
    // The offline/cached restore NEVER sets the verified fact.
    expect(result.current.membershipListVerified).toBe(false)
    // Wired into the real banner derivation: receipts settled empty, but the
    // missing online verification alone keeps the state `unknown` — the
    // snapshot can never become a "no membership" claim.
    expect(deriveFromHook(result)).toEqual({ status: 'unknown', reason: 'spaces_unverified' })
  })

  it('在线恢复发布后置位（路径一：verified refresh）', async () => {
    seedStaleVerifiedSnapshot()
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.membershipListVerified).toBe(false)

    // Network returns; the manual-refresh channel IS the existing pull
    // channel — its success publishes an ONLINE-verified fact.
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    await act(async () => {
      expect(await result.current.refreshProductSpaces()).not.toBeNull()
    })
    expect(result.current.membershipListVerified).toBe(true)
    // And the derived banner state may now speak (personal-only = unaffiliated).
    expect(deriveFromHook(result)).toEqual({ status: 'unaffiliated', audience: 'enterprise' })
  })

  it('在线恢复发布后置位（路径二：Catalog403 trusted recovery 事务发布）', async () => {
    seedStaleVerifiedSnapshot()
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.membershipListVerified).toBe(false)

    // Network returns; the trusted recovery re-commits the restored scope
    // through PREPARE → STOP → COMMIT and republishes from the ONLINE list.
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    await act(async () => {
      expect(await result.current.recoverActiveProductSpace()).toBe(true)
    })
    expect(declaredActiveSpace).toBe(personalId)
    expect(result.current.flowState).toBe('ready')
    expect(result.current.membershipListVerified).toBe(true)
  })

  it('同 scope 在线 space 切换不丢失事实：target 重验证后仍为已验证', async () => {
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.membershipListVerified).toBe(true)

    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    // The switch-time target revalidation re-published an online-verified
    // list: the fact SURVIVES a same-scope space switch (it is only dropped
    // by a scope teardown — account replacement or contract teardown).
    expect(result.current.membershipListVerified).toBe(true)
  })

  it('普通刷新失败保留本 scope 的既有已验证事实', async () => {
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.membershipListVerified).toBe(true)

    listResult = { success: false, errorCode: 'NETWORK_ERROR', message: 'offline' }
    await act(async () => {
      expect(await result.current.refreshProductSpaces()).toBeNull()
    })
    // A plain network failure of a LATER refresh keeps the last verified
    // fact of this scope — only the bootstrap itself resets it.
    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.membershipListVerified).toBe(true)
  })

  it('账号切换重置：clearAccount 立即失效，新账号仅凭自己的在线读置位', async () => {
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.membershipListVerified).toBe(true)

    // Sign-out/account replacement drops the fact SYNCHRONOUSLY — account A's
    // verified membership can never leak into the next account's projection.
    await act(async () => {
      result.current.clearAccount()
    })
    expect(result.current.membershipListVerified).toBe(false)
    expect(result.current.allProductSpaces).toHaveLength(0)
    expect(result.current.flowState).toBe('idle')

    // Account B's bootstrap resets again at start and only sets the fact
    // from B's OWN authoritative fetch (held in flight → still false).
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    let releaseList!: () => void
    const gatedListB = new Promise<ListResult>(resolve => {
      releaseList = () => resolve(listResult)
    })
    Object.defineProperty(window.electronAPI, 'productSpaceList', {
      configurable: true,
      value: async () => {
        listCalls += 1
        return listCalls === 2 ? gatedListB : listResult
      },
    })

    let booting: Promise<string | null> = Promise.resolve(null)
    await act(async () => {
      booting = result.current.bootstrap(accountIdB)
    })
    await waitFor(() => {
      if (listCalls !== 2) throw new Error('bootstrap B not parked on its own fetch yet')
    })
    expect(result.current.accountId).toBe(accountIdB)
    expect(result.current.flowState).toBe('loading')
    expect(result.current.membershipListVerified).toBe(false)

    await act(async () => {
      releaseList()
      expect(await booting).toBe('ready')
    })
    expect(result.current.membershipListVerified).toBe(true)
  })

  it('contract-blocked 拆除重置：业务投影与 verified 事实一并失效', async () => {
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.membershipListVerified).toBe(true)

    listResult = {
      success: false,
      errorCode: 'product_space_contract_unsupported',
      message: 'unsupported',
      contractUnsupported: true,
    }
    await act(async () => {
      expect(await result.current.refreshProductSpaces()).toBeNull()
    })
    expect(result.current.flowState).toBe('contract-blocked')
    expect(result.current.allProductSpaces).toHaveLength(0)
    expect(result.current.activeProductSpaceId).toBeNull()
    // The contract teardown revokes every projection of this scope,
    // membership verification included.
    expect(result.current.membershipListVerified).toBe(false)
  })
})
