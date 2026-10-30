/** POO-177 — the structured billing classification an event-stream error
 * carries. Only trusted structured fields (AdminError's errorCode / HTTP
 * status) of the shared billing classes may ride the wire; anything else
 * stays unclassified so the renderer can never talk a plain failure into a
 * billing block. */
import { describe, expect, test } from 'bun:test'
import { AdminError } from '../../../../shared/src/admin'
import { readBillingErrorClassification } from '../assistant-billing'

describe('readBillingErrorClassification(POO-177 事件流计费分类)', () => {
  test('Admin admission 拒绝(budget_exhausted,409)→ 结构化分类', () => {
    const error = new AdminError('Space budget exhausted', 'budget_exhausted', { status: 409 })
    expect(readBillingErrorClassification(error)).toEqual({ errorCode: 'budget_exhausted', status: 409 })
  })

  test('Admin 余额拒绝(insufficient_credit)→ 只带码,无状态', () => {
    const error = new AdminError('Insufficient credit', 'insufficient_credit')
    expect(readBillingErrorClassification(error)).toEqual({ errorCode: 'insufficient_credit' })
  })

  test('HTTP 402 / 429 status → 分类,不依赖码', () => {
    expect(readBillingErrorClassification(Object.assign(new Error('paid'), { status: 402 })))
      .toEqual({ status: 402 })
    expect(readBillingErrorClassification(Object.assign(new Error('limited'), { status: 429 })))
      .toEqual({ status: 429 })
  })

  test('非计费错误(普通 Error / 非 HTTP 状态 / 无字段)→ undefined', () => {
    expect(readBillingErrorClassification(new Error('socket hang up'))).toBeUndefined()
    expect(readBillingErrorClassification(Object.assign(new Error('boom'), { status: 500 }))).toBeUndefined()
    expect(readBillingErrorClassification(Object.assign(new Error('boom'), { errorCode: 'HANDLER_ERROR' }))).toBeUndefined()
    expect(readBillingErrorClassification(undefined)).toBeUndefined()
    expect(readBillingErrorClassification('weird')).toBeUndefined()
  })

  test('非字符串码 / 非数字状态不进分类(协议只携带受信类型)', () => {
    expect(readBillingErrorClassification(Object.assign(new Error('boom'), { errorCode: 402, status: '402' })))
      .toBeUndefined()
  })
})
