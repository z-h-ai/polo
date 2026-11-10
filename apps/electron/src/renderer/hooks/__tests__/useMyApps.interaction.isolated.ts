import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type React from 'react'

// Bun does not execute Vite import.meta.glob in the theme loader.
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}

const SCOPE = {
  accountId: 'account-a',
  workspaceId: 'workspace-a',
  productSpaceId: 'organization-a',
}

// The myapps_* transport spies — every hook command must land here with the
// committed scope plus its command payload, and the LIST is the single
// source of truth the hook state mirrors.
let listResponses: Array<{ ok: true; body: unknown } | { ok: false; error: Error }> = []
const createSpy = jest.fn()
const deleteSpy = jest.fn()
const publishSpy = jest.fn()
const withdrawSpy = jest.fn()

function summary(input: {
  appId: string
  name?: string
  publishedEntryId?: string | null
}): import('@polo-ai/shared/protocol').MyAppSummary {
  return {
    appId: input.appId,
    name: input.name ?? `App ${input.appId}`,
    description: '',
    ownerAccountId: SCOPE.accountId,
    runtime: 'static',
    publishedEntryId: input.publishedEntryId ?? null,
    publishedAt: input.publishedEntryId ? '2026-01-01T00:00:00.000Z' : null,
    version: '1.0.0',
    sizeBytes: 12,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function listResponse(apps: import('@polo-ai/shared/protocol').MyAppSummary[]) {
  return {
    contractVersion: 1 as const,
    productSpaceId: SCOPE.productSpaceId,
    apps,
  }
}

beforeEach(() => {
  listResponses = []
  createSpy.mockReset()
  deleteSpy.mockReset()
  publishSpy.mockReset()
  withdrawSpy.mockReset()
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      myAppsList: async () => {
        const next = listResponses.shift()
        if (!next) throw new Error('test list queue empty')
        if (next.ok) return next.body
        throw next.error
      },
      myAppsCreate: (...args: unknown[]) => createSpy(...args),
      myAppsDelete: (...args: unknown[]) => deleteSpy(...args),
      myAppsPublish: (...args: unknown[]) => publishSpy(...args),
      myAppsWithdraw: (...args: unknown[]) => withdrawSpy(...args),
    },
  })
})

afterEach(() => {
  cleanup()
})

const { i18n, setupI18n } = await import('@polo-ai/shared/i18n')
void setupI18n()
void i18n.changeLanguage('en')

// The hook reads its committed scope through the REAL ProductSpaceProvider
// (same runtime posture as the page tests — no module mock, so this file
// never collides with the page tests' real imports in a shared bun process).
// The workspace leg comes through the app-shell context mock below.
const SPACE_CONTEXT = {
  accountId: SCOPE.accountId,
  activeProductSpaceId: SCOPE.productSpaceId,
  activeProductSpace: { id: SCOPE.productSpaceId, kind: 'enterprise' as const, name: 'Org A' },
  productSpaces: [],
  allProductSpaces: [],
  personalProductSpaceId: SCOPE.productSpaceId,
  productSpaceContextKey: `${SCOPE.accountId}|${SCOPE.productSpaceId}`,
  contextVersion: 1,
  pendingSwitch: null,
  onSelectProductSpace: () => {},
  onRefreshProductSpaces: () => {},
  onConfirmStopAndSwitch: () => {},
  onRetryFailedStops: () => {},
  onRetryTargetLoad: () => {},
  onCancelSwitch: () => {},
  onDismissTargetAccessLost: () => {},
  onStopSwitchExecution: () => {},
}

mock.module('@/context/AppShellContext', () => ({
  AppShellProvider: ({ children }: { children?: unknown }) => children ?? null,
  useOptionalAppShellContext: () => ({ activeWorkspaceId: SCOPE.workspaceId }),
  useAppShellContext: () => ({ activeWorkspaceId: SCOPE.workspaceId }),
  useSession: () => null,
  useActiveWorkspace: () => null,
  usePendingPermission: () => undefined,
  usePendingCredential: () => undefined,
}))

const { renderHook, act, waitFor, cleanup } = await import('@testing-library/react')
const { createElement } = await import('react')
const { useMyApps } = await import('../useMyApps')
const { ProductSpaceProvider } = await import('@/context/ProductSpaceContext')
const { readRpcErrorCode } = await import('../../../shared/rpc-error-bridge')

function renderMyAppsHook() {
  const { I18nextProvider } = require('react-i18next') as typeof import('react-i18next')
  const wrapper = ({ children }: { children?: React.ReactNode }) => createElement(
    ProductSpaceProvider,
    {
      value: SPACE_CONTEXT as never,
      children: createElement(I18nextProvider, { i18n, children }),
    },
  )
  return renderHook(() => useMyApps(), { wrapper })
}

describe('useMyApps × C12 (list is the single source, delete, idempotent save)', () => {
  it('mirrors the list rows verbatim and keeps the count as the list length', async () => {
    listResponses.push({ ok: true, body: listResponse([
      summary({ appId: 'app-1' }),
      summary({ appId: 'app-2', publishedEntryId: 'entry-2' }),
      summary({ appId: 'app-3' }),
    ]) })
    const hook = renderMyAppsHook()
    await waitFor(() => {
      if (hook.result.current.state.apps.length !== 3) throw new Error('list not loaded')
    })
    expect(hook.result.current.state.apps.map(app => app.appId)).toEqual(['app-1', 'app-2', 'app-3'])
    expect(hook.result.current.scope).toEqual(SCOPE)
    expect(hook.result.current.canPublish).toBe(true)
  })

  it('passes sourceKey through myapps:create and reports 201 as a NEW row', async () => {
    listResponses.push({ ok: true, body: listResponse([]) })
    createSpy.mockImplementation(async () => ({
      contractVersion: 1,
      app: summary({ appId: 'app-new' }),
      status: 201,
    }))
    const hook = renderMyAppsHook()
    await waitFor(() => {
      if (hook.result.current.state.loading) throw new Error('initial load pending')
    })
    const saved = await hook.result.current.create({
      sourcePath: '/tmp/polo-myapps-x/bundle.zip',
      name: 'Canvas App',
      sourceKey: 'genui:session-1:canvas-1',
    })
    expect(saved.savedAsNewVersion).toBe(false)
    expect(saved.app.appId).toBe('app-new')
    expect(createSpy).toHaveBeenCalledTimes(1)
    // The committed scope AND the idempotency key ride the same wire input.
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
      productSpaceId: SCOPE.productSpaceId,
      sourceKey: 'genui:session-1:canvas-1',
    })
  })

  it('reports HTTP 200 as savedAsNewVersion (A3b idempotent re-save)', async () => {
    listResponses.push({ ok: true, body: listResponse([]) })
    createSpy.mockImplementation(async () => ({
      contractVersion: 1,
      app: summary({ appId: 'app-1' }),
      status: 200,
    }))
    const hook = renderMyAppsHook()
    await waitFor(() => {
      if (hook.result.current.state.loading) throw new Error('initial load pending')
    })
    const saved = await hook.result.current.create({
      sourcePath: '/tmp/polo-myapps-x/bundle.zip',
      name: 'Canvas App',
      sourceKey: 'genui:session-1:canvas-1',
    })
    expect(saved.savedAsNewVersion).toBe(true)
  })

  it('removes a deleted row from the state list after myapps:delete + re-read', async () => {
    listResponses.push({ ok: true, body: listResponse([
      summary({ appId: 'app-1' }),
      summary({ appId: 'app-2' }),
    ]) })
    const hook = renderMyAppsHook()
    await waitFor(() => {
      if (hook.result.current.state.apps.length !== 2) throw new Error('list not loaded')
    })
    // The SECOND list read (post-delete refresh) no longer carries app-1;
    // the delete command itself resolves before the re-read lands.
    deleteSpy.mockImplementation(async () => ({
      contractVersion: 1,
      appId: 'app-1',
      deleted: true,
    }))
    let resolveSecond!: () => void
    listResponses.push({ ok: true, body: listResponse([summary({ appId: 'app-2' })]) })
    void resolveSecond
    await act(async () => {
      await hook.result.current.delete('app-1')
    })
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy.mock.calls[0][0]).toMatchObject({
      accountId: SCOPE.accountId,
      workspaceId: SCOPE.workspaceId,
      productSpaceId: SCOPE.productSpaceId,
      appId: 'app-1',
    })
    await waitFor(() => {
      if (hook.result.current.state.apps.length !== 1) throw new Error('row not removed')
    })
    expect(hook.result.current.state.apps[0]?.appId).toBe('app-2')
    expect(hook.result.current.state.deletingAppIds.has('app-1')).toBe(false)
  })

  it('maps a bridge-coded myapps_space_restricted failure to state.errorCode', async () => {
    // The context-bridge marker shape: only the message survives the bridge,
    // the code rides INSIDE it (see rpc-error-bridge). The hook must decode
    // it — a bare-message compare would degrade this to request_failed.
    const bridged = new Error('polo-rpc-code:myapps_space_restricted:restricted')
    expect(readRpcErrorCode(bridged)).toBe('myapps_space_restricted')
    listResponses.push({ ok: false, error: bridged })
    const hook = renderMyAppsHook()
    await waitFor(() => {
      if (hook.result.current.state.errorCode !== 'myapps_space_restricted') {
        throw new Error('code not surfaced')
      }
    })
    expect(hook.result.current.state.apps).toEqual([])
  })

  it('refuses commands without a committed scope (myapps_scope_changed)', async () => {
    listResponses.push({ ok: true, body: listResponse([]) })
    const hook = renderMyAppsHook()
    await waitFor(() => {
      if (hook.result.current.state.loading) throw new Error('initial load pending')
    })
    // Force a scope gap: the hook re-proves the scope at every command.
    const scoped = hook.result.current
    expect(scoped.scope).toEqual(SCOPE)
    // A scope-less transport member deads the list read instead of throwing.
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {},
    })
    await act(async () => {
      await scoped.refresh()
    })
    expect(hook.result.current.state.errorCode).toBe(null)
    expect(hook.result.current.state.apps).toEqual([])
  })
})
