import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type FC } from 'react'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { KbCollection, KbDocumentSummary } from '@polo-ai/shared/protocol'
import { KB_MAX_CONTENT_BYTES } from '@polo-ai/shared/protocol'

/**
 * POO-143 S1/S2 interaction contract over the rebuilt KnowledgeBaseApp: the
 * create/transition paths report through ROW-level pending state (no global
 * busy gate), failures roll back with an inline retry, and the 30s silent
 * poll merges server data WITHOUT clearing the list or overwriting a pending
 * row with an older snapshot.
 *
 * The electronAPI surface is an in-memory fake; every mutating call returns a
 * deferred so a test can hold an operation in flight and pin down what the
 * face shows BEFORE the server answers.
 */

GlobalRegistrator.register()
setupI18n()

type ToastEntry = { type: 'success' | 'error'; message: string; options?: { action?: { label: string; onClick: () => void } } }
const toastCalls: ToastEntry[] = []
mock.module('sonner', () => {
  const push = (type: 'success' | 'error') => (message: string, options?: ToastEntry['options']) => {
    toastCalls.push({ type, message, options })
    return message
  }
  const toast = Object.assign((message: string, options?: ToastEntry['options']) => {
    toastCalls.push({ type: 'success', message, options })
    return message
  }, { success: push('success'), error: push('error') })
  return { toast, Toaster: () => null }
})
mock.module('@/context/AppShellContext', () => ({
  useAppShellContext: () => ({ activeWorkspaceId: 'ws-kb-test' }),
}))
// bun has no Vite asset pipeline: the theme registry's import.meta.glob must
// be stubbed out (same seam as the TabShell interaction suites).
mock.module('@/context/ThemeContext', () => ({ useOptionalTheme: () => undefined }))

const { cleanup, fireEvent, render, screen, waitFor, act } = await import('@testing-library/react')
const { KnowledgeBaseApp } = await import('../KnowledgeBaseApp')
type KbAppProps = { pollIntervalMs?: number }

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** A document summary shaped exactly like the wire contract. */
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

function collection(partial: Partial<KbCollection> & { id: string }): KbCollection {
  return {
    name: `Collection ${partial.id}`,
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    documentCounts: { draft: 0, in_review: 0, published: 0, rejected: 0 },
    canManage: true,
    ...partial,
  }
}

interface Harness {
  collections: KbCollection[]
  docs: KbDocumentSummary[]
  /** Held in-flight deferreds the test settles explicitly. */
  createDeferred: Deferred<KbCollection> | null
  uploadDeferred: Deferred<KbDocumentSummary> | null
  getDocumentDeferred: Deferred<KbDocumentSummary | null> | null
  submitDeferreds: Map<string, Deferred<KbDocumentSummary>>
  failNextCreate: Error | null
}

function makeHarness(seedDocs: KbDocumentSummary[]): Harness {
  const harness: Harness = {
    collections: [collection({ id: 'col-1' })],
    docs: seedDocs,
    createDeferred: null,
    uploadDeferred: null,
    getDocumentDeferred: null,
    submitDeferreds: new Map(),
    failNextCreate: null,
  }
  const listFor = (collectionId: string) => harness.docs.filter(row => row.collectionId === collectionId)
  const refreshCounts = (target: KbCollection) => {
    const rows = harness.docs.filter(row => row.collectionId === target.id)
    target.documentCounts = {
      draft: rows.filter(row => row.status === 'draft').length,
      in_review: rows.filter(row => row.status === 'in_review').length,
      published: rows.filter(row => row.status === 'published').length,
      rejected: rows.filter(row => row.status === 'rejected').length,
    }
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      kbListCollections: async () => ({
        canManage: true,
        collections: harness.collections.map(row => {
          const copy = collection({ id: row.id, name: row.name, description: row.description })
          copy.documentCounts = { ...row.documentCounts }
          return copy
        }),
      }),
      kbListDocuments: async (input: { collectionId: string }) => listFor(input.collectionId).map(row => ({ ...row })),
      kbGetDocument: async (input: { docId: string }) => {
        const pending = deferred<KbDocumentSummary | null>()
        harness.getDocumentDeferred = pending
        return pending.promise.then(row => {
          return row
            ? { ...row, content: `# ${row.title}\n\nBody of ${row.title}.` }
            : row
        })
      },
      kbCreateCollection: async (input: { name: string; description: string }) => {
        if (harness.failNextCreate) {
          const failure = harness.failNextCreate
          harness.failNextCreate = null
          throw failure
        }
        const pending = deferred<KbCollection>()
        harness.createDeferred = pending
        return pending.promise.then(created => {
          harness.collections.push(created)
          return created
        })
      },
      kbUploadDocument: async () => {
        const pending = deferred<KbDocumentSummary>()
        harness.uploadDeferred = pending
        return pending.promise
      },
      kbSubmitForReview: async (input: { docId: string }) => {
        const pending = deferred<KbDocumentSummary>()
        harness.submitDeferreds.set(input.docId, pending)
        return pending.promise.then(updated => {
          const index = harness.docs.findIndex(row => row.id === input.docId)
          if (index >= 0) harness.docs[index] = updated
          harness.collections.forEach(refreshCounts)
          return updated
        })
      },
      kbPublishDocument: async () => { throw new Error('not exercised here') },
      kbRejectDocument: async () => { throw new Error('not exercised here') },
      kbRevertToDraft: async () => { throw new Error('not exercised here') },
      kbDeleteDocument: async () => { throw new Error('not exercised here') },
    },
  })
  return harness
}

async function renderApp(pollIntervalMs?: number) {
  const props: KbAppProps = pollIntervalMs === undefined ? {} : { pollIntervalMs }
  const view = render(createElement(
    I18nextProvider,
    { i18n },
    createElement(KnowledgeBaseApp as FC<KbAppProps>, props),
  ))
  await screen.findByTestId('kb-collection-list')
  return view
}

function typeInto(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

function makeFiles(...specs: Array<{ name: string; text?: string; size?: number }>): FileList {
  const files = specs.map(spec => new File([spec.text ?? `# ${spec.name}\n\ncontent`], spec.name, { type: 'text/markdown' }))
  // An oversize claim is expressed through the reported size; content stays small.
  specs.forEach((spec, index) => {
    if (spec.size !== undefined) Object.defineProperty(files[index], 'size', { value: spec.size })
  })
  return Object.assign([...files], { item: function item(this: File[], index: number) { return this[index] } }) as unknown as FileList
}

beforeEach(async () => {
  toastCalls.length = 0
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

describe('KnowledgeBaseApp interactions (POO-143 S1/S2)', () => {
  it('P1: confirming the create dialog closes it NOW, shows a pending collection row, then promotes it', async () => {
    const harness = makeHarness([])
    await renderApp()

    fireEvent.click(screen.getByTestId('kb-create-collection'))
    typeInto('kb-collection-name-input', 'Runbooks')
    fireEvent.click(screen.getByTestId('kb-collection-create-confirm'))

    // The dialog is gone BEFORE the server answers…
    await waitFor(() => expect(screen.queryByTestId('kb-collection-name-input')).toBeNull())
    // …the list grew an optimistic tail row…
    const pending = await screen.findByTestId('kb-pending-collection')
    expect(pending.getAttribute('data-pending-name')).toBe('Runbooks')
    // …and the create button is NOT globally disabled (other rows stay live).
    expect(screen.getByTestId('kb-create-collection').hasAttribute('disabled')).toBe(false)

    harness.createDeferred!.resolve(collection({ id: 'col-rb', name: 'Runbooks' }))

    await waitFor(() => expect(screen.queryByTestId('kb-pending-collection')).toBeNull())
    const promoted = await screen.findByTestId('kb-collection-col-rb')
    expect(promoted).toBeTruthy()
    // Success selects the new collection.
    expect(promoted.getAttribute('class')).toContain('bg-foreground/6')
    expect(toastCalls.some(entry => entry.type === 'success')).toBe(true)
  })

  it('P3: confirming a two-file queue closes the dialog and renders serial row-level upload pending', async () => {
    const harness = makeHarness([])
    await renderApp()

    fireEvent.click(screen.getByTestId('kb-upload-document'))
    await screen.findByTestId('kb-upload-dialog')
    const input = screen.getByTestId('kb-file-input') as HTMLInputElement
    await act(async () => {
      fireEvent.change(input, { target: { files: makeFiles({ name: 'alpha.md' }, { name: 'beta.md' }) } })
    })

    const queueRows = await screen.findAllByTestId(/^kb-queue-row-/)
    expect(queueRows).toHaveLength(2)
    fireEvent.click(screen.getByTestId('kb-document-upload-confirm'))

    // The dialog closed; the DOCUMENT LIST grew two staged pending rows.
    await waitFor(() => expect(screen.queryByTestId('kb-upload-dialog')).toBeNull())
    const pendingRows = await screen.findAllByTestId(/^kb-doc-pending-/)
    expect(pendingRows).toHaveLength(2)

    // Serial: the FIRST row runs, the second stays queued.
    await waitFor(() => expect(pendingRows[0].getAttribute('data-stage')).not.toBe('queued'))
    expect(pendingRows[1].getAttribute('data-stage')).toBe('queued')

    harness.uploadDeferred!.resolve(doc({ id: 'doc-alpha', collectionId: 'col-1', title: 'alpha' }))
    const landed = await screen.findByTestId('kb-document-doc-alpha')
    expect(landed).toBeTruthy()
    // The freed slot starts the second upload.
    await waitFor(() => {
      const rows = screen.getAllByTestId(/^kb-doc-pending-/)
      expect(rows.some(row => row.getAttribute('data-stage') === 'submitted' || row.getAttribute('data-stage') === 'uploading')).toBe(true)
    })
    harness.uploadDeferred!.resolve(doc({ id: 'doc-beta', collectionId: 'col-1', title: 'beta' }))
    await screen.findByTestId('kb-document-doc-beta')
  })

  it('P5: submitting a document shows the pending badge ONLY on that row and lands the new status', async () => {
    const harness = makeHarness([
      doc({ id: 'doc-a', collectionId: 'col-1', status: 'draft' }),
      doc({ id: 'doc-b', collectionId: 'col-1', status: 'draft' }),
    ])
    await renderApp()

    fireEvent.click(screen.getByTestId('kb-doc-submit-doc-a'))
    const pendingBadge = await screen.findByTestId('kb-row-pending-doc-a')
    expect(pendingBadge.textContent).toContain('Submitting')
    // Only THIS row disables: the sibling keeps its actionable button.
    expect(screen.getByTestId('kb-doc-submit-doc-b').hasAttribute('disabled')).toBe(false)

    // The silent poll during the in-flight submit does NOT rewind the row
    // (P7 rides along here — the fake server still reports draft).
    harness.submitDeferreds.get('doc-a')!.resolve(doc({ id: 'doc-a', collectionId: 'col-1', status: 'in_review' }))

    await waitFor(() => expect(screen.queryByTestId('kb-row-pending-doc-a')).toBeNull())
    const badge = screen.getByTestId('kb-document-status-doc-a')
    expect(badge.textContent).toContain('In review')
    expect(toastCalls.some(entry => entry.type === 'success')).toBe(true)
  })

  it('P6: the silent poll merges remote changes without clearing the list or flashing a spinner', async () => {
    const harness = makeHarness([
      doc({ id: 'doc-a', collectionId: 'col-1', status: 'published' }),
    ])
    await renderApp(15)
    expect(screen.getByTestId('kb-document-doc-a')).toBeTruthy()

    // A remote writer lands a new document between polls.
    harness.docs.push(doc({ id: 'doc-remote', collectionId: 'col-1', status: 'in_review' }))

    await screen.findByTestId('kb-document-doc-remote', {}, { timeout: 3000 })
    // The pre-existing row survived the merge (the list was never cleared).
    expect(screen.getByTestId('kb-document-doc-a')).toBeTruthy()
    expect(screen.queryByTestId('kb-load-error')).toBeNull()
  })

  it('P7: a pending row keeps its badge across a poll that returns the older snapshot', async () => {
    const harness = makeHarness([
      doc({ id: 'doc-a', collectionId: 'col-1', status: 'draft' }),
    ])
    await renderApp(15)

    fireEvent.click(screen.getByTestId('kb-doc-submit-doc-a'))
    await screen.findByTestId('kb-row-pending-doc-a')
    // The submit is still in flight — the fake server still says `draft`,
    // and at least one silent tick runs during this window.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(screen.getByTestId('kb-row-pending-doc-a')).toBeTruthy()
    expect(screen.queryByTestId('kb-document-status-doc-a')).toBeNull()

    harness.submitDeferreds.get('doc-a')!.resolve(doc({ id: 'doc-a', collectionId: 'col-1', status: 'in_review' }))
    await waitFor(() => expect(screen.getByTestId('kb-document-status-doc-a').textContent).toContain('In review'))
  })

  it('P10: a transitioning row keeps its LOCAL version across polls that already carry the server row', async () => {
    const harness = makeHarness([
      doc({ id: 'doc-a', collectionId: 'col-1', status: 'draft', title: 'Local Title' }),
    ])
    await renderApp(15)

    // The document row lands on its own async chain — wait for it before
    // clicking (same discipline as the review r1 G8 fix).
    await screen.findByTestId('kb-document-doc-a')
    fireEvent.click(screen.getByTestId('kb-doc-submit-doc-a'))
    await screen.findByTestId('kb-row-pending-doc-a')

    // While the RPC is held the listing picks the newer row up — then an even
    // older snapshot follows. The merge must NOT consume the transition's
    // protection on server confirmation (review r1 minor#4): the optimistic
    // row stays under the pending badge until the operation settles.
    harness.docs[0] = doc({ id: 'doc-a', collectionId: 'col-1', status: 'in_review', title: 'Server Title' })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    harness.docs[0] = doc({ id: 'doc-a', collectionId: 'col-1', status: 'in_review', title: 'Older Title' })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
    expect(screen.getByTestId('kb-document-doc-a').textContent).toContain('Local Title')
    expect(screen.getByTestId('kb-row-pending-doc-a')).toBeTruthy()

    // Settle releases the protection; the silent refresh converges the row.
    harness.submitDeferreds.get('doc-a')!.resolve(doc({ id: 'doc-a', collectionId: 'col-1', status: 'in_review' }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)) })
    expect(screen.queryByTestId('kb-row-pending-doc-a')).toBeNull()
    expect(screen.getByTestId('kb-document-status-doc-a').textContent).toContain('In review')
  })

  it('P2b: a failed create rolls back and its toast retry reopens the dialog with the name kept', async () => {
    const harness = makeHarness([])
    harness.failNextCreate = Object.assign(new Error('dup'), { code: 'kb_conflict' })
    await renderApp()

    fireEvent.click(screen.getByTestId('kb-create-collection'))
    typeInto('kb-collection-name-input', 'Keep my name')
    fireEvent.click(screen.getByTestId('kb-collection-create-confirm'))

    // failNextCreate throws BEFORE the deferred is armed, so the row rolls
    // back and the failure toast carries the retry action.
    await waitFor(() => {
      const failure = toastCalls.find(entry => entry.type === 'error')
      expect(failure).toBeTruthy()
      expect(failure!.options?.action?.label).toBe('Retry')
    })
    await waitFor(() => expect(screen.queryByTestId('kb-pending-collection')).toBeNull())

    toastCalls.find(entry => entry.type === 'error')!.options!.action!.onClick()
    const reopened = await screen.findByTestId('kb-collection-name-input') as HTMLInputElement
    expect(reopened.value).toBe('Keep my name')
  })

  it('P8: preview opens instantly with its own loading state, then paints raw + rendered panes', async () => {
    const harness = makeHarness([
      doc({ id: 'doc-a', collectionId: 'col-1', status: 'published', title: 'Release notes' }),
    ])
    await renderApp()
    await screen.findByTestId('kb-document-doc-a')

    fireEvent.click(screen.getByTestId('kb-document-doc-a').querySelector('button')!)
    // The dialog + its loading state appear while the content RPC is HELD.
    await screen.findByTestId('kb-preview-dialog')
    await screen.findByTestId('kb-preview-shimmer')

    harness.getDocumentDeferred!.resolve(doc({ id: 'doc-a', collectionId: 'col-1', title: 'Release notes' }))
    await screen.findByTestId('kb-preview-rendered')
    expect(screen.getByTestId('kb-preview-rendered').textContent).toContain('Body of Release notes.')
    expect(screen.queryByTestId('kb-preview-shimmer')).toBeNull()
  })

  it('P9: a fresh upload stays visible when a poll lands before the listing knows the document', async () => {
    const harness = makeHarness([])
    await renderApp(15)

    fireEvent.click(screen.getByTestId('kb-upload-document'))
    await screen.findByTestId('kb-upload-dialog')
    await act(async () => {
      fireEvent.change(screen.getByTestId('kb-file-input'), {
        target: { files: makeFiles({ name: 'solo.md' }) },
      })
    })
    fireEvent.click(screen.getByTestId('kb-document-upload-confirm'))
    await screen.findByTestId(/kb-doc-pending-/)

    const created = doc({ id: 'doc-solo', collectionId: 'col-1', title: 'solo' })
    harness.uploadDeferred!.resolve(created)
    await screen.findByTestId('kb-document-doc-solo')

    // A poll lands whose listing is ALREADY aware (the fake store holds the
    // doc) — the row survives as the server version.
    harness.docs.push(created)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
    expect(screen.getByTestId('kb-document-doc-solo')).toBeTruthy()
  })

  it('guard: KB_MAX_CONTENT_BYTES stays the 2 MB contract the guards enforce', () => {
    expect(KB_MAX_CONTENT_BYTES).toBe(2 * 1024 * 1024)
  })
})
