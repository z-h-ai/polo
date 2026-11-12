import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'
import type { AssetUploadInput } from '../AssetUploadDialog'

/**
 * POO-196 AssetUploadDialog (isolated happy-dom render, same pattern as
 * KnowledgeBaseApp.upload-guard.isolated.ts): pick → measure + integrity
 * digest → name/tags/source fields → the create-mode submit shape, the
 * oversized refusal, and the mapped wire-error retry path that keeps the
 * prepared file on screen.
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
mock.module('@/lib/client-workbench-style', () => ({
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))

const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const { createElement } = await import('react')
const { AssetUploadDialog } = await import('../AssetUploadDialog')

const MAX_BYTES = 100 * 1024 * 1024

interface Harness {
  dialogPaths: string[][]
  fileBodies: Record<string, Uint8Array>
  submissions: AssetUploadInput[]
  submitFailures: Error[]
}

function makeHarness(): Harness {
  const harness: Harness = {
    dialogPaths: [],
    fileBodies: {},
    submissions: [],
    submitFailures: [],
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      openFileDialog: async () => harness.dialogPaths.shift() ?? [],
      readFileBinary: async (path: string) => {
        const bytes = harness.fileBodies[path]
        if (!bytes) throw new Error('not found')
        return bytes
      },
      getFilePath: (file: File) => `/picked/${file.name}`,
    },
  })
  return harness
}

function renderDialog(onSubmit?: (input: AssetUploadInput) => Promise<void>) {
  const harness = makeHarness()
  const submissions = harness.submissions
  const submit = onSubmit ?? (async (input: AssetUploadInput) => {
    const failure = harness.submitFailures.shift()
    if (failure) throw failure
    submissions.push(input)
  })
  render(createElement(
    I18nextProvider,
    { i18n },
    createElement(AssetUploadDialog as unknown as (props: Record<string, unknown>) => React.ReactElement, {
      open: true,
      maxUploadBytes: MAX_BYTES,
      onClose: () => {},
      onSubmit: submit,
    }),
  ))
  return harness
}

const utf8 = (text: string) => new TextEncoder().encode(text)

beforeEach(async () => {
  toastCalls.length = 0
  await i18n.changeLanguage('en')
})
afterEach(cleanup)

describe('AssetUploadDialog (POO-196)', () => {
  it('pick → digest → submit: the create-mode RPC input carries name/tags/source/size/mime/digest', async () => {
    const harness = renderDialog()
    harness.dialogPaths.push(['/tmp/report.pdf'])
    harness.fileBodies['/tmp/report.pdf'] = utf8('hello')

    fireEvent.click(screen.getByTestId('pc-upload-pick'))

    // The summary shows the measured size and a FOLDED integrity digest —
    // the full 64-hex value appears only after the reveal toggle.
    const summary = await screen.findByTestId('pc-upload-file-summary')
    expect(summary).toBeTruthy()
    expect(screen.getByTestId('pc-upload-size').textContent).toContain('B')
    expect(screen.getByTestId('pc-upload-digest').textContent).not.toMatch(/^[0-9a-f]{64}$/)
    fireEvent.click(screen.getByTestId('pc-upload-digest-toggle'))
    expect(screen.getByTestId('pc-upload-digest').textContent).toMatch(/^[0-9a-f]{64}$/)
    // The name defaults to the picked file's basename.
    const name = screen.getByTestId('pc-upload-name') as HTMLInputElement
    expect(name.value).toBe('report.pdf')

    // Preset tag toggle + a custom tag via Enter.
    fireEvent.click(screen.getByTestId('pc-upload-preset-tag-source'))
    const tagInput = screen.getByTestId('pc-upload-tag-input') as HTMLInputElement
    fireEvent.change(tagInput, { target: { value: 'Roadmap 2026' } })
    fireEvent.keyDown(tagInput, { key: 'Enter' })
    // The source note rides along as kind:'file'.
    fireEvent.change(screen.getByTestId('pc-upload-source'), { target: { value: 'from design review' } })

    fireEvent.click(screen.getByTestId('pc-upload-submit'))
    await waitFor(() => expect(harness.submissions).toHaveLength(1))

    const input = harness.submissions[0]!
    expect(input.filePath).toBe('/tmp/report.pdf')
    expect(input.name).toBe('report.pdf')
    expect(input.tags).toEqual(['source', 'Roadmap 2026'])
    expect(input.source).toEqual({ kind: 'file', note: 'from design review' })
    expect(input.sizeBytes).toBe(5)
    expect(input.mime).toBe('application/pdf')
    expect(input.checksumSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('an oversized pick is refused locally with the too-large copy and no submission happens', async () => {
    const harness = renderDialog()
    harness.dialogPaths.push(['/tmp/huge.bin'])
    harness.fileBodies['/tmp/huge.bin'] = new Uint8Array(MAX_BYTES + 1)

    fireEvent.click(screen.getByTestId('pc-upload-pick'))
    const error = await screen.findByTestId('pc-upload-error')
    expect(error.textContent).toContain('too large')
    expect(screen.queryByTestId('pc-upload-file-summary')).toBeNull()

    // The submit stays disabled without a prepared file.
    expect((screen.getByTestId('pc-upload-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(harness.submissions).toHaveLength(0)
  })

  it('a wire failure maps its pc_* code, stays open with the form intact, and a retry succeeds', async () => {
    const harness = renderDialog()
    harness.dialogPaths.push(['/tmp/spec.md'])
    harness.fileBodies['/tmp/spec.md'] = utf8('# spec')
    harness.submitFailures.push(Object.assign(new Error('nope'), { code: 'pc_forbidden' }))

    fireEvent.click(screen.getByTestId('pc-upload-pick'))
    await screen.findByTestId('pc-upload-file-summary')
    fireEvent.click(screen.getByTestId('pc-upload-submit'))

    // The mapped user-facing copy appears; the prepared file is kept.
    const error = await screen.findByTestId('pc-upload-error')
    expect(error.textContent).toContain('permission')
    expect(screen.getByTestId('pc-upload-file-summary')).toBeTruthy()
    expect(harness.submissions).toHaveLength(0)

    // Retry without re-picking: the same digest goes out exactly once more.
    fireEvent.click(screen.getByTestId('pc-upload-submit'))
    await waitFor(() => expect(harness.submissions).toHaveLength(1))
    expect(harness.submissions[0]!.mime).toBe('text/markdown')
    expect(screen.queryByTestId('pc-upload-error')).toBeNull()
  })
})

/**
 * The drop entry (staged-feedback UX pass): one drop zone over the whole
 * dialog routing through the SAME decision tree as the pick buttons — one
 * plain file → the single form, one zip → unpack staging, one folder → the
 * folder scan, several files → the batch checklist. Folder detection rides
 * dataTransfer.items (webkitGetAsEntry) like the chat composer's drop.
 */
describe('AssetUploadDialog drag-and-drop', () => {
  interface DroppedSpec {
    name: string
    isDirectory?: boolean
    path: string
  }

  /** Module-level: getFilePath resolves a dropped File to the path its spec
   * named (webUtils.getPathForFile in the real preload). */
  let lastDropSpecs: DroppedSpec[] = []

  function makeDropDataTransfer(specs: DroppedSpec[]): Record<string, unknown> {
    lastDropSpecs = specs
    return {
      types: ['Files'],
      items: specs.map((spec) => ({
        kind: 'file',
        webkitGetAsEntry: () => ({ isDirectory: !!spec.isDirectory }),
        getAsFile: () => new File([new Uint8Array([1])], spec.name),
      })),
    }
  }

  function renderBatchDialog() {
    const harness = makeHarness()
    const folderScans: Array<Record<string, unknown>> = []
    const zipStages: Array<Record<string, unknown>> = []
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        openFileDialog: async () => [] as string[],
        readFileBinary: async (path: string) => {
          const bytes = harness.fileBodies[path]
          if (!bytes) throw new Error('not found')
          return bytes
        },
        getFilePath: (file: File) => {
          const spec = lastDropSpecs.find((candidate) => candidate.name === file.name)
          return spec?.path ?? `/picked/${file.name}`
        },
        pcScanFolder: async (input: Record<string, unknown>) => {
          folderScans.push(input)
          return { entries: [], truncated: false }
        },
        pcStageZipBatch: async (input: Record<string, unknown>) => {
          zipStages.push(input)
          return {
            batchId: 'b'.repeat(32),
            entries: [
              { entryId: 'z-1', sourcePath: 'a.md', displayName: 'a.md', sizeBytes: 5, included: true, reason: null, stagedPath: '/staged/a.md' },
            ],
            truncated: false,
          }
        },
        pcStageCleanup: async () => ({ cleaned: true }),
      },
    })
    render(createElement(
      I18nextProvider,
      { i18n },
      createElement(AssetUploadDialog as unknown as (props: Record<string, unknown>) => React.ReactElement, {
        open: true,
        maxUploadBytes: MAX_BYTES,
        onClose: () => {},
        onSubmit: async () => {},
        scope: { workspaceId: 'ws-pc', productSpaceId: 'ps-1', projectId: 'pj-1' },
        onBatchEntry: async () => {},
      }),
    ))
    return { harness, folderScans, zipStages }
  }

  it('a single plain file drops into the original form (same route as a pick)', async () => {
    const { harness } = renderBatchDialog()
    harness.fileBodies['/dropped/plan.md'] = utf8('plan')
    const dataTransfer = makeDropDataTransfer([{ name: 'plan.md', path: '/dropped/plan.md' }])

    // Hover feedback first.
    fireEvent.dragEnter(screen.getByTestId('pc-upload-dialog'), { dataTransfer })
    expect(screen.getByTestId('pc-upload-drop-overlay')).toBeTruthy()
    fireEvent.drop(screen.getByTestId('pc-upload-dialog'), { dataTransfer })
    expect(screen.queryByTestId('pc-upload-drop-overlay')).toBeNull()

    // The form ingested it like a native pick.
    const summary = await screen.findByTestId('pc-upload-file-summary')
    expect(summary).toBeTruthy()
    expect((screen.getByTestId('pc-upload-name') as HTMLInputElement).value).toBe('plan.md')
    expect(screen.queryByTestId('pc-batch-view')).toBeNull()
  })

  it('several plain files drop into the batch checklist (multi-pick route)', async () => {
    const { harness } = renderBatchDialog()
    harness.fileBodies['/dropped/one.md'] = utf8('1')
    harness.fileBodies['/dropped/two.md'] = utf8('2')
    const dataTransfer = makeDropDataTransfer([
      { name: 'one.md', path: '/dropped/one.md' },
      { name: 'two.md', path: '/dropped/two.md' },
    ])
    fireEvent.drop(screen.getByTestId('pc-upload-dialog'), { dataTransfer })

    await screen.findByTestId('pc-batch-view')
    expect(screen.getAllByTestId('pc-batch-entry')).toHaveLength(2)
    expect(screen.queryByTestId('pc-upload-file-summary')).toBeNull()
  })

  it('a dropped zip unpacks into the staging checklist', async () => {
    const { zipStages } = renderBatchDialog()
    const dataTransfer = makeDropDataTransfer([{ name: 'photos.zip', path: '/dropped/photos.zip' }])
    fireEvent.drop(screen.getByTestId('pc-upload-dialog'), { dataTransfer })

    await screen.findByTestId('pc-batch-view')
    expect(zipStages).toHaveLength(1)
    expect(zipStages[0]).toMatchObject({ zipPath: '/dropped/photos.zip' })
    expect(screen.getByTestId('pc-batch-entry')).toBeTruthy()
  })

  it('a dropped folder runs the folder scan (pcScanFolder)', async () => {
    const { folderScans } = renderBatchDialog()
    const dataTransfer = makeDropDataTransfer([{ name: 'results', isDirectory: true, path: '/dropped/results' }])
    fireEvent.drop(screen.getByTestId('pc-upload-dialog'), { dataTransfer })

    await screen.findByTestId('pc-batch-view')
    expect(folderScans).toHaveLength(1)
    expect(folderScans[0]).toMatchObject({ folderPath: '/dropped/results' })
  })

  it('a mixed folder+files drop is refused with clear copy instead of a partial scan', async () => {
    const { folderScans } = renderBatchDialog()
    const dataTransfer = makeDropDataTransfer([
      { name: 'results', isDirectory: true, path: '/dropped/results' },
      { name: 'loose.md', path: '/dropped/loose.md' },
    ])
    fireEvent.drop(screen.getByTestId('pc-upload-dialog'), { dataTransfer })

    const error = await screen.findByTestId('pc-upload-batch-error')
    expect(error.textContent.toLowerCase()).toContain('folder')
    expect(folderScans).toHaveLength(0)
    expect(screen.queryByTestId('pc-batch-view')).toBeNull()
  })

  it('without the batch capability a multi-file drop refuses instead of silently picking one', async () => {
    const harness = renderDialog()
    const dataTransfer = makeDropDataTransfer([
      { name: 'one.md', path: '/picked/one.md' },
      { name: 'two.md', path: '/picked/two.md' },
    ])
    fireEvent.drop(screen.getByTestId('pc-upload-dialog'), { dataTransfer })

    const error = await screen.findByTestId('pc-upload-batch-error')
    expect(error.textContent).toContain('one file')
    expect(screen.queryByTestId('pc-upload-file-summary')).toBeNull()
    expect(harness.submissions).toHaveLength(0)
  })
})
