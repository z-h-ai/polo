/** Journey #8 — failed local sends classify into distinct renderer surfaces
 * and never persist conversation content. Pins: billing classes route to the
 * #1 latch (period quota keeps only the server's own reset fact), a rejected
 * Goal start never becomes an ordinary re-send, everything else becomes a
 * draft-preserving prompt with the raw error as collapsed detail, and the
 * optimistic user bubble is stripped WITHOUT appending any error message. */
import { describe, expect, it } from 'bun:test'
import { classifySendFailure, stripFailedOptimisticMessage } from '../send-failure'

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
