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

function configureIpc(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      productSpaceList: async () => listResult,
      productSpaceListActiveExecutions: async () => executionsResult,
      productSpaceStopAllExecutions: async () => stopAllResult,
      productSpaceGetCatalog: async () => catalogResult,
      productSpaceSetActiveSpace: async (productSpaceId: string | null) => {
        declaredActiveSpace = productSpaceId
        return { success: true }
      },
      productSpaceCleanupLegacyState: async () => cleanupResult,
      getProductSpaceContextStorage: async () => productSpaceContextStorage,
      updateProductSpaceContextStorage: async (
        _accountId: string,
        patch: ProductSpaceContextStoragePatch,
      ) => {
        const next: ProductSpaceContextStorage = { ...(productSpaceContextStorage ?? {}) }
        if (patch.verifiedContext === null) delete next.verifiedContext
        else if (patch.verifiedContext) next.verifiedContext = patch.verifiedContext
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

  it('falls back to the last verified context while offline', async () => {
    listResult = {
      success: false,
      errorCode: 'NETWORK_ERROR',
      message: 'offline',
    }
    const { result } = renderHook(useHarness)
    // First boot fails with no cached context.
    expect(await boot(result)).toBe('error')
    expect(result.current.flowState).toBe('error')

    // A later boot with a verified snapshot keeps the account working.
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
    } as unknown as ProductSpaceContextStorage
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
    stopAllResult = {
      success: true,
      result: {
        allStopped: true,
        executions: [{ executionId: 'exec-1', name: '访谈整理', status: 'failed' }],
      },
    }
    const { result } = renderHook(useHarness)
    await boot(result)
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

    stopAllResult = {
      success: true,
      result: {
        allStopped: true,
        executions: [{ executionId: 'exec-1', name: '访谈整理', status: 'stopped' }],
      },
    }
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

  it('fails closed when the one-shot legacy cleanup fails', async () => {
    cleanupResult = { success: false, results: { legacyCatalogCacheRemoved: false } }
    const { result } = renderHook(useHarness)
    expect(await boot(result)).toBe('error')
    expect(result.current.flowState).toBe('error')
  })

  it('runs the stop-all fence before returning to personal space on access loss', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)
    expect(result.current.activeProductSpaceId).toBe('space-ent')

    executionsResult = {
      success: true,
      executions: [{ executionId: 'exec-1', name: '企业任务', status: 'running' }],
    }
    let stopAllCalls = 0
    Object.defineProperty(window.electronAPI, 'productSpaceStopAllExecutions', {
      configurable: true,
      value: async () => {
        stopAllCalls += 1
        return stopAllResult
      },
    })
    stopAllResult = {
      success: true,
      result: {
        allStopped: true,
        executions: [{ executionId: 'exec-1', name: '企业任务', status: 'stopped' }],
      },
    }
    listResult = {
      success: true,
      personalProductSpaceId: personalId,
      productSpaces: [personalSpace],
    }
    await act(async () => {
      await result.current.refreshProductSpaces()
    })
    expect(stopAllCalls).toBe(1)
    expect(result.current.activeProductSpaceId).toBe(personalId)
  })

  it('keeps the lost space when its executions cannot be stopped', async () => {
    setStoredActiveProductSpaceId(accountId, 'space-ent')
    const { result } = renderHook(useHarness)
    await boot(result)

    stopAllResult = {
      success: true,
      result: {
        allStopped: true,
        executions: [{ executionId: 'exec-1', name: '企业任务', status: 'failed' }],
      },
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
})
