import { describe, expect, test } from 'bun:test'
import { presentBatchResult, runBatchOp, type BatchOpCounts } from '../batch-ops'

// U3 (product-closure 2026-10-27) — batch operations report REAL counts.
// The counting matrix and the success/partial/total-failure presentation.

describe('runBatchOp (U3 counting)', () => {
  test('all success counts every item', async () => {
    const ran: number[] = []
    const counts = await runBatchOp([1, 2, 3], async (n) => { ran.push(n) })
    expect(counts).toEqual({ ok: 3, failed: 0 })
    // Sequential, in caller order (matcher-index order matters upstream).
    expect(ran).toEqual([1, 2, 3])
  })

  test('all failures count without short-circuiting', async () => {
    const counts = await runBatchOp([1, 2, 3], async () => { throw new Error('boom') })
    expect(counts).toEqual({ ok: 0, failed: 3 })
  })

  test('mixed results collect per-item outcomes', async () => {
    const counts = await runBatchOp([1, 2, 3, 4, 5], async (n) => {
      if (n === 2 || n === 5) throw new Error('boom')
    })
    expect(counts).toEqual({ ok: 3, failed: 2 })
  })

  test('empty selection is a zero-count no-op', async () => {
    let calls = 0
    const counts = await runBatchOp([], async () => { calls += 1 })
    expect(counts).toEqual({ ok: 0, failed: 0 })
    expect(calls).toBe(0)
  })
})

describe('presentBatchResult (U3 honest toast matrix)', () => {
  const keys = { allSuccessKey: 'automations.batchDeleted', partialKey: 'batchOps.partialResult', allFailedKey: 'batchOps.allFailed' }

  test('zero failures → success toast with the existing pluralized copy', () => {
    const counts: BatchOpCounts = { ok: 4, failed: 0 }
    expect(presentBatchResult(counts, keys)).toEqual({
      toast: 'success',
      messageKey: 'automations.batchDeleted',
      params: { count: 4 },
    })
  })

  test('mixed → warning-shaped partial result carrying BOTH counts', () => {
    const p = presentBatchResult({ ok: 3, failed: 2 }, keys)
    expect(p.toast).not.toBe('success')
    expect(p.toast).toBe('warning')
    expect(p.messageKey).toBe('batchOps.partialResult')
    expect(p.params).toEqual({ ok: 3, fail: 2 })
  })

  test('total failure → error toast, never success wording', () => {
    const p = presentBatchResult({ ok: 0, failed: 5 }, keys)
    expect(p.toast).toBe('error')
    expect(p.messageKey).toBe('batchOps.allFailed')
    expect(p.params).toEqual({ count: 5 })
  })
})
