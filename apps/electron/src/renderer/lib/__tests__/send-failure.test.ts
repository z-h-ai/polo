/** Journey #8 — failed local sends classify into distinct renderer surfaces
 * and never persist conversation content. Pins: billing classes route to the
 * #1 latch (period quota keeps only the server's own reset fact), a rejected
 * Goal start never becomes an ordinary re-send, everything else becomes a
 * draft-preserving prompt with the raw error as collapsed detail, and the
 * optimistic user bubble is stripped WITHOUT appending any error message. */
import { describe, expect, it } from 'bun:test'
import { classifyEventBillingBlock, classifySendFailure, stripFailedOptimisticMessage } from '../send-failure'

function errorWith(fields: Record<string, unknown>, message = 'boom'): Error {
  return Object.assign(new Error(message), fields)
}

describe('classifySendFailure 计费分类(journey #1/#8)', () => {
  it('insufficient_credit 码 → billing-block(insufficient-credit),无 reset 事实', () => {
    const outcome = classifySendFailure(errorWith({ code: 'insufficient_credit' }), { hadGoalStartIntent: false })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'insufficient-credit' })
  })

  it('INSUFFICIENT_BALANCE 大写变体同样命中共享码表', () => {
    const outcome = classifySendFailure(errorWith({ errorCode: 'INSUFFICIENT_BALANCE' }), { hadGoalStartIntent: false })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'insufficient-credit' })
  })

  it('HTTP 402 → billing-block(insufficient-credit)', () => {
    const outcome = classifySendFailure(errorWith({ status: 402 }), { hadGoalStartIntent: false })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'insufficient-credit' })
  })

  it('明确周期额度(429)→ billing-block(quota-exhausted),只透传服务器给的 reset', () => {
    const outcome = classifySendFailure(errorWith({ status: 429, quotaResetAt: 1735689600000 }), { hadGoalStartIntent: false })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'quota-exhausted', quotaResetAt: 1735689600000 })
  })

  it('429 无 reset 事实 → 不编造 reset', () => {
    const outcome = classifySendFailure(errorWith({ status: 429 }), { hadGoalStartIntent: false })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'quota-exhausted' })
  })

  it('计费类优先于 Goal 意图:即便 armed 也不落 goal-start-failed', () => {
    const outcome = classifySendFailure(errorWith({ code: 'insufficient_credit' }), { hadGoalStartIntent: true })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'insufficient-credit' })
  })
})

describe('classifySendFailure 普通与 Goal 失败(journey #8)', () => {
  it('armed Goal start 被拒 → goal-start-failed,不进普通重发', () => {
    const outcome = classifySendFailure(new Error('a goal is already active'), { hadGoalStartIntent: true })
    expect(outcome).toEqual({ kind: 'goal-start-failed' })
  })

  it('普通错误 → send-failed,detail 为原始错误文本(技术详情进折叠,不编造标题)', () => {
    const outcome = classifySendFailure(new Error('socket hang up'), { hadGoalStartIntent: false })
    expect(outcome).toEqual({ kind: 'send-failed', detail: 'socket hang up' })
  })

  it('非 Error 抛出物 → detail 字符串化,不猜测', () => {
    const outcome = classifySendFailure('weird', { hadGoalStartIntent: false })
    expect(outcome).toEqual({ kind: 'send-failed', detail: 'weird' })
  })
})

describe('stripFailedOptimisticMessage(journey #8)', () => {
  interface Slim { id: string; role: string }

  it('只移除该次发送的乐观消息,不追加任何 error 消息', () => {
    const messages: Slim[] = [
      { id: 'm1', role: 'user' },
      { id: 'opt-1', role: 'user' },
      { id: 'm2', role: 'assistant' },
    ]
    const next = stripFailedOptimisticMessage(messages, 'opt-1')
    expect(next.map(m => m.id)).toEqual(['m1', 'm2'])
    expect(next.some(m => m.role === 'error')).toBe(false)
  })

  it('不改动原数组(事件管线的不可变约定)', () => {
    const messages: Slim[] = [{ id: 'opt-1', role: 'user' }]
    const next = stripFailedOptimisticMessage(messages, 'opt-1')
    expect(messages).toHaveLength(1)
    expect(next).toHaveLength(0)
  })
})

// POO-177 QUOTA-01: server-terminated turns ride the classification through
// the SAME recognition table as a rejected send — the two production
// rejection shapes acc4 observed, plus the guard rails.
describe('classifyEventBillingBlock(POO-177 事件流分类)', () => {
  it('post-persist admission 拒绝分类(budget_exhausted,409)→ billing-block(insufficient-credit)', () => {
    const outcome = classifyEventBillingBlock({ errorCode: 'budget_exhausted', status: 409 })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'insufficient-credit' })
  })

  it('provider 402 typed_error 分类(status:402)→ billing-block(insufficient-credit)', () => {
    const outcome = classifyEventBillingBlock({ status: 402 })
    expect(outcome).toEqual({ kind: 'billing-block', issue: 'insufficient-credit' })
  })

  it('429 分类 → billing-block(quota-exhausted),无服务器 reset 事实就不编造', () => {
    expect(classifyEventBillingBlock({ status: 429 })).toEqual({
      kind: 'billing-block', issue: 'quota-exhausted',
    })
  })

  it('无分类字段的事件 → null,不猜测', () => {
    expect(classifyEventBillingBlock(undefined)).toBeNull()
  })

  it('非计费类(无码无状态)→ null,不落 latch', () => {
    expect(classifyEventBillingBlock({ errorCode: 'ECONNRESET' })).toBeNull()
    expect(classifyEventBillingBlock({})).toBeNull()
  })
})
