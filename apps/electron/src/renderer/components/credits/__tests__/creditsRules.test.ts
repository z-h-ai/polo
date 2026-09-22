import { describe, expect, it } from 'bun:test'
import {
  beginCheck,
  blockedTopup,
  isSendBlocked,
  requiresUserSendAfterArrival,
  settleCheck,
  stopReasonIsCreditsShortage,
} from '../creditsRules'

describe('topup check performs a single query per user check', () => {
  it('starts blocked without any query', () => {
    const state = blockedTopup({ balance: 12 })
    expect(state.phase).toBe('blocked')
    expect(state.checksPerformed).toBe(0)
    expect(isSendBlocked(state)).toBe(true)
  })

  it('beginCheck while checking is a no-op (no second parallel query)', () => {
    const state = beginCheck(blockedTopup({ balance: 12 }))
    expect(beginCheck(state)).toBe(state)
  })

  it('settles one query and counts it', () => {
    const state = settleCheck(beginCheck(blockedTopup({ balance: 12 })), {
      balance: 12,
    })
    expect(state.checksPerformed).toBe(1)
    expect(state.phase).toBe('not-arrived')
  })

  it('settle without an in-flight check changes nothing', () => {
    const state = blockedTopup({ balance: 12 })
    expect(settleCheck(state, { balance: 100 })).toBe(state)
  })

  it('not-arrived keeps the block and allows another user-initiated check', () => {
    let state = settleCheck(beginCheck(blockedTopup({ balance: 12 })), {
      balance: 12,
    })
    expect(isSendBlocked(state)).toBe(true)
    state = beginCheck(state)
    expect(state.phase).toBe('checking')
    state = settleCheck(state, { balance: 112 })
    expect(state.checksPerformed).toBe(2)
    expect(state.phase).toBe('arrived')
  })
})

describe('arrival lifts the block but never sends', () => {
  it('a higher balance unblocks the composer', () => {
    const state = settleCheck(beginCheck(blockedTopup({ balance: 12 })), {
      balance: 112,
    })
    expect(state.phase).toBe('arrived')
    expect(isSendBlocked(state)).toBe(false)
  })

  it('arrival always requires an explicit user send action', () => {
    const state = settleCheck(beginCheck(blockedTopup({ balance: 12 })), {
      balance: 112,
    })
    expect(requiresUserSendAfterArrival(state)).toBe(true)
  })

  it('the blocked and not-arrived states still require the user action', () => {
    expect(requiresUserSendAfterArrival(blockedTopup({ balance: 12 }))).toBe(false)
    const notArrived = settleCheck(beginCheck(blockedTopup({ balance: 12 })), {
      balance: 12,
    })
    expect(requiresUserSendAfterArrival(notArrived)).toBe(false)
  })
})

describe('user stop and credits cut stay separate', () => {
  it('a user stop is not a credits shortage', () => {
    expect(stopReasonIsCreditsShortage('user-stop')).toBe(false)
  })

  it('a credits cut is a credits shortage', () => {
    expect(stopReasonIsCreditsShortage('credits-cut')).toBe(true)
  })
})
