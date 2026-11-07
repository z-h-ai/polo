import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

/**
 * POO-196 R3 (P3/D6) — the home project directory device state: per-account
 * visit records in localStorage, recency-first ordering with a stable id
 * tiebreak, and the never-visited name/id fallback.
 */

GlobalRegistrator.register()

const { __resetProjectVisitsForTests, readProjectVisitOrder, recordProjectVisit, sortProjectDirectory } =
  await import('../project-directory')

beforeEach(() => {
  localStorage.clear()
  __resetProjectVisitsForTests()
})

afterEach(() => {
  __resetProjectVisitsForTests()
})

describe('recordProjectVisit / readProjectVisitOrder', () => {
  it('orders the account records most-recent-first and isolates them per account', () => {
    recordProjectVisit('account-a', 'space-1', 1_000)
    recordProjectVisit('account-a', 'space-2', 3_000)
    recordProjectVisit('account-a', 'space-3', 2_000)
    // A second account must never see (or shape) account-a's order.
    recordProjectVisit('account-b', 'space-9', 5_000)

    expect(readProjectVisitOrder('account-a').map(record => record.productSpaceId))
      .toEqual(['space-2', 'space-3', 'space-1'])
    expect(readProjectVisitOrder('account-b').map(record => record.productSpaceId))
      .toEqual(['space-9'])
    expect(readProjectVisitOrder('account-unknown')).toEqual([])
  })

  it('re-entry moves a project to the front and keeps one record per project', () => {
    recordProjectVisit('account-a', 'space-1', 1_000)
    recordProjectVisit('account-a', 'space-2', 2_000)
    recordProjectVisit('account-a', 'space-1', 3_000)

    const order = readProjectVisitOrder('account-a')
    expect(order.map(record => record.productSpaceId)).toEqual(['space-1', 'space-2'])
    expect(order).toHaveLength(2)
  })

  it('breaks same-timestamp ties by stable productSpaceId', () => {
    recordProjectVisit('account-a', 'space-b', 1_000)
    recordProjectVisit('account-a', 'space-a', 1_000)

    expect(readProjectVisitOrder('account-a').map(record => record.productSpaceId))
      .toEqual(['space-a', 'space-b'])
  })

  it('survives a corrupted store and empty ids fail closed', () => {
    localStorage.setItem('poo196.projects:visit-order:account-a', '{not json')
    expect(readProjectVisitOrder('account-a')).toEqual([])
    recordProjectVisit('account-a', 'space-1', 1_000)
    expect(readProjectVisitOrder('account-a')).toHaveLength(1)

    recordProjectVisit('', 'space-1')
    recordProjectVisit('account-a', '')
    expect(readProjectVisitOrder('account-a')).toHaveLength(1)
  })
})

describe('sortProjectDirectory', () => {
  const entries = [
    { id: 'p-alpha', name: 'Alpha' },
    { id: 'p-beta', name: 'Beta' },
    { id: 'p-gamma', name: 'Gamma' },
    { id: 'p-delta', name: 'Delta' },
  ]

  it('visited projects lead by recency; unvisited follow by locale name then id', () => {
    const sorted = sortProjectDirectory(entries, [
      { productSpaceId: 'p-beta', lastEnteredAt: 1_000 },
      { productSpaceId: 'p-delta', lastEnteredAt: 2_000 },
    ], 'en')
    expect(sorted.map(entry => entry.id)).toEqual(['p-delta', 'p-beta', 'p-alpha', 'p-gamma'])
  })

  it('same-time visits tie-break by id; unknown visit ids are ignored', () => {
    const sorted = sortProjectDirectory(entries, [
      { productSpaceId: 'p-gamma', lastEnteredAt: 5_000 },
      { productSpaceId: 'p-alpha', lastEnteredAt: 5_000 },
      { productSpaceId: 'p-ghost', lastEnteredAt: 9_999 },
    ], 'en')
    expect(sorted.map(entry => entry.id)).toEqual(['p-alpha', 'p-gamma', 'p-beta', 'p-delta'])
  })

  it('without visits the order is the locale name comparison (zh-Hans pinyin here), id as the final tiebreak', () => {
    // Pinyin order puts 安 (an) before 北 (bei) — the byte/code-point order
    // would be the reverse, so this pins the locale-aware comparison.
    const chinese = [
      { id: 'a', name: '北京' },
      { id: 'b', name: '安全' },
    ]
    expect(sortProjectDirectory(chinese, [], 'zh-Hans').map(entry => entry.id)).toEqual(['b', 'a'])
    // Identical names fall back to the stable id order.
    const twins = [
      { id: 'id-2', name: '同项目' },
      { id: 'id-1', name: '同项目' },
    ]
    expect(sortProjectDirectory(twins, [], 'zh-Hans').map(entry => entry.id)).toEqual(['id-1', 'id-2'])
  })
})
