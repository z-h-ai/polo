import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { PcAssetDto, PcTag } from '@polo-ai/shared/protocol'

/**
 * POO-196 ProjectFileLibrary interaction (isolated happy-dom render, same
 * pattern as KnowledgeBaseApp.upload-guard.isolated.ts):
 * capability gating of the upload entry, the tag-filter chip wiring, the
 * debounced search reaching the wire, the trash view's restore semantics and
 * the three required faces (loading / empty / list).
 */

GlobalRegistrator.register()
setupI18n()

type ToastEntry = { type: 'success' | 'error'; message: string }
const toastCalls: ToastEntry[] = []
import { mock } from 'bun:test'
mock.module('sonner', () => {
  const push = (type: 'success' | 'error') => (message: string) => {
    toastCalls.push({ type, message })
    return message
  }
  const toast = Object.assign((message: string) => {
    toastCalls.push({ type: 'success', message })
    return message
  }, { success: push('success'), error: push('error') })
  return { toast, Toaster: () => null }
})
// The theme hook needs the singleton provider; the library only reads isDark.
mock.module('@/hooks/useTheme', () => ({
  useTheme: () => ({ isDark: false }),
}))
mock.module('@/lib/client-workbench-style', () => ({
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))
// FilePreviewPane (pulled in for the HTML preview overlay) goes through the
// @polo-ai/ui barrel whose react-pdf import needs Vite's ?url pipeline — bun
// has no such pipeline, so the barrel is replaced with inert stand-ins here.
mock.module('@polo-ai/ui', () => ({
  CodeBlock: () => null,
  FullscreenOverlayBaseHeader: () => null,
  CodePreviewOverlay: () => null,
  ImagePreviewOverlay: () => null,
  JSONPreviewOverlay: () => null,
  PDFPreviewOverlay: () => null,
  Markdown: () => null,
}))

const { cleanup, fireEvent, render, screen, waitFor, act } = await import('@testing-library/react')
const { createElement } = await import('react')
const { ProjectFileLibrary } = await import('../ProjectFileLibrary')

const SCOPE = { workspaceId: 'ws-pc', productSpaceId: 'ps-1' }

function tag(id: string, preset = true): PcTag {
  return { id, label: id, preset }
}

function asset(partial: Partial<PcAssetDto> & { id: string }): PcAssetDto {
  return {
    name: `File ${partial.id}`,
    tags: [],
    uploaderUserId: 'user-a',
    uploaderDisplayName: 'Alice',
    source: { kind: 'file', note: null },
    status: 'active',
    currentVersion: 1,
    revision: 1,
    pinned: false,
    pinnedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    trashedAt: null,
    trashExpiresAt: null,
    deletedById: null,
    current: {
      version: 1,
      sizeBytes: 1024,
      mime: 'text/markdown',
      checksumSha256: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      createdById: 'user-a',
      processing: 'indexed',
      confirmedAt: null,
      confirmedByUserId: null,
    },
    ...partial,
  }
}

interface Harness {
  capabilities: Record<string, unknown> | null
  activeAssets: PcAssetDto[]
  trashAssets: PcAssetDto[]
  listCalls: Array<Record<string, unknown>>
  restoreCalls: Array<Record<string, unknown>>
  trashFailuresLeft: number
}

function makeHarness(overrides: Partial<Harness> = {}): Harness {
  const harness: Harness = {
    capabilities: { featureEnabled: true, role: 'member', canManage: false, canShare: false, library: { status: 'ready' }, limits: { maxUploadBytes: 100 * 1024 * 1024, downloadUrlTtlSeconds: 60 } },
    activeAssets: [asset({ id: 'a-1' }), asset({ id: 'a-2', tags: [tag('source')], current: { version: 2, sizeBytes: 10, mime: 'text/html', checksumSha256: null, createdAt: '', createdById: 'u', processing: 'failed', confirmedAt: null, confirmedByUserId: null } as PcAssetDto['current'] })],
    trashAssets: [asset({ id: 't-1', status: 'trashed', trashedAt: '2026-01-03T00:00:00.000Z', trashExpiresAt: '2026-02-02T00:00:00.000Z', revision: 3 })],
    listCalls: [],
    restoreCalls: [],
    trashFailuresLeft: 0,
    ...overrides,
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pcListCapabilities: async () => harness.capabilities,
      pcListAssets: async (input: Record<string, unknown>) => {
        harness.listCalls.push(input)
        if (input.view === 'trash') {
          if (harness.trashFailuresLeft > 0) {
            harness.trashFailuresLeft -= 1
            throw Object.assign(new Error('down'), { code: 'pc_service_unavailable' })
          }
          return { assets: harness.trashAssets.map((row) => ({ ...row })), canManage: false }
        }
        return { assets: harness.activeAssets.map((row) => ({ ...row })), canManage: false }
      },
      pcRestoreAsset: async (input: Record<string, unknown>) => {
        harness.restoreCalls.push(input)
        const row = harness.trashAssets.find((candidate) => candidate.id === input.assetId)!
        return { asset: { ...row, status: 'active' } }
      },
    },
  })
  return harness
}

function renderLibrary(harness: Harness) {
  return render(createElement(
    I18nextProvider,
    { i18n },
    createElement(ProjectFileLibrary as unknown as (props: Record<string, unknown>) => React.ReactElement, {
      scope: SCOPE,
      currentUserId: 'user-a',
    }),
  ))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(async () => {
  toastCalls.length = 0
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

describe('ProjectFileLibrary interaction (POO-196)', () => {
  it('renders the list face with capability gating: no canShare means no upload entry', async () => {
    const harness = makeHarness()
    renderLibrary(harness)

    // The list face renders both rows with their provenance line.
    await screen.findByTestId('pc-asset-row-a-1')
    expect(screen.getByTestId('pc-asset-row-a-2')).toBeTruthy()
    // canShare=false in capabilities → the upload entry stays hidden.
    expect(screen.queryByTestId('pc-upload-button')).toBeNull()
    // The trash entry is always available.
    expect(screen.getByTestId('pc-trash-button')).toBeTruthy()
    // Every pc call names the workspace scope.
    expect(harness.listCalls[0]).toMatchObject({ workspaceId: 'ws-pc', productSpaceId: 'ps-1' })
  })

  it('shows the empty face with an upload guide when the project has no files and canShare is on', async () => {
    const harness = makeHarness({
      activeAssets: [],
      capabilities: { featureEnabled: true, role: 'member', canManage: false, canShare: true, library: { status: 'ready' }, limits: { maxUploadBytes: 100, downloadUrlTtlSeconds: 60 } },
    })
    renderLibrary(harness)

    expect(await screen.findByTestId('pc-empty')).toBeTruthy()
    // canShare=true → the guide offers the upload entry.
    expect(screen.getByTestId('pc-empty-upload')).toBeTruthy()
  })

  it('the tag filter chip re-queries with tag=source; the confirmed chip uses the controlled id', async () => {
    const harness = makeHarness()
    renderLibrary(harness)
    await screen.findByTestId('pc-asset-row-a-1')
    const baseCalls = harness.listCalls.length

    fireEvent.click(screen.getByTestId('pc-tag-filter-source'))
    await waitFor(() => expect(harness.listCalls.length).toBe(baseCalls + 1))
    expect(harness.listCalls.at(-1)).toMatchObject({ tag: 'source' })

    // The 「已确认结论」 filter rides tag=confirmed — the controlled state id.
    fireEvent.click(screen.getByTestId('pc-tag-filter-confirmed'))
    await waitFor(() => expect(harness.listCalls.length).toBe(baseCalls + 2))
    expect(harness.listCalls.at(-1)).toMatchObject({ tag: 'confirmed' })

    // Clicking the active chip again clears the filter.
    fireEvent.click(screen.getByTestId('pc-tag-filter-confirmed'))
    await waitFor(() => expect(harness.listCalls.length).toBe(baseCalls + 3))
    expect(harness.listCalls.at(-1)?.tag).toBeUndefined()
  })

  it('search is debounced onto the wire (300ms) and status filtering keeps failed rows only', async () => {
    const harness = makeHarness()
    renderLibrary(harness)
    await screen.findByTestId('pc-asset-row-a-1')
    const baseCalls = harness.listCalls.length

    const search = screen.getByTestId('pc-search') as HTMLInputElement
    fireEvent.change(search, { target: { value: 'spec' } })
    // Inside the debounce window: nothing fired yet.
    await act(async () => { await sleep(80) })
    expect(harness.listCalls.length).toBe(baseCalls)

    await act(async () => { await sleep(350) })
    expect(harness.listCalls.length).toBe(baseCalls + 1)
    expect(harness.listCalls.at(-1)).toMatchObject({ q: 'spec' })

    // 失败 filter: the failed row survives, the indexed row is filtered away client-side.
    fireEvent.click(screen.getByTestId('pc-status-filter-failed'))
    await screen.findByTestId('pc-asset-row-a-2')
    expect(screen.queryByTestId('pc-asset-row-a-1')).toBeNull()
  })

  it('the trash view lists trashed files with retention copy and restores via the wire CAS input', async () => {
    const harness = makeHarness()
    renderLibrary(harness)
    await screen.findByTestId('pc-asset-row-a-1')

    fireEvent.click(screen.getByTestId('pc-trash-button'))
    const row = await screen.findByTestId('pc-asset-row-t-1')
    expect(row.getAttribute('data-testid')).toBe('pc-asset-row-t-1')

    fireEvent.click(screen.getByTestId('pc-asset-restore-t-1'))
    await waitFor(() => expect(harness.restoreCalls).toHaveLength(1))
    expect(harness.restoreCalls[0]).toMatchObject({
      workspaceId: 'ws-pc',
      productSpaceId: 'ps-1',
      assetId: 't-1',
      input: { expectedRevision: 3 },
    })
    // Restored rows leave the trash list.
    await waitFor(() => expect(screen.queryByTestId('pc-asset-row-t-1')).toBeNull())
    // And the user hears about it.
    expect(toastCalls.some((entry) => entry.type === 'success')).toBe(true)
  })

  it('a failing trash load surfaces the mapped pc_* copy instead of a blank pane', async () => {
    const harness = makeHarness({ trashFailuresLeft: 1 })
    renderLibrary(harness)
    await screen.findByTestId('pc-asset-row-a-1')

    fireEvent.click(screen.getByTestId('pc-trash-button'))
    const error = await screen.findByTestId('pc-trash-error')
    expect(error.textContent).toContain('unreachable')
  })

  it('a disabled capability replaces the pane with neutral guidance and never fires a list call', async () => {
    const harness = makeHarness({
      capabilities: { featureEnabled: false, disabledReason: 'storage_unavailable', role: 'member', canManage: false, canShare: false, library: { status: 'none' }, limits: { maxUploadBytes: 100, downloadUrlTtlSeconds: 60 } },
    })
    renderLibrary(harness)

    const notice = await screen.findByTestId('pc-capability-notice')
    expect(notice.getAttribute('data-state')).toBe('storage_unavailable')
    expect(screen.getByTestId('pc-capability-title').textContent).toContain('storage')
    expect(screen.queryByTestId('pc-asset-row-a-1')).toBeNull()
    expect(screen.queryByTestId('pc-upload-button')).toBeNull()
    // S-08+E-3: a disabled feature must not issue a doomed list call.
    expect(harness.listCalls).toHaveLength(0)
  })

  it('the available status filter rides the wire as processing=available and keeps usable rows only', async () => {
    const harness = makeHarness({
      activeAssets: [
        asset({ id: 'a-indexed' }),
        asset({ id: 'a-unsupported', current: { version: 1, sizeBytes: 10, mime: 'application/x-unknown', checksumSha256: null, createdAt: '', createdById: 'u', processing: 'unsupported', confirmedAt: null, confirmedByUserId: null } as PcAssetDto['current'] }),
        asset({ id: 'a-failed', current: { version: 1, sizeBytes: 10, mime: 'text/html', checksumSha256: null, createdAt: '', createdById: 'u', processing: 'failed', confirmedAt: null, confirmedByUserId: null } as PcAssetDto['current'] }),
      ],
    })
    renderLibrary(harness)
    await screen.findByTestId('pc-asset-row-a-indexed')

    fireEvent.click(screen.getByTestId('pc-status-filter-available'))
    await waitFor(() => {
      expect(harness.listCalls.at(-1)).toMatchObject({ processing: 'available' })
    })
    // Unsupported content is still usable (S-09): it stays under 可用.
    await screen.findByTestId('pc-asset-row-a-unsupported')
    expect(screen.queryByTestId('pc-asset-row-a-failed')).toBeNull()
  })

  it('custom member tags from the loaded rows join the chip row and filter by their id', async () => {
    const harness = makeHarness({
      activeAssets: [asset({ id: 'a-1', tags: [{ id: 'risk-register', label: 'Risk register', preset: false }] })],
    })
    renderLibrary(harness)
    await screen.findByTestId('pc-asset-row-a-1')

    const chip = screen.getByTestId('pc-tag-filter-risk-register')
    // The chip caption is the member's own label, never an i18n guess.
    expect(chip.textContent).toBe('Risk register')
    fireEvent.click(chip)
    await waitFor(() => expect(harness.listCalls.at(-1)).toMatchObject({ tag: 'risk-register' }))
  })
})
