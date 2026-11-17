import { afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { setupI18n } from '@polo-ai/shared/i18n'
import * as React from 'react'

/**
 * POO-215 U2/U4 — the deposit round-trip behind the distillation checklist,
 * in isolation: entries flow through the EXISTING upload contract in input
 * order (storeAttachment → prepare → pcUploadFile → pcSetConfirmed), a
 * failing entry never stops the queue, U2's confirmed-by-default rides the
 * dedicated controlled-tag RPC (never the tag list), model-proposed tags are
 * filtered down to the preset whitelist, and the deposit fails closed
 * without a scope or a known upload ceiling.
 */

// Guarded like packages/ui *.isolated.tsx: register only when no window
// exists yet, so sibling isolated files in the same bun process are not hit
// by a second global registration.
if (typeof window === 'undefined') {
  GlobalRegistrator.register()
}
setupI18n()
// Same Vite-only theme surface stub as the batch-upload hook test.
mock.module('@/lib/client-workbench-style', () => ({
  useClientWorkbenchStyle: () => ({}),
  useClientMaterialScope: () => ({}),
}))

const { act, cleanup, render } = await import('@testing-library/react')
const { createElement } = await import('react')
const { I18nextProvider } = await import('react-i18next')
const { i18n } = await import('@polo-ai/shared/i18n')
const { useDistillUpload } = await import('../useDistillUpload')

const SCOPE = { workspaceId: 'ws-pc', productSpaceId: 'ps-1', projectId: 'pj-1' }
const MAX_UPLOAD_BYTES = 1024 * 1024

interface Harness {
  controller: ReturnType<typeof useDistillUpload>
  stored: Array<{ name: string; text: string }>
  uploads: Array<{ name: string; tags: string[]; source: unknown; sizeBytes: number }>
  confirmed: Array<{ assetId: string; version: unknown; confirmed: boolean }>
  capabilitiesCalls: number
  uploadScripts: Record<string, Array<'ok' | Error>>
}

function mountHarness(input: { scope?: typeof SCOPE | null; sessionTitle?: string | null } = {}): Harness {
  const harness: Harness = {
    controller: null as never,
    stored: [],
    uploads: [],
    confirmed: [],
    capabilitiesCalls: 0,
    uploadScripts: {},
  }
  const bytesByPath = new Map<string, Uint8Array>()
  function Harness() {
    harness.controller = useDistillUpload({
      sessionId: 'sess-1',
      scope: input.scope === undefined ? SCOPE : input.scope,
      sessionTitle: input.sessionTitle ?? '部署复盘会',
    })
    return null
  }
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pcListCapabilities: async () => {
        harness.capabilitiesCalls += 1
        return { limits: { maxUploadBytes: MAX_UPLOAD_BYTES } }
      },
      storeAttachment: async (_sessionId: string, attachment: { name: string; text: string }) => {
        harness.stored.push({ name: attachment.name, text: attachment.text })
        const storedPath = `/attachments/${encodeURIComponent(attachment.name)}`
        bytesByPath.set(storedPath, new TextEncoder().encode(attachment.text))
        return { storedPath }
      },
      readFileBinary: async (filePath: string) => {
        const bytes = bytesByPath.get(filePath)
        if (!bytes) throw new Error('not stored')
        return bytes
      },
      pcUploadFile: async (rpc: { name: string; tags: string[]; source: unknown; sizeBytes: number }) => {
        harness.uploads.push({ name: rpc.name, tags: rpc.tags, source: rpc.source, sizeBytes: rpc.sizeBytes })
        const script = harness.uploadScripts[rpc.name]
        const answer = script?.[Math.min(harness.uploads.filter(u => u.name === rpc.name).length - 1, (script?.length ?? 1) - 1)] ?? 'ok'
        if (answer instanceof Error) throw answer
        return { asset: { id: `asset-${rpc.name}`, current: { version: 3 } } }
      },
      pcSetConfirmed: async (rpc: { assetId: string; input: { expectedVersion: unknown; confirmed: boolean } }) => {
        harness.confirmed.push({ assetId: rpc.assetId, version: rpc.input.expectedVersion, confirmed: rpc.input.confirmed })
        return { ok: true }
      },
    },
  })
  render(createElement(I18nextProvider, { i18n }, createElement(Harness)))
  return harness
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(predicate: () => boolean, maxTicks = 200): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (predicate()) return
    await act(async () => { await flush() })
  }
  throw new Error('condition not reached')
}

const ENTRY_BASE = { suggestedTags: [] as string[] }

afterEach(cleanup)

describe('useDistillUpload (POO-215 U2)', () => {
  it('is not ready before the capability answers and deposits serially with the controlled confirmed tag', async () => {
    const harness = mountHarness({ sessionTitle: '部署复盘会' })
    expect(harness.controller.ready).toBe(false)
    await until(() => harness.controller.ready)
    expect(harness.capabilitiesCalls).toBe(1)

    const outcomes = await harness.controller.confirm([
      { id: 's1', title: '部署 SOP', body: '# SOP\n1. 构建', ...ENTRY_BASE },
      { id: 's2', title: '结论', body: '采用 B 计划', ...ENTRY_BASE },
    ])
    await until(() => harness.confirmed.length === 2)
    expect(outcomes.map(o => `${o.id}:${o.status}`)).toEqual(['s1:success', 's2:success'])
    // Serial, in input order, one store per entry, body written as markdown.
    expect(harness.stored.map(s => s.name)).toEqual(['部署 SOP.md', '结论.md'])
    expect(harness.stored[0]?.text).toContain('# SOP')
    // U2: the deposit flips the controlled tag through its own RPC with the
    // version the upload returned — never through the tag list.
    expect(harness.confirmed).toEqual([
      { assetId: 'asset-部署 SOP.md', version: 3, confirmed: true },
      { assetId: 'asset-结论.md', version: 3, confirmed: true },
    ])
    // The source note carries the conversation title (U4 dual-entry parity
    // with the share dialog's provenance line).
    expect(harness.uploads[0]?.source).toEqual({ kind: 'session', note: expect.stringContaining('部署复盘会') })
  })

  it('keeps going after a failing entry and maps its stable copy', async () => {
    const harness = mountHarness()
    await until(() => harness.controller.ready)
    harness.uploadScripts['bad.md'] = [Object.assign(new Error('wire'), { code: 'pc_service_unavailable' })]
    const outcomes = await harness.controller.confirm([
      { id: 's1', title: 'bad', body: 'x', ...ENTRY_BASE },
      { id: 's2', title: 'good', body: 'y', ...ENTRY_BASE },
    ])
    await until(() => harness.confirmed.length === 1)
    expect(outcomes).toEqual([
      { id: 's1', status: 'failed', errorKey: 'projectContext.errors.serviceUnavailable', errorDetail: 'wire' },
      { id: 's2', status: 'success' },
    ])
    // good.md uploaded exactly once — the failure never re-ordered the queue.
    expect(harness.uploads.map(u => u.name)).toEqual(['bad.md', 'good.md'])
  })

  it('filters suggested tags to the preset whitelist and drops the controlled id and duplicates', async () => {
    const harness = mountHarness()
    await until(() => harness.controller.ready)
    await harness.controller.confirm([
      {
        id: 's1',
        title: 'note',
        body: 'x',
        suggestedTags: ['Tech', 'custom-vendor', 'confirmed', 'tech', 'requirement ', 'stage'],
      },
    ])
    await until(() => harness.confirmed.length === 1)
    // Preset ids only (normalized + deduped); the controlled `confirmed` id
    // can never ride the tag list because the deposit sets it via RPC.
    expect(harness.uploads[0]?.tags).toEqual(['tech', 'requirement', 'stage'])
  })

  it('fails closed without a scope — every entry reports the same honest outcome', async () => {
    const harness = mountHarness({ scope: null })
    await until(() => !harness.controller.ready)
    const outcomes = await harness.controller.confirm([
      { id: 's1', title: 'a', body: 'x', ...ENTRY_BASE },
      { id: 's2', title: 'b', body: 'y', ...ENTRY_BASE },
    ])
    expect(outcomes).toEqual([
      { id: 's1', status: 'failed', errorKey: 'projectContext.errors.libraryNotReady' },
      { id: 's2', status: 'failed', errorKey: 'projectContext.errors.libraryNotReady' },
    ])
    expect(harness.stored).toEqual([])
    expect(harness.uploads).toEqual([])
    expect(harness.confirmed).toEqual([])
  })

  it('collapses filesystem-hostile title characters and falls back when the title is blank', async () => {
    const harness = mountHarness()
    await until(() => harness.controller.ready)
    await harness.controller.confirm([
      { id: 's1', title: 'a/b:c*d?', body: 'x', ...ENTRY_BASE },
      { id: 's2', title: '   ', body: 'y', ...ENTRY_BASE },
    ])
    await until(() => harness.confirmed.length === 2)
    expect(harness.stored.map(s => s.name)).toEqual(['a b c d.md', 'distilled-note.md'])
  })
})
