import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
  mock,
} from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { CatalogApp } from '@polo-ai/shared/admin'
import type { LocalAppRuntimeStatus } from '@polo-ai/shared/protocol'
import type { AppCatalogInstance } from '../../../hooks/useAppCatalog'
import type { ProductSpaceAppLaunchHandoff } from '../../../context/ProductSpaceContext'
import type { ResolveLaunchResponse } from '@polo-ai/shared/product-spaces'
import type { MemberAppBundleLaunch } from '../../../hooks/useMemberAppActions'

GlobalRegistrator.register()
setupI18n()

const toastErrorSpy = jest.fn()
const toastSuccessSpy = jest.fn()

mock.module('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorSpy(...args),
    success: (...args: unknown[]) => toastSuccessSpy(...args),
  },
}))

const { cleanup, fireEvent, render, screen, waitFor, act } = await import(
  '@testing-library/react'
)
const { MemberAppCard } = await import('../MemberAppCard')
const { useMemberAppActions, isMemberAppBundleLaunch } = await import(
  '../../../hooks/useMemberAppActions'
)

const accountId = 'account-a'
const spaceId = 'organization-a'

function makeApp(overrides: Partial<CatalogApp> = {}): CatalogApp {
  return {
    id: 'app-a',
    organizationId: spaceId,
    name: 'Growth Playbook',
    description: 'Find growth methods.',
    deliveryMode: 'remote_url',
    remoteUrl: 'https://a.example.com',
    sortOrder: 0,
    availability: 'available',
    sourceNames: ['晨星增长圈'],
    ...overrides,
  }
}

function resolvedLaunch(app: CatalogApp): ResolveLaunchResponse {
  // The production response carries opaque branded ids; the fixture keeps
  // plain strings and crosses the brand boundary explicitly.
  return {
    contractVersion: 1,
    productSpaceId: app.organizationId,
    catalogEntryId: app.catalogEntryId ?? app.id,
    resolvedAt: '2099-01-01T00:00:00.000Z',
    expiresAt: '2099-01-01T00:10:00.000Z',
    subject: {
      kind: 'artifact_instance',
      artifactType: 'app',
      artifactInstanceId: app.artifactInstanceId ?? `artifact-${app.id}`,
      versionId: app.catalogVersion?.versionId ?? 'version-1',
      version: app.catalogVersion?.version ?? '1.0.0',
    },
    payer: { kind: 'personal' as const, accountId },
    delivery: {
      kind: 'web_url',
      url: 'https://fresh.example.com',
      launchToken: 'launch-token-value',
    },
  } as unknown as ResolveLaunchResponse
}

function resolvedBundleLaunch(app: CatalogApp, version = '2.0.0'): MemberAppBundleLaunch {
  return {
    ...resolvedLaunch(app),
    subject: {
      kind: 'artifact_instance',
      artifactType: 'app',
      artifactInstanceId: app.artifactInstanceId ?? `artifact-${app.id}`,
      versionId: 'version-bundle',
      version,
    },
    delivery: {
      kind: 'bundle',
      downloadUrl: 'https://fresh.example.com/app.zip',
      expiresAt: '2099-01-01T00:10:00.000Z',
      checksum: 'a'.repeat(64),
      sizeBytes: 1_024,
    },
  } as unknown as MemberAppBundleLaunch
}

function fakeCatalog(overrides: Record<string, unknown> = {}): AppCatalogInstance {
  return {
    state: {
      catalog: { accountId, organizationId: spaceId, apps: [], withdrawnApps: [] },
      loading: false,
      refreshing: false,
      warningCode: null,
      errorCode: null,
      accessMode: 'online',
      statuses: {},
      installStates: {},
    },
    uiIdentityKeyForApp: (app: CatalogApp) => `ui:${app.id}`,
    resolveLaunch: jest.fn(async (app: CatalogApp) => resolvedLaunch(app)),
    getInstallState: () => undefined,
    installProductSpaceBundle: jest.fn(async () => {}),
    ...overrides,
  } as unknown as AppCatalogInstance
}

function fakeHandoff() {
  return {
    publish: jest.fn(
      (_publisherAccountId: string, _launch: ResolveLaunchResponse) => ({
        handoffId: 'handoff-1',
      }),
    ),
    take: () => null,
    onLaunch: () => () => {},
  }
}

type FakeHandoff = ReturnType<typeof fakeHandoff>

/** Exposes the hook API through a ref for direct interaction assertions. */
function renderActions(catalog: AppCatalogInstance, handoff: FakeHandoff) {
  let api: ReturnType<typeof useMemberAppActions> | null = null
  function Harness() {
    api = useMemberAppActions({
      catalog,
      context: {
        spaceKind: 'personal',
        launchHandoff: handoff as unknown as ProductSpaceAppLaunchHandoff,
      },
    })
    return null
  }
  const view = render(
    createElement(I18nextProvider, { i18n }, createElement(Harness)),
  )
  if (!api) throw new Error('hook did not initialize')
  return { view, api: () => api! }
}

function cardTree(app: CatalogApp, props: Record<string, unknown> = {}) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(MemberAppCard, {
      app,
      variant: 'home',
      onOpen: () => {},
      ...props,
    }),
  )
}

beforeEach(async () => {
  toastErrorSpy.mockClear()
  toastSuccessSpy.mockClear()
  await i18n.changeLanguage('en')
})

afterEach(() => {
  cleanup()
})

describe('MemberAppCard (P70-CARD-01 shared card)', () => {
  it('renders the shared icon, name, creator line, description and open button', () => {
    render(cardTree(makeApp({
      catalogSources: [{ kind: 'creator_circle', circleId: 'circle-1', name: '晨星增长工作室' }],
    })))
    expect(screen.getByText('Growth Playbook')).toBeTruthy()
    expect(screen.getByText('Certified creator · 晨星增长工作室')).toBeTruthy()
    expect(screen.getByText('Find growth methods.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open' })).toBeTruthy()
  })

  it('falls back to the first letter artwork when no icon exists and shows source names', () => {
    render(cardTree(makeApp({ iconUrl: undefined })))
    expect(screen.getByText('G')).toBeTruthy()
    expect(screen.getByText('晨星增长圈')).toBeTruthy()
  })

  it('delegates every open interaction to onOpen with the card App', () => {
    const onOpen = jest.fn()
    const app = makeApp()
    render(cardTree(app, { onOpen }))
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledTimes(1)
    expect(onOpen).toHaveBeenLastCalledWith(app)
    // Clicking the card body opens too (repeated open attempts stay wired).
    fireEvent.click(screen.getByTestId('member-app-card'))
    expect(onOpen).toHaveBeenCalledTimes(2)
    expect(onOpen).toHaveBeenLastCalledWith(app)
  })

  it('keeps data-identity-key and custom test ids for consumer contracts', () => {
    render(cardTree(makeApp(), { identityKey: 'ui:app-a', testId: 'home-quick-entry' }))
    const card = screen.getByTestId('home-quick-entry')
    expect(card.getAttribute('data-identity-key')).toBe('ui:app-a')
    expect(card.getAttribute('data-variant')).toBe('home')
  })

  it('home variant: no resident status badge; the running badge only while actually running', () => {
    const view = render(cardTree(makeApp(), { runtimeStatus: null }))
    expect(screen.queryByText('Running')).toBeNull()
    view.unmount()
    const stopped = { status: 'stopped' } as unknown as LocalAppRuntimeStatus
    render(cardTree(makeApp(), { runtimeStatus: stopped }))
    expect(screen.queryByText('Running')).toBeNull()
    view.unmount()
    render(cardTree(makeApp(), {
      runtimeStatus: { status: 'running' } as unknown as LocalAppRuntimeStatus,
    }))
    expect(screen.getByText('Running')).toBeTruthy()
  })

  it('detail variant keeps the source identification and never shows runtime badges', () => {
    render(cardTree(makeApp(), {
      variant: 'detail',
      runtimeStatus: { status: 'running' } as unknown as LocalAppRuntimeStatus,
    }))
    expect(screen.getByText('晨星增长圈')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
    expect(screen.getByTestId('member-app-card').getAttribute('data-variant')).toBe('detail')
  })
})

describe('isMemberAppBundleLaunch', () => {
  it('discriminates bundle deliveries from web deliveries', () => {
    const app = makeApp()
    expect(isMemberAppBundleLaunch(resolvedLaunch(app))).toBe(false)
    expect(isMemberAppBundleLaunch(resolvedBundleLaunch(app))).toBe(true)
  })
})

describe('useMemberAppActions (P70-CARD-02/03 extracted actions, injected catalog)', () => {
  it('opens through the injected catalog resolve-launch grant and publishes the fixed launch', async () => {
    const app = makeApp()
    const catalog = fakeCatalog()
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    expect(catalog.resolveLaunch).toHaveBeenCalledWith(app)
    expect(handoff.publish).toHaveBeenCalledTimes(1)
    expect(handoff.publish).toHaveBeenCalledWith(accountId, resolvedLaunch(app))
    expect(api().prepareTarget).toBeNull()
  })

  it('repeated opens re-resolve authority every time (no cached grant)', async () => {
    const app = makeApp()
    const catalog = fakeCatalog()
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    await act(async () => { await api().open(app) })
    expect(catalog.resolveLaunch).toHaveBeenCalledTimes(2)
    expect(handoff.publish).toHaveBeenCalledTimes(2)
  })

  it('refuses to start a non-available App and never touches resolve-launch', async () => {
    const app = makeApp({ availability: 'withdrawn' })
    const catalog = fakeCatalog()
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    expect(catalog.resolveLaunch).not.toHaveBeenCalled()
    expect(handoff.publish).not.toHaveBeenCalled()
    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('a refused authorization keeps the object: error toast, no publish, no prepare', async () => {
    const app = makeApp()
    const resolveLaunch = jest.fn(async () => {
      const failure = new Error('denied') as Error & { code: string }
      failure.code = 'NOT_AUTHORIZED'
      throw failure
    })
    const catalog = fakeCatalog({ resolveLaunch })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    expect(resolveLaunch).toHaveBeenCalledWith(app)
    expect(handoff.publish).not.toHaveBeenCalled()
    expect(api().prepareTarget).toBeNull()
    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
    expect(toastErrorSpy.mock.calls[0]?.[0]).toBe('Could not open Growth Playbook')
  })

  it('routes an uninstalled resolved bundle into prepare and publishes nothing yet', async () => {
    const app = makeApp({ deliveryMode: 'resolve_launch' })
    const launch = resolvedBundleLaunch(app)
    const catalog = fakeCatalog({
      resolveLaunch: jest.fn(async () => launch),
    })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    expect(handoff.publish).not.toHaveBeenCalled()
    expect(api().prepareTarget?.app).toBe(app)
    expect(api().prepareTarget?.launch).toBe(launch)
    expect(toastErrorSpy).not.toHaveBeenCalled()
  })

  it('publishes directly when the fixed bundle version is already installed', async () => {
    const app = makeApp({ deliveryMode: 'resolve_launch' })
    const launch = resolvedBundleLaunch(app, '3.1.0')
    const catalog = fakeCatalog({
      resolveLaunch: jest.fn(async () => launch),
      getInstallState: () => ({ state: 'installed', currentVersion: '3.1.0' }),
    })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    expect(handoff.publish).toHaveBeenCalledWith(accountId, launch)
    expect(api().prepareTarget).toBeNull()
  })

  it('tracks one in-flight operation state per identity key and clears it after', async () => {
    const app = makeApp()
    let releaseResolve!: () => void
    const gate = new Promise<void>(resolve => { releaseResolve = resolve })
    const catalog = fakeCatalog({
      resolveLaunch: jest.fn(async () => {
        await gate
        return resolvedLaunch(app)
      }),
    })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    let inner: Promise<void> = Promise.resolve()
    await act(async () => {
      inner = api().open(app)
    })
    // The open is still awaiting the gated resolveLaunch: the marker is up.
    expect(api().operationStates['ui:app-a']).toEqual({
      identityKey: 'ui:app-a',
      operation: 'open',
    })
    await act(async () => {
      releaseResolve()
      await inner
    })
    expect(api().operationStates['ui:app-a']).toBeUndefined()
  })

  it('confirmPrepare installs and re-publishes the freshly re-resolved fixed version', async () => {
    const app = makeApp({ deliveryMode: 'resolve_launch' })
    const launch = resolvedBundleLaunch(app, '3.0.0')
    const catalog = fakeCatalog({
      resolveLaunch: jest.fn(async () => launch),
      installProductSpaceBundle: jest.fn(async () => {}),
    })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    expect(api().prepareTarget).not.toBeNull()
    await act(async () => { await api().confirmPrepare() })
    expect(catalog.installProductSpaceBundle).toHaveBeenCalledWith(app)
    // Fixed version: the SAME authoritative launch is published after install.
    expect(catalog.resolveLaunch).toHaveBeenCalledTimes(2)
    expect(handoff.publish).toHaveBeenCalledWith(accountId, launch)
    expect(api().prepareTarget).toBeNull()
    expect(toastSuccessSpy).toHaveBeenCalledWith('Growth Playbook is ready to open')
    expect(toastErrorSpy).not.toHaveBeenCalled()
  })

  it('a cancelled permission stays silent: no error toast, no launch', async () => {
    const app = makeApp({ deliveryMode: 'resolve_launch' })
    const launch = resolvedBundleLaunch(app)
    const catalog = fakeCatalog({
      resolveLaunch: jest.fn(async () => launch),
      installProductSpaceBundle: jest.fn(async () => {
        const failure = new Error('cancelled') as Error & { code: string }
        failure.code = 'INSTALL_CANCELLED'
        throw failure
      }),
    })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    await act(async () => { await api().confirmPrepare() })
    expect(toastSuccessSpy).not.toHaveBeenCalled()
    expect(toastErrorSpy).not.toHaveBeenCalled()
    expect(handoff.publish).not.toHaveBeenCalled()
    expect(api().prepareTarget).toBeNull()
  })

  it('a failed prepare surfaces the install error and never launches', async () => {
    const app = makeApp({ deliveryMode: 'resolve_launch' })
    const launch = resolvedBundleLaunch(app)
    const catalog = fakeCatalog({
      resolveLaunch: jest.fn(async () => launch),
      installProductSpaceBundle: jest.fn(async () => {
        const failure = new Error('download failed') as Error & { code: string }
        failure.code = 'DOWNLOAD_FAILED'
        throw failure
      }),
    })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    await act(async () => { await api().confirmPrepare() })
    expect(toastErrorSpy).toHaveBeenCalledTimes(1)
    expect(toastErrorSpy.mock.calls[0]?.[0]).toBe('Could not install Growth Playbook')
    expect(handoff.publish).not.toHaveBeenCalled()
  })

  it('cancelPrepare dismisses the prepare target without installing anything', async () => {
    const app = makeApp({ deliveryMode: 'resolve_launch' })
    const catalog = fakeCatalog({
      resolveLaunch: jest.fn(async () => resolvedBundleLaunch(app)),
    })
    const handoff = fakeHandoff()
    const { api } = renderActions(catalog, handoff)
    await act(async () => { await api().open(app) })
    expect(api().prepareTarget).not.toBeNull()
    act(() => { api().cancelPrepare() })
    expect(api().prepareTarget).toBeNull()
    expect(catalog.installProductSpaceBundle).not.toHaveBeenCalled()
    expect(handoff.publish).not.toHaveBeenCalled()
  })
})
