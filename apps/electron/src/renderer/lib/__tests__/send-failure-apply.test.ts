import { describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'
import { setupI18n } from '@polo-ai/shared/i18n'
import { sendFailureAtomFamily } from '@/atoms/sessions'
import { applyEventBillingBlock, applySendBlockedByLatch, applySendFailure } from '../send-failure-apply'
import type { BillingLatchSourceLease } from '../billing-refresh'

// U4 (product-closure 2026-10-27) — every send entry point funnels into the
// SAME failure pipeline. These tests pin the three classification entries
// (billing-block / goal-start-failed / send-failed) and the pre-send latch
// stop, via a real jotai store and real i18n resources.

setupI18n()

// Classification is STRUCTURED-CODE-only (quota-error.ts deliberately never
// guesses from message text), so the fixtures carry trusted fields.
const CREDIT_ERROR = Object.assign(new Error('Insufficient balance. Recharge to continue.'), {
  errorCode: 'insufficient_credit', status: 402,
})
const QUOTA_ERROR = Object.assign(new Error('Period quota exhausted.'), {
  status: 429, quotaResetAt: 1735689600000,
})

function makeDeps() {
  const store = createStore()
  const latch: Array<{ issue: string; quotaResetAt?: number }> = []
  return {
    store,
    latch,
    deps: {
      store,
      setBillingLatch: (issue: 'insufficient-credit' | 'quota-exhausted', quotaResetAt?: number) => {
        latch.push({ issue, quotaResetAt })
      },
    },
  }
}

describe('applySendFailure (U4 unified pipeline)', () => {
  test('billing-block (insufficient credit) latches AND parks the draft restorable', () => {
    const { store, latch, deps } = makeDeps()
    const outcome = applySendFailure(
      CREDIT_ERROR,
      { sessionId: 's1', draft: 'hello world', hadGoalStartIntent: false },
      deps,
    )
    expect(outcome.kind).toBe('billing-block')
    expect(latch).toEqual([{ issue: 'insufficient-credit', quotaResetAt: undefined }])
    const prompt = store.get(sendFailureAtomFamily('s1'))
    expect(prompt?.billingBlocked).toBe(true)
    expect(prompt?.draft).toBe('hello world')
    expect(prompt?.detail).toContain('Insufficient balance')
  })

  test('billing-block (period quota) latches with the server reset fact when present', () => {
    const { store, latch, deps } = makeDeps()
    const outcome = applySendFailure(QUOTA_ERROR, { sessionId: 's2', draft: 'd', hadGoalStartIntent: false }, deps)
    expect(outcome.kind).toBe('billing-block')
    expect(latch).toEqual([{ issue: 'quota-exhausted', quotaResetAt: 1735689600000 }])
    expect(store.get(sendFailureAtomFamily('s2'))?.billingBlocked).toBe(true)
  })

  test('goal-start-failed surfaces the Goal toast, never a re-send prompt and never a latch', () => {
    const { store, latch, deps } = makeDeps()
    const outcome = applySendFailure(
      new Error('server rejected the goal'),
      { sessionId: 's3', draft: 'd', hadGoalStartIntent: true },
      deps,
    )
    expect(outcome.kind).toBe('goal-start-failed')
    expect(latch).toEqual([])
    expect(store.get(sendFailureAtomFamily('s3'))).toBeNull()
  })

  test('plain send failure keeps the draft in a NON-billing prompt (no latch)', () => {
    const { store, latch, deps } = makeDeps()
    const outcome = applySendFailure(
      new Error('transport dropped'),
      { sessionId: 's4', draft: 'keep me', hadGoalStartIntent: false },
      deps,
    )
    expect(outcome.kind).toBe('send-failed')
    expect(latch).toEqual([])
    const prompt = store.get(sendFailureAtomFamily('s4'))
    expect(prompt?.draft).toBe('keep me')
    expect(prompt?.billingBlocked).toBeUndefined()
    expect(prompt?.detail).toBe('transport dropped')
  })

  test('a broken classifier degrades to a plain send failure instead of throwing', () => {
    const { store, latch, deps } = makeDeps()
    const hostile = { get message(): string { throw new Error('hostile getter') } }
    const outcome = applySendFailure(hostile, { sessionId: 's5', draft: 'd', hadGoalStartIntent: false }, deps)
    expect(outcome.kind).toBe('send-failed')
    expect(store.get(sendFailureAtomFamily('s5'))).not.toBeNull()
  })
})

describe('applySendBlockedByLatch (U4 pre-send stop)', () => {
  test('parks the draft as billing-blocked WITHOUT any latch write or request', () => {
    const { store, deps } = makeDeps()
    applySendBlockedByLatch('s6', 'queued text', { store })
    const prompt = store.get(sendFailureAtomFamily('s6'))
    expect(prompt?.billingBlocked).toBe(true)
    expect(prompt?.draft).toBe('queued text')
    // Overwriting a prior prompt replaces it — the freshest blocked draft wins.
    applySendBlockedByLatch('s6', 'newer text', { store })
    expect(store.get(sendFailureAtomFamily('s6'))?.draft).toBe('newer text')
  })
})

// POO-177 QUOTA-01 — a turn the SERVER terminated (post-persist admission
// rejection / provider 402) must write the SAME latch a rejected send does,
// bound to the lease the caller resolves at failure time. It deliberately
// writes NO draft prompt: the blocked text is already a persisted message.
describe('applyEventBillingBlock (POO-177 事件流计费阻断)', () => {
  function makeEventDeps(lease: BillingLatchSourceLease) {
    const store = createStore()
    const latch: Array<{ issue: string; quotaResetAt?: number }> = []
    const bound: BillingLatchSourceLease[] = []
    return {
      store,
      latch,
      bound,
      deps: {
        setBillingLatch: (issue: 'insufficient-credit' | 'quota-exhausted', quotaResetAt?: number) => {
          latch.push({ issue, quotaResetAt })
        },
        onBindBillingLease: (resolved: BillingLatchSourceLease) => { bound.push(resolved) },
        resolveLease: () => lease,
      },
    }
  }

  test('post-persist admission 拒绝事件 → latch 写入 + admin-managed lease 绑定,无 draft prompt', () => {
    const lease: BillingLatchSourceLease = {
      source: 'admin-managed', sessionId: 'ev1',
      connectionSlug: 'polo-space-31030000-0000-4000-8000-0000000000f1',
      productSpaceId: '31030000-0000-4000-8000-0000000000f1', accountId: 'user-1',
    }
    const { store, latch, bound, deps } = makeEventDeps(lease)
    applyEventBillingBlock('ev1', { errorCode: 'budget_exhausted', status: 409 }, deps)
    expect(latch).toEqual([{ issue: 'insufficient-credit', quotaResetAt: undefined }])
    expect(bound).toEqual([lease])
    expect(store.get(sendFailureAtomFamily('ev1'))).toBeNull()
  })

  test('provider 402 typed_error 事件 → 同一 latch 写入', () => {
    const { latch, bound, deps } = makeEventDeps({
      source: 'admin-managed', sessionId: 'ev2', connectionSlug: 'polo-space-x',
      productSpaceId: 'space-x', accountId: 'user-1',
    })
    applyEventBillingBlock('ev2', { status: 402 }, deps)
    expect(latch).toEqual([{ issue: 'insufficient-credit', quotaResetAt: undefined }])
    expect(bound).toHaveLength(1)
    expect(bound[0]?.source).toBe('admin-managed')
  })

  test('BYOK 402 由调用方 lease 决定刷新不可达:lease 原样透传,不二次加工', () => {
    const lease: BillingLatchSourceLease = { source: 'unknown', sessionId: 'ev3' }
    const { latch, bound, deps } = makeEventDeps(lease)
    applyEventBillingBlock('ev3', { status: 402 }, deps)
    expect(latch).toEqual([{ issue: 'insufficient-credit', quotaResetAt: undefined }])
    expect(bound).toEqual([lease])
  })

  test('非计费事件(无分类字段)→ 完全 no-op', () => {
    const { store, latch, bound, deps } = makeEventDeps({ source: 'unknown' })
    applyEventBillingBlock('ev4', undefined, deps)
    applyEventBillingBlock('ev4', { errorCode: 'HANDLER_ERROR' }, deps)
    expect(latch).toEqual([])
    expect(bound).toEqual([])
    expect(store.get(sendFailureAtomFamily('ev4'))).toBeNull()
  })
})
