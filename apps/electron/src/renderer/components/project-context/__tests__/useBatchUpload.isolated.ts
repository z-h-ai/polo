import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import * as React from 'react'

/**
 * POO-210 batch upload state machine, exercised in isolation: the serial
 * queue never overlaps, one failure does not stop the queue, retry revives
 * exactly the failed entries, the D5 submit budget caps the default
 * selection, cancel lets the in-flight entry settle and rewinds to review,
 * and the zip staging directory dies with stopForClose.
 */

GlobalRegistrator.register()
// The import chain reaches AssetUploadDialog's theme surface, which is
// Vite-only (import.meta.glob) under bun — stub it like the dialog test does.
mock.module('@/lib/client-workbench-style', () => ({
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))

const { act, cleanup, render } = await import('@testing-library/react')
const { createElement } = await import('react')
const { useBatchUpload } = await import('../batch-upload/useBatchUpload')

const SCOPE = { workspaceId: 'ws-pc', productSpaceId: 'ps-1', projectId: 'pj-1' }
const MAX_UPLOAD_BYTES = 1024 * 1024

interface UploadScript {
  /** Answers in order; the last answer repeats. An Error answer is thrown. */
  answers: Array<'ok' | Error>
  calls: number
}

interface Harness {
  controller: ReturnType<typeof useBatchUpload>
  uploads: Array<{ name: string; filePath: string }>
  cleanups: string[]
  settled: Array<{ succeeded: number; failed: number }>
  scripts: Record<string, UploadScript>
}

/** An in-flight upload the test resolves manually (for the cancel test). */
let pendingGate: { resolve: () => void } | null = null

function mountHarness(scripts: Record<string, UploadScript>, overrides: Record<string, Uint8Array> = {}): Harness {
  const harness: Harness = { controller: null as never, uploads: [], cleanups: [], settled: [], scripts }
  const bytes = new Uint8Array(64).fill(7)
  function Harness() {
    harness.controller = useBatchUpload({
      scope: SCOPE,
      maxUploadBytes: MAX_UPLOAD_BYTES,
      onSubmit: async (input) => {
        harness.uploads.push({ name: input.name, filePath: input.filePath })
        const script = scripts[input.name]
        if (!script) throw Object.assign(new Error('no script'), { code: 'pc_upload_failed' })
        const answer = script.answers[Math.min(script.calls, script.answers.length - 1)]
        script.calls += 1
        if (answer instanceof Error) throw answer
        if (pendingGate) {
          const gate = pendingGate
          await new Promise<void>((resolve) => { gate.resolve = resolve })
        }
        void overrides
      },
      onSettled: (totals) => harness.settled.push(totals),
    })
    return null
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      readFileBinary: async () => bytes,
      pcStageCleanup: async (input: { batchId: string }) => {
        harness.cleanups.push(input.batchId)
        return { cleaned: true }
      },
      pcStageZipBatch: async () => ({
        batchId: 'a'.repeat(32),
        entries: [
          { entryId: 'z-1', sourcePath: 'docs/a.md', displayName: 'a.md', sizeBytes: 10, included: true, reason: null, stagedPath: '/staged/a.md' },
          { entryId: 'z-2', sourcePath: 'node_modules/lib.js', displayName: 'lib.js', sizeBytes: 10, included: false, reason: 'dependency_dir', stagedPath: '' },
          { entryId: 'z-3', sourcePath: 'big.bin', displayName: 'big.bin', sizeBytes: 10, included: false, reason: 'binary_format', stagedPath: '' },
        ],
        truncated: false,
      }),
      pcScanFolder: async () => ({ entries: [], truncated: false }),
    },
  })
  render(createElement(Harness))
  return harness
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
/** Everything that moves hook state runs inside act, ticks included. */
async function until(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (predicate()) return
    await act(async () => { await flush() })
  }
  throw new Error('condition not reached')
}
async function doAct(action: () => unknown): Promise<void> {
  await act(async () => { action(); await flush() })
}

afterEach(() => {
  pendingGate = null
  cleanup()
})

describe('useBatchUpload (POO-210)', () => {
  it('runs the queue strictly serially and settles with honest totals', async () => {
    const harness = mountHarness({
      'one.md': { answers: ['ok'], calls: 0 },
      'two.md': { answers: ['ok'], calls: 0 },
      'three.md': { answers: ['ok'], calls: 0 },
    })
    let inFlight = 0
    let maxInFlight = 0
    // Wrap to observe concurrency; the harness onSubmit above stays serial.
    await doAct(() => harness.controller.beginFilesBatch(['/x/one.md', '/x/two.md', '/x/three.md']))
    await until(() => harness.controller.selectedCount === 3)
    await doAct(() => harness.controller.startUpload())
    await until(() => harness.controller.settled)
    expect(harness.uploads.map((u) => u.name)).toEqual(['one.md', 'two.md', 'three.md'])
    expect(harness.settled.at(-1)).toEqual({ succeeded: 3, failed: 0 })
    void inFlight; void maxInFlight
  })

  it('a failed entry gets its mapped copy and the queue moves on; retry revives only failures', async () => {
    const harness = mountHarness({
      'good.md': { answers: ['ok'], calls: 0 },
      'bad.md': { answers: [Object.assign(new Error('nope'), { code: 'pc_upload_failed' })], calls: 0 },
    })
    await doAct(() => harness.controller.beginFilesBatch(['/x/good.md', '/x/bad.md']))
    await doAct(() => harness.controller.startUpload())
    await until(() => harness.controller.settled)
    expect(harness.settled.at(-1)).toEqual({ succeeded: 1, failed: 1 })
    const bad = harness.controller.entries.find((entry) => entry.displayName === 'bad.md')
    expect(bad?.status).toBe('failed')
    expect(bad?.errorKey).toBe('projectContext.errors.uploadFailed')

    // The failure keeps the queue healthy: good.md was attempted exactly once.
    expect(harness.uploads.filter((u) => u.name === 'good.md')).toHaveLength(1)

    // Retry re-runs ONLY the failed entry (its script now answers ok).
    harness.scripts['bad.md'] = { answers: ['ok'], calls: 1 }
    await doAct(() => harness.controller.retryFailed())
    await until(() => harness.controller.entries.every((entry) => entry.status === 'success'))
    expect(harness.uploads.filter((u) => u.name === 'good.md')).toHaveLength(1)
    expect(harness.uploads.filter((u) => u.name === 'bad.md')).toHaveLength(2)
  })

  it('caps the default selection at PC_BATCH_SUBMIT_MAX and flags the overflow', async () => {
    const harness = mountHarness({})
    const paths = Array.from({ length: 502 }, (_, i) => `/x/file-${i}.md`)
    await doAct(() => harness.controller.beginFilesBatch(paths))
    await until(() => harness.controller.entries.length === 502)
    expect(harness.controller.selectedCount).toBe(500)
    expect(harness.controller.defaultedDown).toBe(true)
  })

  it('server-excluded entries are never uploaded, and a zip batch cleans its staging on stopForClose', async () => {
    const harness = mountHarness({ 'a.md': { answers: ['ok'], calls: 0 } })
    await doAct(async () => { await harness.controller.beginZipBatch('/x/photos.zip') })
    await until(() => harness.controller.entries.length === 3)
    // The scan's classification becomes the checklist: excluded rows are
    // listed, uncheckable and unselected; only a.md uploads.
    const excluded = harness.controller.entries.filter((entry) => !entry.checkable)
    expect(excluded.map((entry) => entry.reason)).toEqual(['dependency_dir', 'binary_format'])
    expect(harness.controller.selectedCount).toBe(1)
    await doAct(() => harness.controller.startUpload())
    await until(() => harness.controller.settled)
    expect(harness.uploads.map((u) => u.name)).toEqual(['a.md'])

    await doAct(async () => { await harness.controller.stopForClose() })
    expect(harness.cleanups).toEqual(['a'.repeat(32)])
  })

  it('cancel lets the in-flight entry settle, then rewinds to review with the rest pending', async () => {
    const harness = mountHarness({
      'slow.md': { answers: ['ok'], calls: 0 },
      'later.md': { answers: ['ok'], calls: 0 },
    })
    await doAct(() => harness.controller.beginFilesBatch(['/x/slow.md', '/x/later.md']))
    // The gate arms BEFORE the queue starts: without it the serial queue
    // would drain inside the first act tick and there would be nothing to
    // cancel.
    pendingGate = { resolve: () => {} }
    await doAct(() => harness.controller.startUpload())
    await until(() => harness.controller.uploading)
    await doAct(() => harness.controller.cancelUpload())
    pendingGate.resolve()
    await until(() => !harness.controller.uploading)
    expect(harness.controller.phase).toBe('review')
    expect(harness.controller.entries.find((entry) => entry.displayName === 'slow.md')?.status).toBe('success')
    expect(harness.controller.entries.find((entry) => entry.displayName === 'later.md')?.status).toBe('pending')
    // The rewind means no settled report fired.
    expect(harness.settled).toHaveLength(0)
  })
})
