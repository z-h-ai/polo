import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type {
  ProductSpaceContextStorage,
  ProductSpaceContextStoragePatch,
} from '@polo-ai/shared/config/product-space-context'
import type { ProductSpaceSummary } from '@polo-ai/shared/product-spaces'

GlobalRegistrator.register()
setupI18n()

const accountId = 'account-a'
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
  overrides: Partial<ProductSpaceSummary> = {},
): ProductSpaceSummary {
  return {
    id,
    kind: 'enterprise',
    enterpriseId: `enterprise-${id}`,
    name,
    role: 'member',
    accessMode: 'active',
    payer: { kind: 'enterprise', enterpriseId: `enterprise-${id}` },
    ...overrides,
  } as unknown as ProductSpaceSummary
}

type ListResult =
  | { success: true; productSpaces: ProductSpaceSummary[]; personalProductSpaceId: string }
  | { success: false; errorCode: string; message: string; contractUnsupported?: boolean }

let listResult: ListResult
let executionsResult: {
  success: true
  executions: Array<{ executionId: string; name: string; status: string }>
} | { success: false; errorCode: string; message: string }
let stopAllResult: {
  success: true
  result: {
    allStopped: boolean
    executions: Array<{ executionId: string; name: string; status: string }>
  }
} | { success: false; errorCode: string; message: string }
let productSpaceContextStorage: ProductSpaceContextStorage | null = null

let cleanupResult: { success: boolean; results: Record<string, boolean> }
let catalogResult: { success: boolean; errorCode?: string }
let declaredActiveSpace: string | null | undefined
let activeContextAckSuccess: boolean
let cleanupCalls: number
let switchResult: {
  success: boolean
  errorCode?: string
  executions?: Array<{ executionId: string; status: 'stopped' | 'failed'; errorCode?: string }>
}
let commitResult: { success: boolean; errorCode?: string }
const cancelledTokens: string[] = []
let restoreOfflineViewCalls = 0
let restoreViewResult: {
  success: boolean
  errorCode?: string
  snapshot?: {
    contractVersion: number
    personalProductSpaceId: string
    productSpaces: typeof personalSpace[]
    activeProductSpaceId: string
  }
}
let stopExecutionResult: (
  token: string,
  executionId: string,
) => Promise<
  | { success: true; executionId: string; status: 'stopped' }
  | { success: false; errorCode: string; message?: string; status?: 'stopping' | 'failed' }
>
const restrictCalls: Array<{ accountId: string; productSpaceId: string; restricted: boolean }> = []
let restrictResult: (
  accountId: string,
  productSpaceId: string,
  restricted: boolean,
) => Promise<
  | { success: true; restricted?: boolean }
  | { success: false; errorCode: string; message?: string; failedExecutionIds?: string[]; restricted?: boolean }
>
/**
 * R34-2: the harness models Main's AUTHORITATIVE restriction fence with the
 * real semantics — a restrict(true) publishes the fence BEFORE stopping (it
 * stays set even when the stop fails) and a restrict(false) clears it
 * unconditionally. The new query channel reads exactly this state, so tests
 * exercise genuine reconciliation instead of a mocked verdict.
 */
const mainRestrictedSpaces = new Set<string>()
let restrictionStateFailure: string | null = null
/** Held bootstrap-clear gate for R35-2 publication-order tests. */
let releaseBootstrapClear: () => void = () => {}

function configureIpc(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      productSpaceList: async () => listResult,
      productSpaceListActiveExecutions: async () => executionsResult,
      productSpaceStopAllExecutions: async () => stopAllResult,
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
          from: 'space-personal',
          to: targetProductSpaceId,
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
        return { success: true as const, from: 'space-personal', to: targetProductSpaceId }
      },
      productSpaceCancelSwitch: async (token: string) => {
        cancelledTokens.push(token)
        // Default verdict for a held (pending) transaction; tests gate or
        // override this for the late-linearization scenarios.
        return { success: true as const, outcome: 'cancelled' as const }
      },
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
      productSpaceStopExecution: async (
        token: string,
        executionId: string,
      ) => stopExecutionResult(token, executionId),
      productSpaceRestrictActiveSpace: async (
        restrictAccountId: string,
        restrictSpaceId: string,
        restricted: boolean,
      ) => {
        restrictCalls.push({
          accountId: restrictAccountId,
          productSpaceId: restrictSpaceId,
          restricted,
        })
        // Main-side fence-first semantics (R33-2): the set direction keeps
        // the fence regardless of the stop outcome; the clear direction
        // clears unconditionally.
        if (restricted) mainRestrictedSpaces.add(restrictSpaceId)
        else mainRestrictedSpaces.delete(restrictSpaceId)
        return restrictResult(restrictAccountId, restrictSpaceId, restricted)
      },
      productSpaceGetRestrictionState: async (queryAccountId: string, querySpaceId: string) => {
        if (restrictionStateFailure) {
          return { success: false as const, errorCode: restrictionStateFailure }
        }
        if (queryAccountId !== accountId) {
          return { success: false as const, errorCode: 'FORBIDDEN' }
        }
        return { success: true as const, restricted: mainRestrictedSpaces.has(querySpaceId) }
      },
      productSpaceCleanupLegacyState: async () => {
        cleanupCalls += 1
        return cleanupResult
      },
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

function bothSpaces(): ListResult {
  return {
    success: true,
    personalProductSpaceId: personalId,
    productSpaces: [personalSpace, enterpriseSpace('space-ent', '北辰智能科技')],
  }
}

const { renderHook, act, waitFor } = await import('@testing-library/react')
const { useProductSpaceContextState } = await import('../useProductSpaceContext')
const {
  resetProductSpaceStorageMemoryForTests,
  setStoredActiveProductSpaceId,
  getStoredActiveProductSpaceId,
} = await import('@/lib/product-space-storage')

function useHarness() {
  return useProductSpaceContextState()
}

beforeEach(() => {
  resetProductSpaceStorageMemoryForTests()
  productSpaceContextStorage = null
  listResult = bothSpaces()
  executionsResult = { success: true, executions: [] }
  stopAllResult = { success: true, result: { allStopped: true, executions: [] } }
  cleanupResult = { success: true, results: {} }
  catalogResult = { success: true }
  declaredActiveSpace = undefined
  activeContextAckSuccess = true
  cleanupCalls = 0
  switchResult = { success: true, executions: [] }
  commitResult = { success: true }
  restoreViewResult = { success: false, errorCode: 'PRODUCT_SPACE_CONTEXT_REQUIRED' }
  restoreOfflineViewCalls = 0
  cancelledTokens.length = 0
  stopExecutionResult = async (token, executionId) => {
    if (!token.startsWith('token-')) {
      return { success: false as const, errorCode: 'SWITCH_TRANSACTION_INVALID', status: 'failed' as const }
    }
    return { success: true as const, executionId, status: 'stopped' as const }
  }
  restrictCalls.length = 0
  restrictResult = async (_accountId, _productSpaceId, restricted) => ({ success: true as const, restricted })
  mainRestrictedSpaces.clear()
  restrictionStateFailure = null
  releaseBootstrapClear = () => {}
  configureIpc()
})

afterEach(() => {
  resetProductSpaceStorageMemoryForTests()
})

async function boot(
  hook: { current: ReturnType<typeof useHarness> },
) {
  let outcome: string | null = null as string | null
  await act(async () => {
    outcome = await hook.current.bootstrap(accountId)
  })
  return outcome
}

describe('useProductSpaceContextState bootstrap', () => {
  it('enters the personal space on first login', async () => {
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.personalProductSpaceId).toBe(personalId)
    expect(result.current.productSpaceContextKey).toContain(personalId)
    expect(result.current.productSpaces.map(space => space.kind).sort())
      .toEqual(['enterprise', 'personal'])
  })

  it('restores the stored active space for the same account', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    expect(result.current.activeProductSpace?.name).toBe('北辰智能科技')
  })

  it('blocks the business surface when the contract is unsupported', async () => {
    listResult = {
      success: false,
      errorCode: 'product_space_contract_unsupported',
      message: 'unsupported',
      contractUnsupported: true,
    }
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('contract-blocked')
    expect(result.current.flowState).toBe('contract-blocked')
  })

  it('restores the read-only offline view from the verified snapshot', async () => {
    listResult = {
      success: false,
      errorCode: 'NETWORK_ERROR',
      message: 'offline',
    }
    const { result } = renderHook(useHarness)
    // First boot fails with no cached context.
    expect(await boot(result)).toBe('error')
    expect(result.current.flowState).toBe('error')

    // A later boot with a verified snapshot + completed ledger restores the
    // read-only view through the trusted Main snapshot.
    productSpaceContextStorage = {
      verifiedContext: {
        list: {
          contractVersion: 1,
          personalProductSpaceId: personalId,
          productSpaces: [personalSpace, enterpriseSpace('space-ent', '北辰智能科技')],
        },
        activeProductSpaceId: 'space-ent',
        verifiedAt: Date.now(),
      },
      legacyCleanup: { completedAt: Date.now(), results: { all: true } },
    } as unknown as ProductSpaceContextStorage
    restoreViewResult = {
      success: true,
      snapshot: {
        contractVersion: 1,
        personalProductSpaceId: personalId,
        productSpaces: [personalSpace, enterpriseSpace('space-ent', '北辰智能科技')],
        activeProductSpaceId: 'space-ent',
      },
    }
    const second = renderHook(useHarness)
    expect(await boot(second.result)).toBe('ready')
    expect(second.result.current.flowState).toBe('ready')
    expect(second.result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('keeps legacy organization state out of the ProductSpace list', async () => {
    localStorage.setItem('polo-active-organization:account-a', 'legacy-org')
    localStorage.setItem('polo-verified-organization-context:account-a', '{"organizationSummaries":[]}')
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.allProductSpaces.some(space => space.id === 'legacy-org')).toBe(false)
    expect(localStorage.getItem('polo-active-organization:account-a')).toBeNull()
    expect(localStorage.getItem('polo-verified-organization-context:account-a')).toBeNull()
  })
})

describe('useProductSpaceContextState switching', () => {
  it('switches directly when no execution is running', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    const versionBefore = result.current.contextVersion
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.pendingSwitch).toBeNull()
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    expect(result.current.contextVersion).toBe(versionBefore + 1)
  })

  it('commits a switch after every execution stopped', async () => {
    executionsResult = {
      success: true,
      executions: [
        { executionId: 'exec-1', name: '访谈整理', status: 'running' },
        { executionId: 'exec-2', name: '周报助手', status: 'preparing' },
      ],
    }
    stopAllResult = {
      success: true,
      result: {
        allStopped: true,
        executions: [
          { executionId: 'exec-1', name: '访谈整理', status: 'stopped' },
          { executionId: 'exec-2', name: '周报助手', status: 'stopped' },
        ],
      },
    }
    const { result } = renderHook(useHarness)
    await boot(result)
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.pendingSwitch?.phase).toBe('confirm')
    expect(result.current.pendingSwitch?.executions).toHaveLength(2)
    expect(result.current.activeProductSpaceId).toBe(personalId)

    await act(async () => {
      await result.current.confirmStopAndSwitch()
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch).toBeNull()
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('keeps the origin space when a stop fails and recovers on retry', async () => {
    executionsResult = {
      success: true,
      executions: [{ executionId: 'exec-1', name: '访谈整理', status: 'running' }],
    }
    const { result } = renderHook(useHarness)
    await boot(result)
    switchResult = {
      success: false,
      errorCode: 'runtime_stop_failed',
      executions: [{ executionId: 'exec-1', status: 'failed' }],
    }
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    await act(async () => {
      await result.current.confirmStopAndSwitch()
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch?.phase).toBe('stop-failed')
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.pendingSwitch?.statuses['exec-1']).toBe('failed')

    switchResult = { success: true, executions: [{ executionId: 'exec-1', status: 'stopped' }] }
    await act(async () => {
      await result.current.retryFailedStops()
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch).toBeNull()
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('keeps the origin space when the user cancels', async () => {
    executionsResult = {
      success: true,
      executions: [{ executionId: 'exec-1', name: '访谈整理', status: 'running' }],
    }
    const { result } = renderHook(useHarness)
    await boot(result)
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.pendingSwitch?.phase).toBe('confirm')
    await act(async () => {
      result.current.cancelSwitch()
    })
    expect(result.current.pendingSwitch).toBeNull()
    expect(result.current.activeProductSpaceId).toBe(personalId)
  })

  it('stays in the origin space when the target cannot be loaded, then retries', async () => {
    const passThrough = bothSpaces()
    let calls = 0
    let verifyFails = true
    Object.defineProperty(window.electronAPI, 'productSpaceList', {
      configurable: true,
      value: async () => {
        calls += 1
        if (calls === 1 || !verifyFails) return passThrough
        return { success: false, errorCode: 'service_unavailable', message: 'down' }
      },
    })

    const { result } = renderHook(useHarness)
    await boot(result)
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch?.phase).toBe('target-failed')
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)

    verifyFails = false
    await act(async () => {
      await result.current.retryTargetLoad()
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch).toBeNull()
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('removes a lost target from the switcher and stays in the origin space', async () => {
    const withEnt = bothSpaces()
    const withoutEnt: ListResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    let calls = 0
    Object.defineProperty(window.electronAPI, 'productSpaceList', {
      configurable: true,
      value: async () => {
        calls += 1
        return calls === 1 ? withEnt : withoutEnt
      },
    })

    const { result } = renderHook(useHarness)
    await boot(result)
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch?.phase).toBe('target-access-lost')
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.productSpaces.some(space => space.id === 'space-ent')).toBe(false)

    await act(async () => {
      result.current.dismissTargetAccessLost()
    })
    expect(result.current.pendingSwitch).toBeNull()
  })
})

describe('useProductSpaceContextState trusted commit gate (round 2)', () => {
  it('never enters the business surface while legacy cleanup keeps failing', async () => {
    cleanupResult = { success: false, results: { legacyCatalogCacheRemoved: false } }
    const first = renderHook(useHarness)
    expect(await boot(first.result)).toBe('error')

    const second = renderHook(useHarness)
    expect(await boot(second.result)).toBe('error')
    expect(second.result.current.flowState).toBe('error')
    expect(second.result.current.activeProductSpaceId).toBeNull()

    cleanupResult = { success: true, results: {} }
    const third = renderHook(useHarness)
    expect(await boot(third.result)).toBe('ready')
    expect(cleanupCalls).toBe(3)
  })

  it('runs the cleanup once and skips it on later boots via the ledger', async () => {
    const first = renderHook(useHarness)
    expect(await boot(first.result)).toBe('ready')
    expect(cleanupCalls).toBe(1)

    const second = renderHook(useHarness)
    expect(await boot(second.result)).toBe('ready')
    expect(cleanupCalls).toBe(1)
  })

  it('keeps the origin space when the runtime refuses the active-context commit', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    activeContextAckSuccess = false
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch?.phase).toBe('target-failed')
    })
    expect(result.current.pendingSwitch?.errorCode).toBe('runtime_commit_failed')
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(declaredActiveSpace).toBe(personalId)
  })
})

describe('useProductSpaceContextState switch staging (round 1)', () => {
  it('does not commit while the target catalog fails to load, then commits on retry', async () => {
    catalogResult = { success: false, errorCode: 'service_unavailable' }
    const { result } = renderHook(useHarness)
    await boot(result)
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch?.phase).toBe('target-failed')
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)

    catalogResult = { success: true }
    await act(async () => {
      await result.current.retryTargetLoad()
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch).toBeNull()
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    expect(declaredActiveSpace).toBe('space-ent')
  })

  it('re-prepares the trusted transaction after a commit-level failure, then commits on retry', async () => {
    // First commit consumes the one-time token at Main and fails; the retry
    // must prepare a fresh transaction instead of replaying a dead token.
    let commitCalls = 0
    Object.defineProperty(window.electronAPI, 'productSpaceCommitSwitch', {
      configurable: true,
      value: async (_token: string, targetProductSpaceId: string) => {
        commitCalls += 1
        // Call 1 is the bootstrap declaration; only the first switch commit
        // fails after consuming its token.
        if (commitCalls === 2) {
          return { success: false as const, errorCode: 'service_unavailable' }
        }
        declaredActiveSpace = targetProductSpaceId
        return { success: true as const, from: personalId, to: targetProductSpaceId }
      },
    })

    const { result } = renderHook(useHarness)
    await boot(result)
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch?.phase).toBe('target-failed')
    })
    expect(result.current.pendingSwitch?.errorCode).toBe('service_unavailable')
    expect(result.current.activeProductSpaceId).toBe(personalId)

    await act(async () => {
      await result.current.retryTargetLoad()
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch).toBeNull()
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    expect(declaredActiveSpace).toBe('space-ent')
    expect(commitCalls).toBe(3)
  })

  it('fails closed when the one-shot legacy cleanup fails', async () => {
    cleanupResult = { success: false, results: { legacyCatalogCacheRemoved: false } }
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('error')
    expect(result.current.flowState).toBe('error')
  })

  it('runs the trusted stop fence before returning to personal space on access loss', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)
    expect(result.current.activeProductSpaceId).toBe('space-ent')

    switchResult = {
      success: true,
      executions: [{ executionId: 'exec-1', status: 'stopped' }],
    }
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    await act(async () => {
      await result.current.refreshProductSpaces()
    })
    expect(declaredActiveSpace).toBe(personalId)
    expect(result.current.activeProductSpaceId).toBe(personalId)
  })

  it('keeps the lost space when its executions cannot be stopped', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)

    switchResult = {
      success: false,
      errorCode: 'runtime_stop_failed',
      executions: [{ executionId: 'exec-2', status: 'failed' }],
    }
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    await act(async () => {
      await result.current.refreshProductSpaces()
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    expect(result.current.flowState).toBe('error')
    expect(declaredActiveSpace).toBe('space-ent')
  })
})

describe('useProductSpaceContextState enterprise refresh signals', () => {
  it('shows a newly created enterprise without changing the current space', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.productSpaces).toHaveLength(2)

    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [
        personalSpace,
        enterpriseSpace('space-ent', '北辰智能科技'),
        enterpriseSpace('space-ent-2', '新企业'),
      ],
    }
    await act(async () => {
      await result.current.refreshProductSpaces()
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.productSpaces.some(space => space.id === 'space-ent-2')).toBe(true)
  })

  it('returns to the personal space when the active enterprise disappears', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)
    expect(result.current.activeProductSpaceId).toBe('space-ent')

    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    await act(async () => {
      await result.current.refreshProductSpaces()
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
  })

  it('keeps the current space when a refresh fails', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')

    listResult = { success: false, errorCode: 'NETWORK_ERROR', message: 'offline' }
    await act(async () => {
      const refreshed = await result.current.refreshProductSpaces()
      expect(refreshed).toBeNull()
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    expect(result.current.flowState).toBe('ready')
  })

  it('never publishes a list that lacks the active space when the fallback fails', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)
    expect(result.current.activeProductSpaceId).toBe('space-ent')

    // The membership list loses space-ent AND the personal fallback
    // transaction fails: the old complete projection stays published and the
    // hook enters the fail-closed error state — never a half-published list.
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    activeContextAckSuccess = false
    await act(async () => {
      await result.current.refreshProductSpaces()
    })
    activeContextAckSuccess = true
    expect(result.current.flowState).toBe('error')
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    // The stale enterprise space is still present in the published (old,
    // verified) list — no list without the active space was ever published.
    expect(result.current.allProductSpaces.some(space => space.id === 'space-ent')).toBe(true)
  })
})

describe('useProductSpaceContextState stale-snapshot shadowing (REQ-010)', () => {
  it('does not shadow the authoritative online list with the stale offline snapshot when a later stage fails', async () => {
    // Fixture-shaped state: the device snapshot still contains the
    // enterprise from a previous run, while the authoritative server list
    // is personal-only.
    productSpaceContextStorage = {
      verifiedContext: {
        list: {
          contractVersion: 1,
          personalProductSpaceId: personalId,
          productSpaces: [
            personalSpace,
            enterpriseSpace('space-stale-ent', '过期企业空间'),
          ],
        },
        activeProductSpaceId: personalId,
        verifiedAt: Date.now(),
      },
    } as unknown as ProductSpaceContextStorage
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    // The atomic switch to personal fails AFTER the authoritative fetch.
    activeContextAckSuccess = false

    const { result } = renderHook(useHarness)
    const outcome = await boot(result)
    activeContextAckSuccess = true

    // Fail closed: no business entry, no committed active space, and the
    // published list is the AUTHORITATIVE personal-only one — the stale
    // enterprise never renders.
    expect(outcome).toBe('error')
    expect(result.current.flowState).toBe('error')
    expect(result.current.activeProductSpaceId).toBeNull()
    expect(result.current.allProductSpaces.some(space => space.id === 'space-stale-ent')).toBe(false)
    // The offline restore must not even be attempted: the fetch succeeded.
    expect(restoreOfflineViewCalls).toBe(0)
  })

  it('an idempotent second bootstrap against the committed same space stays ready', async () => {
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe(personalId)

    // A second bootstrap of the live session (e.g. re-login/validate) must
    // succeed against the committed same space — not fail into a fallback.
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    expect(await boot(result)).toBe('ready')
    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.allProductSpaces.some(space => space.kind === 'personal')).toBe(true)
  })
})

describe('useProductSpaceContextState cancel race', () => {
  it('consumes the prepared token when the user cancels during stopping', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)

    // Executions present → confirm phase; the prepare resolves fast (token
    // held) and the stop phase hangs until we release it — the renderer
    // cancel must reach Main while stopping is still in flight.
    executionsResult = {
      success: true as const,
      executions: [
        { executionId: 'exec-1', name: 'Running item', status: 'running' },
      ],
    }
    let releaseStop!: (value: { success: true; executions: never[] }) => void
    const stopGate = new Promise<{ success: true; executions: never[] }>(resolve => {
      releaseStop = resolve
    })
    Object.defineProperty(window.electronAPI, 'productSpaceStopSwitchExecutions', {
      configurable: true,
      value: (token: string) => {
        cancelledTokens.push(`stop:${token}`)
        return stopGate
      },
    })

    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.pendingSwitch?.phase).toBe('confirm')

    let stopping: Promise<void> = Promise.resolve()
    await act(async () => {
      stopping = result.current.confirmStopAndSwitch()
    })
    await waitFor(() => {
      expect(result.current.pendingSwitch?.phase).toBe('stopping')
    })
    expect(cancelledTokens).toContain('stop:token-space-ent')

    // The user cancels while Main is still stopping — the cancel RPC must
    // carry the already-held token.
    await act(async () => {
      result.current.cancelSwitch()
    })
    expect(result.current.pendingSwitch).toBeNull()
    expect(cancelledTokens).toContain('token-space-ent')

    // Main finishes the in-flight stop dispatch; the stop result reports the
    // switch as cancelled and the renderer stays in the origin space.
    await act(async () => {
      releaseStop({ success: true as const, executions: [] })
      await stopping
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(declaredActiveSpace).toBe(personalId)
  })
})

describe('useProductSpaceContextState contract fail-closed during switch (R26)', () => {
  it('enters contract-blocked when the switch-time target revalidation finds an incompatible contract', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    let revokes = 0
    Object.defineProperty(window.electronAPI, 'productSpaceRevokeActiveContext', {
      configurable: true,
      value: async () => {
        revokes += 1
        return { success: true as const }
      },
    })
    // Installed AFTER bootstrap: the next productSpaceList call is exactly
    // the switch-time target revalidation (verifyTargetStillAccessible) — it
    // must surface the typed contract error instead of degrading to
    // "unavailable".
    Object.defineProperty(window.electronAPI, 'productSpaceList', {
      configurable: true,
      value: async () => ({
        success: false as const,
        errorCode: 'product_space_contract_unsupported',
        message: 'unsupported',
        contractUnsupported: true,
      }),
    })

    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.flowState).toBe('contract-blocked')
    expect(result.current.error?.code).toBe('product_space_contract_unsupported')
    // The contract-blocked path revoked the Main fence, cleared every
    // business projection and left no pending switch behind.
    expect(revokes).toBe(1)
    expect(result.current.productSpaces).toHaveLength(0)
    expect(result.current.allProductSpaces).toHaveLength(0)
    expect(result.current.activeProductSpaceId).toBeNull()
    expect(result.current.pendingSwitch).toBeNull()
    // The commit never ran: the fence transaction never reached Main.
    expect(declaredActiveSpace).toBe(personalId)
  })

  it('enters contract-blocked when PREPARE reports the typed contract error', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    switchResult = { success: false, errorCode: 'product_space_contract_unsupported' }

    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.flowState).toBe('contract-blocked')
    expect(result.current.error?.code).toBe('product_space_contract_unsupported')
    // Fail-closed: no target-failed dialog, no business projection, no
    // pending switch the user could still confirm.
    expect(result.current.pendingSwitch).toBeNull()
    expect(result.current.activeProductSpaceId).toBeNull()
    expect(result.current.productSpaces).toHaveLength(0)
    expect(declaredActiveSpace).toBe(personalId)
  })

  it('enters contract-blocked when COMMIT reports the typed contract error', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    commitResult = { success: false, errorCode: 'product_space_contract_unsupported' }

    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.flowState).toBe('contract-blocked')
    expect(result.current.error?.code).toBe('product_space_contract_unsupported')
    expect(result.current.pendingSwitch).toBeNull()
    expect(result.current.activeProductSpaceId).toBeNull()
    expect(result.current.productSpaces).toHaveLength(0)
    expect(declaredActiveSpace).toBe(personalId)
  })

  it('keeps the origin space when the commit is cancelled during the final list await', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    // Gate the commit so it resolves only after the user cancelled: Main's
    // post-await re-check rejects the tombstoned transaction (the Main-side
    // regression covers the fence), and the renderer must publish nothing.
    let commitCalls = 0
    let releaseCommit!: () => void
    const gatedCommit = new Promise<{ success: boolean; errorCode?: string }>(resolve => {
      releaseCommit = () => resolve({ success: false, errorCode: 'SWITCH_CANCELLED' })
    })
    Object.defineProperty(window.electronAPI, 'productSpaceCommitSwitch', {
      configurable: true,
      value: async () => {
        commitCalls += 1
        return gatedCommit
      },
    })

    let switching: Promise<void> = Promise.resolve()
    await act(async () => {
      switching = result.current.requestSwitch('space-ent')
    })
    for (let i = 0; i < 300 && commitCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(commitCalls).toBe(1)

    await act(async () => {
      result.current.cancelSwitch()
    })
    expect(result.current.pendingSwitch).toBeNull()

    await act(async () => {
      releaseCommit()
      await switching
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.flowState).toBe('ready')
    expect(result.current.pendingSwitch).toBeNull()
  })

  it('converges to the committed target when the commit won before the late cancel was processed', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    // The R27 linearization: the COMMIT wins Main's final gate and moves the
    // fence, but its response has not reached the renderer when the user's
    // cancel is sent. Main must report `already_committed` with the current
    // authoritative fence, and the renderer must converge to the committed
    // target instead of splitting Main fence and renderer projection.
    let commitCalls = 0
    let releaseCommit!: () => void
    const gatedCommit = new Promise<{ success: true; from: string; to: string }>(resolve => {
      releaseCommit = () => resolve({ success: true, from: personalId, to: 'space-ent' })
    })
    Object.defineProperty(window.electronAPI, 'productSpaceCommitSwitch', {
      configurable: true,
      value: async () => {
        commitCalls += 1
        return gatedCommit
      },
    })
    let cancelCalls = 0
    let releaseCancel!: () => void
    const gatedCancel = new Promise<{
      success: true
      outcome: 'already_committed'
      committedTargetProductSpaceId: string
      activeProductSpaceId: string
    }>(resolve => {
      releaseCancel = () => resolve({
        success: true,
        outcome: 'already_committed',
        committedTargetProductSpaceId: 'space-ent',
        activeProductSpaceId: 'space-ent',
      })
    })
    Object.defineProperty(window.electronAPI, 'productSpaceCancelSwitch', {
      configurable: true,
      value: async (token: string) => {
        cancelledTokens.push(token)
        cancelCalls += 1
        return gatedCancel
      },
    })

    let switching: Promise<void> = Promise.resolve()
    await act(async () => {
      switching = result.current.requestSwitch('space-ent')
    })
    for (let i = 0; i < 300 && commitCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(commitCalls).toBe(1)

    // The user cancels while the commit response is still in flight.
    await act(async () => {
      result.current.cancelSwitch()
    })
    expect(result.current.pendingSwitch).toBeNull()
    for (let i = 0; i < 300 && cancelCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(cancelCalls).toBe(1)

    // The COMMIT response (success — Main fence already moved to the target;
    // the resolving mock is the fence-movement signal) arrives first. The
    // renderer must wait for Main's cancellation verdict before deciding and
    // must not publish while the verdict is pending.
    await act(async () => {
      releaseCommit()
    })
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.pendingSwitch).toBeNull()

    // Main's verdict: already committed, committed target is the current
    // fence → the renderer converges to the committed target through the
    // same publish path as an ordinary commit.
    await act(async () => {
      releaseCancel()
      await switching
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
    expect(result.current.flowState).toBe('ready')
    expect(result.current.pendingSwitch).toBeNull()
    expect(result.current.productSpaceContextKey).toContain('space-ent')
  })

  it('stays on the origin when the committed target is no longer the current authoritative fence', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)
    // Main reports already_committed for the token, but the CURRENT fence
    // read-back has moved elsewhere (a newer commit): the stale target must
    // not be published.
    let commitCalls = 0
    let releaseCommit!: () => void
    const gatedCommit = new Promise<{ success: true; from: string; to: string }>(resolve => {
      releaseCommit = () => resolve({ success: true, from: personalId, to: 'space-ent' })
    })
    Object.defineProperty(window.electronAPI, 'productSpaceCommitSwitch', {
      configurable: true,
      value: async () => {
        commitCalls += 1
        return gatedCommit
      },
    })
    Object.defineProperty(window.electronAPI, 'productSpaceCancelSwitch', {
      configurable: true,
      value: async (token: string) => {
        cancelledTokens.push(token)
        return {
          success: true as const,
          outcome: 'already_committed' as const,
          committedTargetProductSpaceId: 'space-ent',
          activeProductSpaceId: personalId,
        }
      },
    })

    let switching: Promise<void> = Promise.resolve()
    await act(async () => {
      switching = result.current.requestSwitch('space-ent')
    })
    for (let i = 0; i < 300 && commitCalls === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await act(async () => {
      result.current.cancelSwitch()
    })
    await act(async () => {
      releaseCommit()
      await switching
    })
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(result.current.flowState).toBe('ready')
    expect(result.current.pendingSwitch).toBeNull()
  })
})

describe('useProductSpaceContextState overlapping switch operations (R28)', () => {
  it('a delayed first-switch completion cannot consume the newer switch or publish over it', async () => {
    // Fixture with two switchable enterprise targets.
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [
        personalSpace,
        enterpriseSpace('space-ent', '北辰智能科技'),
        enterpriseSpace('space-ent-2', '新企业'),
      ],
    }
    const { result } = renderHook(useHarness)
    await boot(result)
    expect(result.current.activeProductSpaceId).toBe(personalId)

    // Switch A targets space-ent; its COMMIT wins at Main but the response
    // is held (delayed).
    const commitTargets: string[] = []
    let releaseCommitA!: () => void
    const gatedCommitA = new Promise<{ success: true; from: string; to: string }>(resolve => {
      releaseCommitA = () => resolve({ success: true, from: personalId, to: 'space-ent' })
    })
    Object.defineProperty(window.electronAPI, 'productSpaceCommitSwitch', {
      configurable: true,
      value: async (_token: string, targetProductSpaceId: string) => {
        commitTargets.push(targetProductSpaceId)
        if (targetProductSpaceId === 'space-ent') {
          // Switch A: Main wins the fence write, but the response is held.
          return gatedCommitA
        }
        // Main's authoritative fence write for every other commit.
        declaredActiveSpace = targetProductSpaceId
        return { success: true as const, from: personalId, to: targetProductSpaceId }
      },
    })

    let switchingA: Promise<void> = Promise.resolve()
    await act(async () => {
      switchingA = result.current.requestSwitch('space-ent')
    })
    for (let i = 0; i < 300 && commitTargets.length < 1; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(commitTargets).toEqual(['space-ent'])

    // The user cancels A (dialog closes, generation advances, the cancel
    // verdict is requested for A's own token) and immediately starts
    // switch B to the second target.
    await act(async () => {
      result.current.cancelSwitch()
    })
    expect(result.current.pendingSwitch).toBeNull()
    expect(cancelledTokens).toContain('token-space-ent')

    await act(async () => {
      await result.current.requestSwitch('space-ent-2')
    })
    // Switch B committed and published everywhere: Main fence, renderer
    // active id, persisted selection, context key and dialog state.
    expect(declaredActiveSpace).toBe('space-ent-2')
    expect(result.current.activeProductSpaceId).toBe('space-ent-2')
    expect(getStoredActiveProductSpaceId(accountId)).toBe('space-ent-2')
    expect(result.current.productSpaceContextKey).toContain('space-ent-2')
    expect(result.current.pendingSwitch).toBeNull()
    expect(result.current.flowState).toBe('ready')

    // A's delayed COMMIT success must NOT consume B's token/verdict state or
    // publish A: the operation-scoped records keep every signal on its own
    // operation, so the renderer stays converged on B.
    await act(async () => {
      releaseCommitA()
      await switchingA
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent-2')
    expect(getStoredActiveProductSpaceId(accountId)).toBe('space-ent-2')
    expect(result.current.productSpaceContextKey).toContain('space-ent-2')
    expect(result.current.pendingSwitch).toBeNull()
    expect(result.current.flowState).toBe('ready')
    expect(declaredActiveSpace).toBe('space-ent-2')
  })
})

describe('useProductSpaceContextState per-item stop reachability (R33-3)', () => {
  it('keeps real row statuses through the stopping phase and stops exactly the selected row', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)

    executionsResult = {
      success: true as const,
      executions: [
        { executionId: 'exec-1', name: 'Running item', status: 'running' },
        { executionId: 'exec-2', name: 'Waiting item', status: 'waiting_for_network' },
      ],
    }
    // The stop-all dispatch hangs so the dialog stays in the stopping
    // phase with the prepared token held — the window where per-item stop
    // must be reachable.
    let releaseStopAll!: (value: { success: true; executions: never[] }) => void
    const stopAllGate = new Promise<{ success: true; executions: never[] }>(resolve => {
      releaseStopAll = resolve
    })
    let stopAllEntered = false
    Object.defineProperty(window.electronAPI, 'productSpaceStopSwitchExecutions', {
      configurable: true,
      value: () => {
        stopAllEntered = true
        return stopAllGate
      },
    })

    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    expect(result.current.pendingSwitch?.phase).toBe('confirm')
    expect(result.current.pendingSwitch?.statuses['exec-1']).toBe('running')
    expect(result.current.pendingSwitch?.statuses['exec-2']).toBe('waiting_for_network')

    let stopping: Promise<void> = Promise.resolve()
    await act(async () => {
      stopping = result.current.confirmStopAndSwitch()
    })
    await waitFor(() => {
      expect(stopAllEntered).toBe(true)
    })
    expect(result.current.pendingSwitch?.phase).toBe('stopping')
    // R33-3: the phase advanced but rows keep their REAL statuses — the
    // old blanket 'stopping' made every per-item stop unreachable.
    expect(result.current.pendingSwitch?.statuses['exec-1']).toBe('running')
    expect(result.current.pendingSwitch?.statuses['exec-2']).toBe('waiting_for_network')

    // Single stop: only the selected row moves to 'stopping' and then to
    // its terminal outcome; the sibling row is untouched.
    await act(async () => {
      await result.current.stopSwitchExecution('exec-1')
    })
    expect(result.current.pendingSwitch?.statuses['exec-1']).toBe('stopped')
    expect(result.current.pendingSwitch?.statuses['exec-2']).toBe('waiting_for_network')

    // A stale-token rejection is truthful: the row reports 'failed' for
    // retry instead of pretending success.
    stopExecutionResult = async () => ({
      success: false as const,
      errorCode: 'EXECUTION_SUPERSEDED',
      status: 'failed' as const,
    })
    await act(async () => {
      await result.current.stopSwitchExecution('exec-2')
    })
    expect(result.current.pendingSwitch?.statuses['exec-2']).toBe('failed')

    await act(async () => {
      releaseStopAll({ success: true as const, executions: [] })
      await stopping
    })
    expect(result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('refuses a per-item stop before the prepared token exists', async () => {
    const { result } = renderHook(useHarness)
    await boot(result)

    executionsResult = {
      success: true as const,
      executions: [
        { executionId: 'exec-1', name: 'Running item', status: 'running' },
      ],
    }
    let stopCalls = 0
    Object.defineProperty(window.electronAPI, 'productSpaceStopExecution', {
      configurable: true,
      value: async () => {
        stopCalls += 1
        return { success: true as const, executionId: 'exec-1', status: 'stopped' as const }
      },
    })

    await act(async () => {
      await result.current.requestSwitch('space-ent')
    })
    // Confirm phase: no token is held yet — the click is a safe no-op.
    await act(async () => {
      await result.current.stopSwitchExecution('exec-1')
    })
    expect(stopCalls).toBe(0)
    expect(result.current.pendingSwitch?.statuses['exec-1']).toBe('running')
  })
})

describe('useProductSpaceContextState restriction transaction (R33-2)', () => {
  it('a failed restriction fails closed, and verified active recovery clears the fence regardless of cached mode', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)
    expect(result.current.activeProductSpaceId).toBe('space-ent')

    // Verified active→read_only transition; the trusted stop fails. Main
    // has ALREADY fenced the space (fence-first), so the renderer records
    // fence state and refuses the restricted projection.
    restrictResult = async () => ({
      success: false as const,
      errorCode: 'runtime_stop_failed',
      restricted: true,
    })
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [
        personalSpace,
        enterpriseSpace('space-ent', '北辰智能科技', { accessMode: 'read_only' }),
      ],
    }
    await act(async () => {
      const refreshed = await result.current.refreshProductSpaces()
      expect(refreshed).toBeNull()
    })
    expect(result.current.flowState).toBe('error')
    expect(restrictCalls).toEqual([
      { accountId, productSpaceId: 'space-ent', restricted: true },
    ])

    // The list flips back to verified ACTIVE. The cached previousMode is
    // still 'active' (the failed refresh never published), yet the recovery
    // MUST clear Main's lingering fence — the old cached-edge logic left it
    // restricted forever.
    restrictResult = async (_accountId, _productSpaceId, restricted) => ({
      success: true as const,
      restricted,
    })
    listResult = bothSpaces()
    await act(async () => {
      const refreshed = await result.current.refreshProductSpaces()
      expect(refreshed).not.toBeNull()
    })
    expect(restrictCalls).toEqual([
      { accountId, productSpaceId: 'space-ent', restricted: true },
      { accountId, productSpaceId: 'space-ent', restricted: false },
    ])
    expect(result.current.flowState).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('a failed clear is fail-closed', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)

    // Establish the restricted projection successfully.
    restrictResult = async (_accountId, _productSpaceId, restricted) => ({
      success: true as const,
      restricted,
    })
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [
        personalSpace,
        enterpriseSpace('space-ent', '北辰智能科技', { accessMode: 'read_only' }),
      ],
    }
    await act(async () => {
      const refreshed = await result.current.refreshProductSpaces()
      expect(refreshed).not.toBeNull()
    })
    expect(result.current.flowState).toBe('ready')

    // Verified active recovery whose clear FAILS: fail closed, never trust
    // an unfenced active projection while Main may still be restricted.
    restrictResult = async () => ({
      success: false as const,
      errorCode: 'SWITCH_LOCK_BUSY',
    })
    listResult = bothSpaces()
    await act(async () => {
      const refreshed = await result.current.refreshProductSpaces()
      expect(refreshed).toBeNull()
    })
    expect(result.current.flowState).toBe('error')
    expect(result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('an account replacement during the restriction await aborts the publication', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)

    let releaseRestrict!: (value: { success: true; restricted: true }) => void
    const restrictGate = new Promise<{ success: true; restricted: true }>(resolve => {
      releaseRestrict = resolve
    })
    restrictResult = () => restrictGate
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [
        personalSpace,
        enterpriseSpace('space-ent', '北辰智能科技', { accessMode: 'read_only' }),
      ],
    }

    let refreshed: unknown = 'pending'
    await act(async () => {
      refreshed = result.current.refreshProductSpaces()
    })
    // The account is replaced while the restriction RPC is in flight.
    await act(async () => {
      result.current.clearAccount()
    })
    await act(async () => {
      releaseRestrict({ success: true as const, restricted: true })
      refreshed = await refreshed
    })
    // Post-await scope CAS: the stale refresh publishes nothing.
    expect(refreshed).toBeNull()
    expect(result.current.flowState).toBe('idle')
    expect(result.current.productSpaces).toEqual([])
  })
})

describe('useProductSpaceContextState durable restriction reconciliation (R34-2)', () => {
  const readOnlyList = () => ({
    success: true as const,
    personalProductSpaceId: personalId,
    productSpaces: [
      personalSpace,
      enterpriseSpace('space-ent', '北辰智能科技', { accessMode: 'read_only' as const }),
    ],
  })

  it('a renderer reload after a failed restriction reconciles Main and the verified active recovery clears the lingering fence', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    // Session 1: the restriction stop fails — Main keeps the authoritative
    // fence (fence-first), the renderer parks on the error page.
    const first = renderHook(useHarness)
    await boot(first.result)
    restrictResult = async () => ({
      success: false as const,
      errorCode: 'runtime_stop_failed',
      restricted: true,
    })
    listResult = readOnlyList()
    await act(async () => {
      expect(await first.result.current.refreshProductSpaces()).toBeNull()
    })
    expect(first.result.current.flowState).toBe('error')
    expect(restrictCalls).toEqual([
      { accountId, productSpaceId: 'space-ent', restricted: true },
    ])

    // Reload: every renderer memory is gone, Main's fence survives. The
    // membership has already recovered, so the reloaded bootstrap enters
    // the active space again — and (R35-2) the BOOTSTRAP ITSELF completes
    // the Main clear before publishing ready.
    first.unmount()
    listResult = bothSpaces()
    restrictResult = async (_accountId, _productSpaceId, restricted) => ({
      success: true as const,
      restricted,
    })
    const second = renderHook(useHarness)
    expect(await boot(second.result)).toBe('ready')

    // No second refresh is required for the recovery.
    await act(async () => {
      expect(await second.result.current.refreshProductSpaces()).not.toBeNull()
    })
    expect(restrictCalls).toEqual([
      { accountId, productSpaceId: 'space-ent', restricted: true },
      { accountId, productSpaceId: 'space-ent', restricted: false },
    ])
    expect(second.result.current.flowState).toBe('ready')
    expect(second.result.current.activeProductSpaceId).toBe('space-ent')
  })

  it('retryBootstrap reconciles Main the same way after a failed restriction', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)

    restrictResult = async () => ({
      success: false as const,
      errorCode: 'runtime_stop_failed',
      restricted: true,
    })
    listResult = readOnlyList()
    await act(async () => {
      expect(await result.current.refreshProductSpaces()).toBeNull()
    })
    expect(result.current.flowState).toBe('error')

    // Membership recovers; the retry goes through the SAME bootstrap
    // reconciliation path as a reload and (R35-2) completes the clear
    // before its ready publication.
    listResult = bothSpaces()
    restrictResult = async (_accountId, _productSpaceId, restricted) => ({
      success: true as const,
      restricted,
    })
    await act(async () => {
      expect(await result.current.retryBootstrap()).toBe('ready')
    })

    await act(async () => {
      expect(await result.current.refreshProductSpaces()).not.toBeNull()
    })
    expect(restrictCalls).toEqual([
      { accountId, productSpaceId: 'space-ent', restricted: true },
      { accountId, productSpaceId: 'space-ent', restricted: false },
    ])
    expect(result.current.flowState).toBe('ready')
  })

  it('an account replacement during the recovery clear await aborts the publication', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)

    // Establish the restricted projection successfully: Main is fenced.
    restrictResult = async (_accountId, _productSpaceId, restricted) => ({
      success: true as const,
      restricted,
    })
    listResult = readOnlyList()
    await act(async () => {
      expect(await result.current.refreshProductSpaces()).not.toBeNull()
    })
    expect(result.current.flowState).toBe('ready')

    // Membership recovers; the clear is held in flight while the account is
    // replaced. The post-await scope CAS must abort the whole publication.
    listResult = bothSpaces()
    let releaseClear!: (value: { success: true; restricted: false }) => void
    const clearGate = new Promise<{ success: true; restricted: false }>(resolve => {
      releaseClear = resolve
    })
    restrictResult = (_accountId, _productSpaceId, restricted) => (
      restricted
        ? Promise.resolve({ success: true as const, restricted })
        : clearGate
    )
    let refreshed: unknown = 'pending'
    await act(async () => {
      refreshed = result.current.refreshProductSpaces()
    })
    await act(async () => {
      result.current.clearAccount()
    })
    await act(async () => {
      releaseClear({ success: true as const, restricted: false })
      refreshed = await refreshed
    })
    expect(refreshed).toBeNull()
    expect(result.current.flowState).toBe('idle')
    expect(result.current.productSpaces).toEqual([])
  })

  it('a restriction-state query failure during bootstrap fails closed', async () => {
    restrictionStateFailure = 'MAIN_UNAVAILABLE'
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('error')
    expect(result.current.flowState).toBe('error')
  })
})

describe('useProductSpaceContextState bootstrap restriction recovery (R35-2)', () => {
  const readOnlyList = () => ({
    success: true as const,
    personalProductSpaceId: personalId,
    productSpaces: [
      personalSpace,
      enterpriseSpace('space-ent', '北辰智能科技', { accessMode: 'read_only' as const }),
    ],
  })

  it('bootstrap completes the Main clear BEFORE publishing ready — never ready-first', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    // Session 1: a failed restriction leaves Main fenced.
    const first = renderHook(useHarness)
    await boot(first.result)
    restrictResult = async () => ({
      success: false as const,
      errorCode: 'runtime_stop_failed',
      restricted: true,
    })
    listResult = readOnlyList()
    await act(async () => {
      expect(await first.result.current.refreshProductSpaces()).toBeNull()
    })
    first.unmount()

    // Reload with recovered ACTIVE membership: the bootstrap holds the clear
    // in flight — no ready may be published while it awaits.
    listResult = bothSpaces()
    restrictResult = (_accountId, _productSpaceId, restricted) => (
      restricted
        ? Promise.resolve({ success: true as const, restricted })
        : new Promise<{ success: true; restricted: false }>(resolve => {
          releaseBootstrapClear = () => resolve({ success: true as const, restricted: false })
        })
    )
    const second = renderHook(useHarness)
    let bootSettled: string | null = null
    await act(async () => {
      void second.result.current.bootstrap(accountId).then(value => {
        bootSettled = value
      })
      // Let the bootstrap reach the clear await.
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    // Publication order: while the clear is in flight, NO ready exists —
    // the bootstrap has neither returned nor published a selection.
    expect(bootSettled).toBeNull()
    expect(second.result.current.flowState).toBe('loading')
    expect(second.result.current.activeProductSpaceId).toBeNull()
    await act(async () => {
      releaseBootstrapClear()
      await new Promise(resolve => setTimeout(resolve, 30))
    })
    expect<string | null>(bootSettled).toBe('ready')
    expect(second.result.current.flowState).toBe('ready')
    expect(second.result.current.activeProductSpaceId).toBe('space-ent')
    expect(restrictCalls).toEqual([
      { accountId, productSpaceId: 'space-ent', restricted: true },
      { accountId, productSpaceId: 'space-ent', restricted: false },
    ])
  })

  it('a failed bootstrap clear is fail-closed and never reaches ready', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const first = renderHook(useHarness)
    await boot(first.result)
    restrictResult = async () => ({
      success: false as const,
      errorCode: 'runtime_stop_failed',
      restricted: true,
    })
    listResult = readOnlyList()
    await act(async () => {
      expect(await first.result.current.refreshProductSpaces()).toBeNull()
    })
    first.unmount()

    // Membership is ACTIVE again but the clear transaction fails: the
    // bootstrap must error instead of publishing an unrecovered ready.
    listResult = bothSpaces()
    restrictResult = async () => ({
      success: false as const,
      errorCode: 'SWITCH_LOCK_BUSY',
    })
    const second = renderHook(useHarness)
    expect(await boot(second.result)).toBe('error')
    expect(second.result.current.flowState).toBe('error')
    expect(second.result.current.activeProductSpaceId).toBeNull()
    expect(restrictCalls).toEqual([
      { accountId, productSpaceId: 'space-ent', restricted: true },
      { accountId, productSpaceId: 'space-ent', restricted: false },
    ])
  })

  it('an account replacement during the bootstrap clear await aborts the bootstrap', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const first = renderHook(useHarness)
    await boot(first.result)
    restrictResult = async () => ({
      success: false as const,
      errorCode: 'runtime_stop_failed',
      restricted: true,
    })
    listResult = readOnlyList()
    await act(async () => {
      expect(await first.result.current.refreshProductSpaces()).toBeNull()
    })
    first.unmount()

    listResult = bothSpaces()
    restrictResult = (_accountId, _productSpaceId, restricted) => (
      restricted
        ? Promise.resolve({ success: true as const, restricted })
        : new Promise<{ success: true; restricted: false }>(resolve => {
          releaseBootstrapClear = () => resolve({ success: true as const, restricted: false })
        })
    )
    const second = renderHook(useHarness)
    let bootOutcome: string | null | undefined
    await act(async () => {
      const bootPromise = second.result.current.bootstrap(accountId)
      await new Promise(resolve => setTimeout(resolve, 30))
      // The account is replaced while the clear is in flight.
      second.result.current.clearAccount()
      releaseBootstrapClear()
      bootOutcome = await bootPromise
    })
    // The post-await CAS aborts: no selection, no ready.
    expect(bootOutcome).toBeNull()
    expect(second.result.current.activeProductSpaceId).toBeNull()
    expect(second.result.current.flowState).toBe('idle')
  })

  it('a read_only membership target gets NO bootstrap recovery clear', async () => {
    // Main retains the restriction for the enterprise space while its
    // membership is still read_only: bootstrap selects the personal
    // fallback and must NOT clear the fenced space.
    mainRestrictedSpaces.add('space-ent')
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    listResult = readOnlyList()
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('ready')
    expect(result.current.activeProductSpaceId).toBe(personalId)
    expect(restrictCalls).toEqual([])
    // The renderer fence memory still tracks Main's authoritative state for
    // the read-only space.
    expect(result.current.flowState).toBe('ready')
  })
})
