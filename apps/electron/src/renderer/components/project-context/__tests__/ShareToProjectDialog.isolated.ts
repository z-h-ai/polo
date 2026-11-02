import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { PcAssetDto } from '@polo-ai/shared/protocol'
import type { StoredAttachment } from '../../../../shared/types'
import type { ShareToProjectTarget } from '../ShareToProjectDialog'

/**
 * POO-196 S-01 ShareToProjectDialog (isolated happy-dom render, same pattern
 * as AssetUploadDialog.isolated.ts): the message-derived item list (attachments
 * ride their storedPath, the text artifact is materialized through
 * storeAttachment because the upload RPC takes a PATH), the per-item editable
 * name, the auto-filled source note, and the per-item failure that names the
 * item while keeping the earlier publishes intact.
 */

GlobalRegistrator.register()
setupI18n()

mock.module('sonner', () => ({
  toast: Object.assign((message: string) => message, {
    success: (message: string) => message,
    error: (message: string) => message,
  }),
  Toaster: () => null,
}))
mock.module('@/lib/client-workbench-style', () => ({
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { createElement } = await import('react')
const { ShareToProjectDialog } = await import('../ShareToProjectDialog')

const MAX_BYTES = 100 * 1024 * 1024
const SCOPE = { workspaceId: 'ws-apollo', productSpaceId: 'ps-1' }

interface UploadCall {
  filePath: string
  name: string
  mode: string
  tags: string[]
  source: { kind: string; note?: string }
  checksumSha256: string
}

interface Harness {
  storedTexts: Array<{ name: string; text: string }>
  storedPaths: string[]
  fileBodies: Record<string, Uint8Array>
  uploads: UploadCall[]
  uploadFailures: Error[]
  failNames: string[]
  assets: PcAssetDto[]
}

const utf8 = (text: string) => new TextEncoder().encode(text)

function makeTarget(): ShareToProjectTarget {
  const attachment: StoredAttachment = {
    id: 'att-1',
    name: 'spec.md',
    mimeType: 'text/markdown',
    size: 5,
    storedPath: '/session/att/spec.md',
    path: '/session/att/spec.md',
    type: 'file',
  } as unknown as StoredAttachment
  return {
    text: '验收要点清单正文',
    attachments: [attachment],
    sessionTitle: 'Apollo kickoff',
  }
}

function makeAsset(name: string): PcAssetDto {
  return {
    id: `as-${name}`,
    name,
    revision: 1,
    tags: [],
    source: { kind: 'session' },
    workspaceId: SCOPE.workspaceId,
    productSpaceId: SCOPE.productSpaceId,
    createdById: 'u-1',
    currentVersionId: 1,
    pinnedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    trashedAt: null,
    trashExpiresAt: null,
    deletedById: null,
    current: {
      version: 1,
      sizeBytes: 5,
      mime: 'text/markdown',
      checksumSha256: 'a'.repeat(64),
      createdAt: '2026-11-01T00:00:00Z',
      createdById: 'u-1',
      processing: 'indexed',
      confirmedAt: null,
      confirmedByUserId: null,
    },
  } as unknown as PcAssetDto
}

function renderShare(options: { failNames?: string[] } = {}) {
  const harness: Harness = {
    storedTexts: [],
    storedPaths: [],
    fileBodies: {
      '/session/att/spec.md': utf8('# spec'),
    },
    uploads: [],
    uploadFailures: [],
    failNames: options.failNames ?? [],
    assets: [],
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pcListCapabilities: async () => ({ limits: { maxUploadBytes: MAX_BYTES } }),
      storeAttachment: async (_sessionId: string, input: { name: string; text: string }) => {
        harness.storedTexts.push({ name: input.name, text: input.text })
        const storedPath = `/session/stored/${harness.storedTexts.length}.md`
        harness.storedPaths.push(storedPath)
        harness.fileBodies[storedPath] = utf8(input.text)
        return { id: `stored-${harness.storedTexts.length}`, storedPath, name: input.name }
      },
      readFileBinary: async (path: string) => {
        const bytes = harness.fileBodies[path]
        if (!bytes) throw new Error('not found')
        return bytes
      },
      pcUploadFile: async (input: Record<string, unknown>) => {
        // Failures are keyed by asset NAME, so an earlier publish can succeed
        // before the named item fails.
        if (harness.failNames.includes(String(input.name))) throw new Error('disk full')
        const asset = makeAsset(String(input.name))
        harness.assets.push(asset)
        harness.uploads.push({
          filePath: String(input.filePath),
          name: String(input.name),
          mode: String(input.mode),
          tags: input.tags as string[],
          source: input.source as UploadCall['source'],
          checksumSha256: String(input.checksumSha256),
        })
        return { published: true, asset }
      },
    },
  })
  const shared: PcAssetDto[][] = []
  render(createElement(
    I18nextProvider,
    { i18n },
    createElement(ShareToProjectDialog as unknown as (props: Record<string, unknown>) => React.ReactElement, {
      open: true,
      scope: SCOPE,
      sessionId: 'sess-1',
      target: makeTarget(),
      onClose: () => {},
      onShared: (assets: PcAssetDto[]) => shared.push(assets),
    }),
  ))
  return { harness, shared }
}

beforeEach(async () => {
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

describe('ShareToProjectDialog (POO-196 S-01)', () => {
  it('derives one item per attachment + the text artifact, prefills the source note, and publishes both', async () => {
    const { harness, shared } = renderShare()

    // Both candidates show up preselected; the text artifact carries its
    // markdown name and the message's byte length.
    expect(await screen.findByTestId('pc-share-item-att:att-1')).toBeTruthy()
    expect(screen.getByTestId('pc-share-item-text:message')).toBeTruthy()
    const sourceInput = screen.getByTestId('pc-share-source') as HTMLInputElement
    expect(sourceInput.value).toBe('From chat: Apollo kickoff')

    // Rename the text artifact and add a preset tag: both apply to every item.
    fireEvent.change(screen.getByTestId('pc-share-item-name-text:message'), {
      target: { value: '验收要点.md' },
    })
    fireEvent.click(screen.getByTestId('pc-share-preset-tag-source'))

    fireEvent.click(screen.getByTestId('pc-share-submit'))
    await waitFor(() => expect(shared).toHaveLength(1))

    // The text artifact was materialized through the session attachment store
    // (the only sanctioned renderer write) and uploaded from that path.
    expect(harness.storedTexts).toHaveLength(1)
    expect(harness.storedTexts[0]!.text).toBe('验收要点清单正文')
    expect(harness.uploads).toHaveLength(2)

    const attachmentUpload = harness.uploads.find((call) => call.name === 'spec.md')!
    expect(attachmentUpload.filePath).toBe('/session/att/spec.md')
    const textUpload = harness.uploads.find((call) => call.name === '验收要点.md')!
    expect(textUpload.filePath).toBe(harness.storedPaths[0])
    for (const call of harness.uploads) {
      expect(call.mode).toBe('create')
      expect(call.tags).toEqual(['source'])
      expect(call.source).toEqual({ kind: 'session', note: 'From chat: Apollo kickoff' })
      expect(call.checksumSha256).toMatch(/^[0-9a-f]{64}$/)
    }
    expect(shared[0]!.map((asset) => asset.name).sort()).toEqual(['spec.md', '验收要点.md'])
  })

  it('a failing item names itself, keeps the earlier publishes, and never reports success', async () => {
    // The text artifact keeps its default name here; the failure is keyed to it.
    const { harness, shared } = renderShare({ failNames: ['Message text.md'] })

    await screen.findByTestId('pc-share-item-att:att-1')
    fireEvent.click(screen.getByTestId('pc-share-submit'))

    // First item published, second failed: the batch stops, the error names
    // the failing item, and the parent success callback is never invoked.
    const error = await screen.findByTestId('pc-share-error')
    expect(error.textContent).toContain('Message text.md')
    expect(error.textContent).toContain('Something went wrong')
    expect(harness.uploads).toHaveLength(1)
    expect(shared).toHaveLength(0)
  })
})
