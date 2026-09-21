import { describe, expect, it } from 'bun:test'
import {
  dedupeCircleSourcedApps,
  type CircleSourcedApp,
} from '../AllAppsPage'

function source(circleId: string, valid = true) {
  return {
    circleId,
    circleName: `圈子-${circleId}`,
    creator: `creator-${circleId}`,
    valid,
  }
}

describe('dedupeCircleSourcedApps (D-PC-09)', () => {
  it('merges multiple circle sources for the same work into one entry', () => {
    const apps: CircleSourcedApp[] = [
      {
        appId: 'minutes',
        name: '会议纪要整理',
        sources: [source('growth')],
      },
      {
        appId: 'minutes',
        name: '会议纪要整理',
        sources: [source('design')],
      },
    ]

    const result = dedupeCircleSourcedApps(apps)

    expect(result).toHaveLength(1)
    expect(result[0]!.appId).toBe('minutes')
    expect(result[0]!.sources.map(item => item.circleId))
      .toEqual(['growth', 'design'])
    expect(result[0]!.blocked).toBe(false)
  })

  it('keeps the app listed when only one of several sources is invalid', () => {
    const result = dedupeCircleSourcedApps([{
      appId: 'minutes',
      name: '会议纪要整理',
      sources: [source('growth', false), source('design', true)],
    }])

    expect(result).toHaveLength(1)
    expect(result[0]!.blocked).toBe(false)
    expect(result[0]!.sources.find(item => item.circleId === 'growth')!.valid)
      .toBe(false)
  })

  it('marks the app blocked when the last remaining source is invalid', () => {
    const result = dedupeCircleSourcedApps([{
      appId: 'brand',
      name: '品牌语气分析',
      sources: [source('design', false)],
    }])

    expect(result).toHaveLength(1)
    expect(result[0]!.blocked).toBe(true)
  })

  it('marks the app blocked after every merged source turned invalid', () => {
    const result = dedupeCircleSourcedApps([
      {
        appId: 'brand',
        name: '品牌语气分析',
        sources: [source('design', false)],
      },
      {
        appId: 'brand',
        name: '品牌语气分析',
        sources: [source('growth', false)],
      },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]!.blocked).toBe(true)
    expect(result[0]!.sources).toHaveLength(2)
  })

  it('keeps first-seen order and falls back to a later iconUrl', () => {
    const result = dedupeCircleSourcedApps([
      { appId: 'a', name: 'A', sources: [source('x')] },
      { appId: 'b', name: 'B', sources: [source('x')] },
      { appId: 'a', name: 'A', iconUrl: 'https://example.com/a.png', sources: [source('y')] },
    ])

    expect(result.map(entry => entry.appId)).toEqual(['a', 'b'])
    expect(result[0]!.iconUrl).toBe('https://example.com/a.png')
  })

  it('lets a re-listed source refresh its validity', () => {
    const result = dedupeCircleSourcedApps([
      {
        appId: 'growth',
        name: '增长打法手册',
        sources: [source('circle-a', true)],
      },
      {
        appId: 'growth',
        name: '增长打法手册',
        sources: [source('circle-a', false)],
      },
    ])

    expect(result).toHaveLength(1)
    expect(result[0]!.sources).toHaveLength(1)
    expect(result[0]!.sources[0]!.valid).toBe(false)
    expect(result[0]!.blocked).toBe(true)
  })

  it('skips malformed entries without throwing', () => {
    const result = dedupeCircleSourcedApps([
      null,
      { appId: '', name: 'empty id', sources: [] },
      { appId: 'ok', name: 'OK', sources: [source('x')] },
    ] as unknown as CircleSourcedApp[])

    expect(result).toHaveLength(1)
    expect(result[0]!.appId).toBe('ok')
  })
})
