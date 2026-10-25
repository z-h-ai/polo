import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type FC } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { KbDocumentSummary } from '@polo-ai/shared/protocol'

/**
 * POO-143 S3/S5 upload guards over the rebuilt KnowledgeBaseApp: selection-time
 * type/size verdicts, the aggregated rejection summary (append vs clear),
 * byte-limit editing in the split preview, the result-unknown VERIFY path
 * (never an automatic retry) and the sync-failure banner that keeps stale data.
 */

GlobalRegistrator.register()
setupI18n()

type ToastEntry = { type: 'success' | 'error'; message: string }
const toastCalls: ToastEntry[] = []
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
mock.module('@/context/AppShellContext', () => ({
  useAppShellContext: () => ({ activeWorkspaceId: 'ws-kb-guard' }),
}))
// bun has no Vite asset pipeline: the theme registry's import.meta.glob must
// be stubbed out (same seam as the TabShell interaction suites).
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

const { cleanup, fireEvent, render, screen, waitFor, act } = await import('@testing-library/react')
const { KnowledgeBaseApp } = await import('../KnowledgeBaseApp')
type KbAppProps = { pollIntervalMs?: number }

const KB_MAX = 2 * 1024 * 1024

function doc(partial: Partial<KbDocumentSummary> & { id: string; collectionId: string }): KbDocumentSummary {
  return {
    title: `Doc ${partial.id}`,
    status: 'draft',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    publishedAt: null,
    rejectReason: null,
    ...partial,
  }
}

interface Harness {
  docs: KbDocumentSummary[]
  uploads: Array<{ title: string; content: string }>
  uploadScript: Array<Error> // popped per upload call
  listCollectionsFailuresLeft: number
}

function makeHarness(): Harness {
  const harness: Harness = {
    docs: [doc({ id: 'doc-seed', collectionId: 'col-1', status: 'published', title: 'Seed' })],
    uploads: [],
    uploadScript: [],
    listCollectionsFailuresLeft: 0,
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      kbListCollections: async () => {
        if (harness.listCollectionsFailuresLeft > 0) {
          harness.listCollectionsFailuresLeft -= 1
          throw Object.assign(new Error('down'), { code: 'kb_service_unavailable' })
        }
        return {
          canManage: true,
          collections: [{
            id: 'col-1', name: 'Guarded', description: '', createdAt: '', updatedAt: '',
            documentCounts: { draft: 0, in_review: 0, published: harness.docs.length, rejected: 0 },
            canManage: true,
          }],
        }
      },
      kbListDocuments: async (input: { collectionId: string }) =>
        harness.docs.filter(row => row.collectionId === input.collectionId).map(row => ({ ...row })),
      kbGetDocument: async (input: { docId: string }) => {
        const row = harness.docs.find(candidate => candidate.id === input.docId)
        return row ? { ...row, content: 'seed content' } : null
      },
      kbCreateCollection: async () => { throw new Error('not exercised') },
      kbUploadDocument: async (input: { title: string; content: string }) => {
        harness.uploads.push({ title: input.title, content: input.content })
        const scripted = harness.uploadScript.shift()
        if (scripted) throw scripted
        return doc({ id: `doc-up-${harness.uploads.length}`, collectionId: 'col-1', title: input.title })
      },
      kbSubmitForReview: async () => { throw new Error('not exercised') },
      kbPublishDocument: async () => { throw new Error('not exercised') },
      kbRejectDocument: async () => { throw new Error('not exercised') },
      kbRevertToDraft: async () => { throw new Error('not exercised') },
      kbDeleteDocument: async () => { throw new Error('not exercised') },
    },
  })
  return harness
}

function makeFileList(...files: File[]): FileList {
  return Object.assign([...files], { item: function item(this: File[], index: number) { return this[index] } }) as unknown as FileList
}

async function openUploadDialog(pollIntervalMs?: number): Promise<Harness> {
  const harness = makeHarness()
  const props: KbAppProps = pollIntervalMs === undefined ? {} : { pollIntervalMs }
  render(createElement(
    I18nextProvider,
    { i18n },
    createElement(KnowledgeBaseApp as FC<KbAppProps>, props),
  ))
  await screen.findByTestId('kb-collection-list')
  fireEvent.click(screen.getByTestId('kb-upload-document'))
  await screen.findByTestId('kb-upload-dialog')
  return harness
}

async function ingest(input: HTMLInputElement, files: FileList) {
  await act(async () => {
    fireEvent.change(input, { target: { files } })
  })
}

beforeEach(async () => {
  toastCalls.length = 0
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

describe('KnowledgeBaseApp upload guards (POO-143 S3/S5)', () => {
  it('G1: bad type and oversize are refused at selection while the valid file enqueues', async () => {
    await openUploadDialog()
    const input = screen.getByTestId('kb-file-input') as HTMLInputElement
    const oversize = new File(['x'], 'huge.md')
    Object.defineProperty(oversize, 'size', { value: KB_MAX + 1 })
    // ONE mixed batch: a bad type, an oversize file and a valid file.
    await ingest(input, makeFileList(new File(['x'], 'poster.pdf'), oversize, new File(['# ok'], 'good.md')))

    // The aggregate summary names the failures and the live queue count.
    const summary = screen.getByTestId('kb-pick-summary-text')
    expect(summary.textContent).toContain('Added 1,')
    expect(summary.textContent).toContain('not added.')

    fireEvent.click(screen.getByTestId('kb-pick-summary-toggle'))
    const detail = screen.getByTestId('kb-pick-summary-list')
    expect(detail.textContent).toContain('poster.pdf')
    expect(detail.textContent).toContain('huge.md')
    expect(detail.textContent).toContain('Only .md / .markdown / .txt')
    expect(detail.textContent).toContain('Exceeds the 2 MB per-file limit.')

    const rows = screen.getAllByTestId(/^kb-queue-row-/)
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('good')
  })

  it('G2: an all-rejected batch APPENDS to the summary; a batch that adds clears it', async () => {
    await openUploadDialog()
    const input = screen.getByTestId('kb-file-input') as HTMLInputElement

    await ingest(input, makeFileList(new File(['x'], 'a.pdf')))
    expect(screen.getByTestId('kb-pick-summary-text').textContent).toContain('not added.')

    await ingest(input, makeFileList(new File(['x'], 'b.pdf')))
    const detail = (() => {
      fireEvent.click(screen.getByTestId('kb-pick-summary-toggle'))
      return screen.getByTestId('kb-pick-summary-list').textContent ?? ''
    })()
    expect(detail).toContain('a.pdf')
    expect(detail).toContain('b.pdf')

    // A batch with an accepted file clears the stale list (Spec S3.1).
    await ingest(input, makeFileList(new File(['# ok'], 'real.md')))
    expect(screen.queryByTestId('kb-pick-summary')).toBeNull()
    expect(screen.getAllByTestId(/^kb-queue-row-/)).toHaveLength(1)
  })

  it('G3: dropzone drop feeds the SAME ingest path as the picker', async () => {
    await openUploadDialog()
    const dropzone = screen.getByTestId('kb-dropzone')
    await act(async () => {
      fireEvent.drop(dropzone, { dataTransfer: { files: makeFileList(new File(['# dropped'], 'dropped.md')) } })
    })
    expect(screen.getAllByTestId(/^kb-queue-row-/)).toHaveLength(1)
  })

  it('G4: editing the queued text past the byte cap disables upload and names the row', async () => {
    await openUploadDialog()
    const input = screen.getByTestId('kb-file-input') as HTMLInputElement
    await ingest(input, makeFileList(new File(['# ok'], 'editable.md')))
    expect(screen.getByTestId('kb-document-upload-confirm').hasAttribute('disabled')).toBe(false)

    const over = 'x'.repeat(KB_MAX + 10)
    fireEvent.change(screen.getByTestId('kb-document-content-input'), { target: { value: over } })

    expect(screen.getByTestId('kb-up-byte-error')).toBeTruthy()
    expect(screen.getByTestId('kb-document-upload-confirm').hasAttribute('disabled')).toBe(true)

    // Recovering under the cap re-enables the batch.
    fireEvent.change(screen.getByTestId('kb-document-content-input'), { target: { value: '# small again' } })
    await waitFor(() => expect(screen.getByTestId('kb-document-upload-confirm').hasAttribute('disabled')).toBe(false))
  })

  it('G5: closing the dialog without confirming KEEPS the queue; reopening shows it', async () => {
    await openUploadDialog()
    const input = screen.getByTestId('kb-file-input') as HTMLInputElement
    await ingest(input, makeFileList(new File(['# kept'], 'kept.md')))

    fireEvent.click(screen.getByTestId('kb-upload-dialog').querySelector('[data-testid="kb-upload-cancel"]') ??
      screen.getAllByText('Cancel')[0]!)

    // Reopen: the queue row is still there.
    fireEvent.click(screen.getByTestId('kb-upload-document'))
    await screen.findByTestId('kb-upload-dialog')
    const rows = screen.getAllByTestId(/^kb-queue-row-/)
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('kept')
  })

  it('G6: a result-unknown upload offers VERIFY, finds the landed document, and never auto-retries', async () => {
    const harness = await openUploadDialog()
    const input = screen.getByTestId('kb-file-input') as HTMLInputElement
    await ingest(input, makeFileList(new File(['# maybe'], 'maybe.md')))
    // The upload RPC answers `kb_result_unknown` — the write MAY have landed.
    harness.uploadScript.push(Object.assign(new Error('write lost'), { code: 'kb_result_unknown' }))
    fireEvent.click(screen.getByTestId('kb-document-upload-confirm'))

    const pending = await screen.findByTestId(/kb-doc-pending-/)
    await waitFor(() => expect(pending.getAttribute('data-stage')).toBe('unknown'))

    // The row offers VERIFY — no automatic retry fired (uploads list length 1).
    expect(harness.uploads).toHaveLength(1)
    fireEvent.click(screen.getByTestId(/kb-upload-verify-/))

    // The verify listing finds the title → the row is replaced by the document.
    const landed = new File(['# maybe'], 'maybe.md')
    void landed
    harness.docs.push(doc({ id: 'doc-landed', collectionId: 'col-1', title: 'maybe', updatedAt: new Date().toISOString() }))
    // The verify call above listed BEFORE the push; trigger a second verify.
    fireEvent.click(screen.getByTestId(/kb-upload-verify-/))

    await screen.findByTestId('kb-document-doc-landed')
    await waitFor(() => expect(screen.queryByTestId(/kb-doc-pending-/)).toBeNull())
    // Still exactly one upload RPC — verify never re-uploads (Spec S5.1).
    expect(harness.uploads).toHaveLength(1)
  })

  it('G7: a verify that finds nothing surfaces the miss and hands back an inline retry', async () => {
    const harness = await openUploadDialog()
    const input = screen.getByTestId('kb-file-input') as HTMLInputElement
    await ingest(input, makeFileList(new File(['# gone'], 'gone.md')))
    harness.uploadScript.push(Object.assign(new Error('write lost'), { code: 'kb_result_unknown' }))
    fireEvent.click(screen.getByTestId('kb-document-upload-confirm'))
    const pending = await screen.findByTestId(/kb-doc-pending-/)
    await waitFor(() => expect(pending.getAttribute('data-stage')).toBe('unknown'))

    fireEvent.click(screen.getByTestId(/kb-upload-verify-/))
    const missed = await screen.findByTestId(/kb-upload-verify-missed-/)
    expect(missed.textContent).toContain('not found')

    // The miss re-enables an explicit retry — a second upload RPC, user-driven.
    const retry = screen.getByTestId(/kb-upload-retry-/)
    fireEvent.click(retry)
    await waitFor(() => expect(pending.getAttribute('data-stage')).toBe('submitted'))
    expect(harness.uploads).toHaveLength(2)
  })

  it('G8: repeated silent-sync failures raise the banner while stale rows remain', async () => {
    const harness = makeHarness()
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(KnowledgeBaseApp as FC<KbAppProps>, { pollIntervalMs: 15 }),
    ))
    // First load succeeds; THEN the sync starts failing.
    await screen.findByTestId('kb-collection-list')
    expect(screen.getByTestId('kb-document-doc-seed')).toBeTruthy()
    harness.listCollectionsFailuresLeft = 999

    const banner = await screen.findByTestId('kb-sync-banner', {}, { timeout: 3000 })
    expect(banner.textContent).toContain('Sync failed')
    // The stale data stays on the face (Spec S5.2).
    expect(screen.getByTestId('kb-document-doc-seed')).toBeTruthy()

    // Recovery clears the banner.
    harness.listCollectionsFailuresLeft = 0
    await waitFor(() => expect(screen.queryByTestId('kb-sync-banner')).toBeNull(), { timeout: 3000 })
  })
})
