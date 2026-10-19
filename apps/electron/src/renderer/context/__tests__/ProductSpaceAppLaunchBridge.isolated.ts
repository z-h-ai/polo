import { beforeEach, afterEach, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import React, { createElement } from 'react'
import { Provider, createStore } from 'jotai'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import { ProductSpaceProvider, useProductSpaceAppLaunchHandoff, type ProductSpaceContextValue } from '../ProductSpaceContext'
import { MemberCatalogProvider } from '../MemberCatalogContext'
import { useMemberAppActions } from '@/hooks/useMemberAppActions'
import type { AppCatalogInstance } from '@/hooks/useAppCatalog'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import { openTabsAtom } from '@/atoms/tab-browser'
if (typeof window === 'undefined') GlobalRegistrator.register()
setupI18n()
mock.module('@/components/circles/ClientHomeRouter', () => ({ ClientHomeRouter: () => createElement('div', null, 'home') }))
mock.module('@/context/MemberCircleResourceContext', () => ({ MemberCircleResourceProvider: ({ children }: { children: React.ReactNode }) => children }))
const { TabShellProvider, useTabShell } = await import('../TabShellContext')
const { TabContent } = await import('@/components/tab-browser/TabContent')
const { render, cleanup, fireEvent, waitFor, act, within } = await import('@testing-library/react')
const space = { accountId: 'account-a', activeProductSpaceId: 'space-a', contextVersion: 1, productSpaceContextKey: 'scope-a', activeProductSpace: { id: 'space-a', kind: 'personal' } } as ProductSpaceContextValue
const app = { id: 'artifact-a', organizationId: 'space-a', name: 'Test App', availability: 'available', catalogEntryId: 'entry-a', artifactInstanceId: 'artifact-a', catalogVersion: { versionId: 'version-a', version: '1.0.0' }, catalogSources: [{ kind: 'creator_circle', name: 'Circle', circleId: 'circle-a' }], rawAvailability: 'available', description: null, deliveryMode: 'local_service', sortOrder: 0 } as unknown as CatalogApp
const launch = { contractVersion: 1, productSpaceId: 'space-a', catalogEntryId: 'entry-a', resolvedAt: '2099-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:10:00.000Z', subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'artifact-a', versionId: 'version-a', version: '1.0.0' }, payer: { kind: 'personal', accountId: 'account-a' }, delivery: { kind: 'bundle', downloadUrl: 'https://admin.example/never-persist-this-nonce', checksum: 'a'.repeat(64), sizeBytes: 123, runtime: 'js' } } as unknown as ResolveLaunchResponse
let installed = false
const start = mock(async (_request: unknown) => ({ appId: 'artifact-a', version: '1.0.0', executionId: 'execution-a', runtimeGeneration: 1, scopeGeneration: 1, runtimeKind: 'js', uiUrl: 'http://127.0.0.1:43210/', platformApi: { status: 'available' } }))
const stop = mock(async (_request: unknown) => ({ status: 'stopped' }))
const catalog = {
  state: { catalog: { accountId: 'account-a', organizationId: 'space-a', appConfigVersion: 'revision-a', apps: [app] }, accessMode: 'online' },
  productSpace: space, resolveLaunch: async () => launch,
  getInstallState: () => installed ? { state: 'installed', currentVersion: '1.0.0' } : { state: 'not_installed' },
  installProductSpaceBundle: async () => { installed = true },
} as unknown as AppCatalogInstance
function Probe() {
  const handoff = useProductSpaceAppLaunchHandoff()
  const actions = useMemberAppActions({ catalog, context: { spaceKind: 'personal', launchHandoff: handoff } })
  const shell = useTabShell()
  return createElement('div', null,
    createElement('button', { onClick: () => void actions.open(app) }, 'open fixture'),
    actions.prepareTarget && createElement('button', { onClick: () => void actions.confirmPrepare() }, 'install fixture'),
    createElement('button', { onClick: () => shell.closeTab(shell.activeTabId) }, 'close fixture'),
    createElement('div', { 'data-testid': 'active-url' }, shell.activeTab.url ?? ''),
    createElement(TabContent, { renderPolo: () => null }),
  )
}
const tree = (store: ReturnType<typeof createStore>, value: ProductSpaceContextValue) => createElement(I18nextProvider, { i18n }, createElement(Provider, { store }, createElement(ProductSpaceProvider, { value, children: null }, createElement(MemberCatalogProvider, { catalog, children: null }, createElement(TabShellProvider, { children: null, workspaceId: 'workspace-a', productSpaceScope: { accountId: value.accountId, productSpaceId: value.activeProductSpaceId } }, createElement(Probe))))))
const mount = (store = createStore(), value = space) => ({ store, ...render(tree(store, value)) })
/** Test fixtures only carry the fields the close decision reads (executionId); the full ExecutionSummary shape is irrelevant here. */
const setListExecutions = (impl: () => Promise<unknown>) => {
  window.electronAPI.productSpaceListActiveExecutions = impl as typeof window.electronAPI.productSpaceListActiveExecutions
}
beforeEach(() => { installed = false; start.mockReset(); start.mockImplementation(async () => ({ appId: 'artifact-a', version: '1.0.0', executionId: 'execution-a', runtimeGeneration: 1, scopeGeneration: 1, runtimeKind: 'js', uiUrl: 'http://127.0.0.1:43210/', platformApi: { status: 'available' } })); stop.mockReset(); stop.mockImplementation(async () => ({ status: 'stopped' })); window.localStorage.clear(); Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localApps: { start, stop }, productSpaceListActiveExecutions: async () => ({ success: true, executions: [{ executionId: 'execution-a', status: 'running' }] }) } }) })
afterEach(cleanup)
it('install confirmation consumes the real handoff and opens the exact runtime once', async () => {
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  fireEvent.click(await view.findByText('install fixture'))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  expect(start.mock.calls[0]![0]).toMatchObject({ kind: 'product_space_runtime_start', app: { accountId: 'account-a', productSpaceId: 'space-a', versionId: 'version-a', catalogRevision: 'revision-a' } })
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toBe('http://127.0.0.1:43210/'))
  fireEvent.click(view.getByText('open fixture'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  expect(start).toHaveBeenCalledTimes(1)
  expect(view.store.get(openTabsAtom).filter(tab => tab.appId === 'artifact-a')).toHaveLength(1)
})

it('does not persist runtime UI URLs or delivery credentials', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
  const persisted = Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.getItem(window.localStorage.key(i)!)).join('')
  expect(persisted).not.toContain('43210')
  expect(persisted).not.toContain('never-persist-this-nonce')
  expect(persisted).not.toContain('execution-a')
})

it('stale start completion after provider unmount stops only its exact generation and opens no tab', async () => {
  installed = true
  let release!: (value: Awaited<ReturnType<typeof start>>) => void
  start.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  view.unmount()
  await act(async () => { release({ appId: 'artifact-a', version: '1.0.0', executionId: 'old-execution', runtimeGeneration: 7, scopeGeneration: 1, runtimeKind: 'js', uiUrl: 'http://127.0.0.1:43210/', platformApi: { status: 'available' } }); await Promise.resolve() })
  await waitFor(() => expect(stop).toHaveBeenCalledWith({ kind: 'product_space_runtime_handle', executionId: 'old-execution', expectedRuntimeGeneration: 7 }))
  expect(view.store.get(openTabsAtom).some(tab => tab.url?.includes('43210'))).toBe(false)
})

it('an ended execution closes directly without the terminate dialog or a stop call', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  setListExecutions(async () => ({ success: true, executions: [] }))
  fireEvent.click(view.getByText('close fixture'))
  await waitFor(() => expect(view.store.get(openTabsAtom).some(tab => tab.appId === 'artifact-a')).toBe(false))
  expect(view.queryByRole('dialog')).toBeNull()
  expect(stop).not.toHaveBeenCalled()
})

it('an active execution asks with only Cancel and Stop-and-close, naming the App', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  fireEvent.click(view.getByText('close fixture'))
  const dialog = await view.findByRole('dialog')
  expect(within(dialog).getByText(i18n.t('homeApps.runtimeTab.closeTitle', { name: 'Test App' }))).not.toBeNull()
  const actions = within(dialog).getAllByRole('button')
  expect(actions.map(button => button.textContent)).toEqual([
    i18n.t('common.cancel'),
    i18n.t('homeApps.runtimeTab.stopAndClose'),
  ])
  expect(stop).not.toHaveBeenCalled()
})

it('a failed status check keeps the tab and retries until the state is confirmed', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  setListExecutions(async () => ({ success: false, errorCode: 'SERVER_ERROR' }))
  fireEvent.click(view.getByText('close fixture'))
  const dialog = await view.findByRole('dialog')
  expect(within(dialog).getByText(i18n.t('homeApps.runtimeTab.statusUnknown'))).not.toBeNull()
  expect(view.store.get(openTabsAtom).some(tab => tab.appId === 'artifact-a')).toBe(true)
  expect(stop).not.toHaveBeenCalled()
  setListExecutions(async () => ({ success: true, executions: [{ executionId: 'execution-a', status: 'running' }] }))
  fireEvent.click(within(dialog).getByRole('button', { name: i18n.t('homeApps.runtimeTab.retry') }))
  expect(await view.findByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') })).not.toBeNull()
})

it('a naturally ended execution closes after a failed exact stop instead of an error', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  let listCalls = 0
  setListExecutions(async () => {
    listCalls += 1
    return listCalls === 1
      ? { success: true, executions: [{ executionId: 'execution-a', status: 'running' }] }
      : { success: true, executions: [] }
  })
  stop.mockImplementationOnce(async () => { throw new Error('process already gone') })
  fireEvent.click(view.getByText('close fixture'))
  fireEvent.click(await view.findByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') }))
  await waitFor(() => expect(view.store.get(openTabsAtom).some(tab => tab.appId === 'artifact-a')).toBe(false))
  expect(view.queryByRole('alert')).toBeNull()
  expect(stop).toHaveBeenCalledTimes(1)
  expect(listCalls).toBe(2)
})

it('stop failure keeps the App and dialog; explicit retry closes only after exact STOP succeeds', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  stop.mockImplementationOnce(async () => { throw new Error('process still running') })
  fireEvent.click(view.getByText('close fixture'))
  fireEvent.click(await view.findByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(view.getByRole('alert').textContent).toBe(i18n.t('homeApps.runtimeTab.stopFailed'))
  expect(view.store.get(openTabsAtom).some(tab => tab.appId === 'artifact-a')).toBe(true)
  fireEvent.click(view.getByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') }))
  await waitFor(() => expect(view.store.get(openTabsAtom).some(tab => tab.appId === 'artifact-a')).toBe(false))
  expect(stop.mock.calls[1]![0]).toEqual({ kind: 'product_space_runtime_handle', executionId: 'execution-a', expectedRuntimeGeneration: 1 })
})

it('a close during an in-flight STOP neither stacks work nor re-enables the ask', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  stop.mockImplementationOnce(() => new Promise(() => {}))
  fireEvent.click(view.getByText('close fixture'))
  fireEvent.click(await view.findByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') }))
  expect(stop).toHaveBeenCalledTimes(1)
  // Cmd/Ctrl+W and the × button both land here: the in-flight STOP must keep
  // the dialog locked instead of resetting it for a second submission.
  fireEvent.click(view.getByText('close fixture'))
  expect(stop).toHaveBeenCalledTimes(1)
  // The submit button stays in its loading shape; both actions stay locked.
  expect(view.queryByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') })).toBeNull()
  expect((view.getByRole('button', { name: i18n.t('common.loading') }) as HTMLButtonElement).disabled).toBe(true)
  expect((view.getByRole('button', { name: i18n.t('common.cancel') }) as HTMLButtonElement).disabled).toBe(true)
})

it('an unverifiable recheck after a failed stop asks about the unknown state instead of a stop failure', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  let listCalls = 0
  setListExecutions(async () => {
    listCalls += 1
    if (listCalls === 1) return { success: true, executions: [{ executionId: 'execution-a', status: 'running' }] }
    return { success: false, errorCode: 'SERVER_ERROR' }
  })
  stop.mockImplementationOnce(async () => { throw new Error('stop request lost') })
  fireEvent.click(view.getByText('close fixture'))
  fireEvent.click(await view.findByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') }))
  expect(await view.findByText(i18n.t('homeApps.runtimeTab.statusUnknown'))).not.toBeNull()
  expect(view.queryByRole('alert')).toBeNull()
  expect(view.store.get(openTabsAtom).some(tab => tab.appId === 'artifact-a')).toBe(true)
  expect(view.getByRole('button', { name: i18n.t('homeApps.runtimeTab.retry') })).not.toBeNull()
})

it('A→B→A invalidates pending start and never exposes the old URL or title in the new generation', async () => {
  installed = true
  let release!: (value: Awaited<ReturnType<typeof start>>) => void
  start.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(1))
  view.rerender(tree(view.store, { ...space, activeProductSpaceId: 'space-b', contextVersion: 2, productSpaceContextKey: 'scope-b' }))
  view.rerender(tree(view.store, { ...space, contextVersion: 3 }))
  await act(async () => { release({ appId: 'artifact-a', version: '1.0.0', executionId: 'old-execution', runtimeGeneration: 7, scopeGeneration: 1, runtimeKind: 'js', uiUrl: 'http://127.0.0.1:43210/', platformApi: { status: 'available' } }); await Promise.resolve() })
  await waitFor(() => expect(stop).toHaveBeenCalledWith({ kind: 'product_space_runtime_handle', executionId: 'old-execution', expectedRuntimeGeneration: 7 }))
  expect(view.getByTestId('active-url').textContent).toBe('')
})

it('cancel close keeps the current App without a STOP call', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  fireEvent.click(view.getByText('close fixture'))
  fireEvent.click(await view.findByRole('button', { name: i18n.t('common.cancel') }))
  expect(stop).not.toHaveBeenCalled()
  expect(view.getByTestId('active-url').textContent).toContain('43210')
})

it('Escape during the activity check holds the ask open, matching the disabled Cancel', async () => {
  installed = true
  let resolveCheck: (value: unknown) => void = () => {}
  setListExecutions(() => new Promise(resolve => { resolveCheck = resolve }))
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  fireEvent.click(view.getByText('close fixture'))
  const dialog = await view.findByRole('dialog')
  expect((within(dialog).getByRole('button', { name: i18n.t('common.cancel') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(dialog, { key: 'Escape' })
  expect(view.getByRole('dialog')).not.toBeNull()
  expect(stop).not.toHaveBeenCalled()
  resolveCheck({ success: true, executions: [{ executionId: 'execution-a', status: 'running' }] })
  await waitFor(() => expect((within(view.getByRole('dialog')).getByRole('button', { name: i18n.t('common.cancel') }) as HTMLButtonElement).disabled).toBe(false))
})

it('local-account shell mounts without a ProductSpace provider or runtime consumer', async () => {
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { getTabBrowserApps: async () => [] } })
  function LocalProbe() { const shell = useTabShell(); return createElement('div', null, shell.isReady ? 'local ready' : 'loading') }
  const view = render(createElement(Provider, { store: createStore() }, createElement(TabShellProvider, { workspaceId: 'local', children: createElement(LocalProbe) })))
  await view.findByText('local ready')
  expect(start).not.toHaveBeenCalled()
})

it('late STOP after context transition cannot leave the next scope dialog stuck', async () => {
  installed = true
  let release!: (value: { status: string }) => void
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  stop.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
  fireEvent.click(view.getByText('close fixture'))
  fireEvent.click(await view.findByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') }))
  view.rerender(tree(view.store, { ...space, contextVersion: 2 }))
  expect(view.queryByRole('dialog')).toBeNull()
  await act(async () => { release({ status: 'stopped' }); await Promise.resolve() })
  expect(view.queryByRole('dialog')).toBeNull()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  fireEvent.click(view.getByText('close fixture'))
  expect((await view.findByRole('button', { name: i18n.t('homeApps.runtimeTab.stopAndClose') }) as HTMLButtonElement).disabled).toBe(false)
})

it('loading placeholder attaches real guest events when the runtime URL arrives', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.container.querySelector('webview')).not.toBeNull())
  const guest = view.container.querySelector('webview')!
  const event = new Event('page-title-updated'); Object.assign(event, { title: 'App-owned title' })
  fireEvent(guest, event)
  expect(view.store.get(openTabsAtom).find(tab => tab.appId === 'artifact-a')?.title).toBe('App-owned title')
})

it('explicit reopen starts a fresh runtime after the original execution stopped', async () => {
  installed = true
  const view = mount()
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(view.getByTestId('active-url').textContent).toContain('43210'))
  setListExecutions(async () => ({ success: true, executions: [] }))
  fireEvent.click(view.getByText('open fixture'))
  await waitFor(() => expect(start).toHaveBeenCalledTimes(2))
  expect(view.store.get(openTabsAtom).filter(tab => tab.appId === 'artifact-a')).toHaveLength(1)
})
