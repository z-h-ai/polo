import { describe, expect, it } from 'bun:test'
import {
  addMonths,
  applyRenewal,
  buildCircleWorkRows,
  isAppUsable,
  membershipState,
  maxPrepaidExpiry,
  renewalBaseDate,
  revokeCircleSources,
} from '../circlesState'
import type { CircleSourcedApp, CircleSummary } from '../types'

function paidCircle(overrides: Partial<CircleSummary> = {}): CircleSummary {
  return {
    id: 'circle-design',
    name: '晨星设计圈',
    creator: '晨星增长工作室',
    membership: 'active',
    subscription: { price: '¥39 / 月', expiresAt: '2026-10-01' },
    appCount: 2,
    skillCount: 1,
    ...overrides,
  }
}

function sourcedApps(): CircleSourcedApp[] {
  return [
    {
      appId: 'app-brand-voice',
      name: '品牌语气分析',
      sources: [
        { circleId: 'circle-design', circleName: '晨星设计圈', creator: '晨星增长工作室', valid: true },
      ],
    },
    {
      appId: 'app-meeting-notes',
      name: '会议纪要整理',
      sources: [
        { circleId: 'circle-design', circleName: '晨星设计圈', creator: '晨星增长工作室', valid: true },
        { circleId: 'circle-growth', circleName: '晨星增长圈', creator: '晨星增长工作室', valid: true },
      ],
    },
  ]
}

function sharedSkills(): CircleSourcedApp[] {
  return [
    {
      appId: 'skill-case-search',
      name: '增长案例检索',
      sources: [
        { circleId: 'circle-design', circleName: '晨星设计圈', creator: '晨星增长工作室', valid: true },
        { circleId: 'circle-growth', circleName: '晨星增长圈', creator: '晨星增长工作室', valid: true },
      ],
    },
  ]
}

describe('circle subscription state machine', () => {
  it('stays active before the expiry date', () => {
    expect(membershipState(paidCircle(), '2026-09-22')).toBe('active')
    expect(membershipState(paidCircle(), '2026-10-01')).toBe('active')
  })

  it('flips to expired the day after the expiry date', () => {
    expect(membershipState(paidCircle(), '2026-10-02')).toBe('expired')
  })

  it('passes through non-active membership states untouched', () => {
    expect(membershipState(paidCircle({ membership: 'left' }), '2026-09-22')).toBe('left')
    expect(
      membershipState(paidCircle({ membership: 'pendingApproval' }), '2026-09-22'),
    ).toBe('pendingApproval')
  })

  it('free circles never expire', () => {
    const free = paidCircle({ subscription: undefined })
    expect(membershipState(free, '2030-01-01')).toBe('active')
  })
})

describe('renewal start date and cap (PC-F03)', () => {
  it('renews from the current expiry while active', () => {
    expect(renewalBaseDate({ expiresAt: '2026-10-01' }, '2026-09-22')).toBe('2026-10-01')
  })

  it('repurchase after expiry starts today and takes effect immediately', () => {
    expect(renewalBaseDate({ expiresAt: '2026-09-01' }, '2026-09-17')).toBe('2026-09-17')
  })

  it('renewal of one month extends from the base date, not from today', () => {
    const outcome = applyRenewal('2026-10-01', 1)
    expect(outcome.expiresAt).toBe('2026-11-01')
    expect(outcome.capped).toBe(false)
  })

  it('repurchase after expiry lands a month after today', () => {
    const outcome = applyRenewal('2026-09-17', 1)
    expect(outcome.expiresAt).toBe('2026-10-17')
    expect(outcome.capped).toBe(false)
  })

  it('caps prepaid time at 12 months ahead of the base date', () => {
    const outcome = applyRenewal('2026-10-01', 13)
    expect(outcome.expiresAt).toBe(maxPrepaidExpiry('2026-10-01'))
    expect(outcome.expiresAt).toBe('2027-10-01')
    expect(outcome.capped).toBe(true)
  })

  it('exactly 12 months is within the cap', () => {
    const outcome = applyRenewal('2026-10-01', 12)
    expect(outcome.expiresAt).toBe('2027-10-01')
    expect(outcome.capped).toBe(false)
  })

  it('addMonths clamps to the target month length', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonths('2026-10-31', 6)).toBe('2027-04-30')
  })
})

describe('leaving a circle revokes only that source (D-PC-09)', () => {
  it('marks only the left circle sources invalid', () => {
    const after = revokeCircleSources(sourcedApps(), 'circle-design')
    expect(after[0]!.sources[0]!.valid).toBe(false)
    expect(after[1]!.sources[0]!.valid).toBe(false)
    expect(after[1]!.sources[1]!.valid).toBe(true)
  })

  it('a work with another valid source stays usable', () => {
    const after = revokeCircleSources(sourcedApps(), 'circle-design')
    expect(isAppUsable(after[0]!)).toBe(false)
    expect(isAppUsable(after[1]!)).toBe(true)
  })

  it('revoking the last valid source makes the work unusable', () => {
    const once = revokeCircleSources(sourcedApps(), 'circle-design')
    const twice = revokeCircleSources(once, 'circle-growth')
    expect(isAppUsable(twice[0]!)).toBe(false)
    expect(isAppUsable(twice[1]!)).toBe(false)
  })

  it('does not mutate the input data', () => {
    const before = sourcedApps()
    revokeCircleSources(before, 'circle-design')
    expect(before[0]!.sources[0]!.valid).toBe(true)
  })
})

describe('detail work rows from sourced apps', () => {
  it('keeps shared works as one row with both source names', () => {
    const rows = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈' },
      apps: sourcedApps(),
      skills: [],
    })
    expect(rows).toHaveLength(2)
    expect(rows[1]!.sourceNames).toEqual(['晨星设计圈', '晨星增长圈'])
    expect(rows[0]!.availability).toBe('usable')
  })

  it('shows the fallback presentation after this source was revoked', () => {
    const after = revokeCircleSources(sourcedApps(), 'circle-design')
    const rows = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈' },
      apps: after,
      skills: [],
    })
    expect(rows[0]!.availability).toBe('unavailable')
    expect(rows[0]!.fallbackNote).toBeUndefined()
    expect(rows[1]!.availability).toBe('stillAuthorized')
    expect(rows[1]!.fallbackNote).toEqual({
      kind: 'other-source',
      circleName: '晨星增长圈',
    })
  })

  it('uninstalled skills are installable regardless of app rows', () => {
    const rows = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈' },
      apps: [],
      skills: [
        {
          appId: 'skill-case-search',
          name: '增长案例检索',
          sources: [
            { circleId: 'circle-design', circleName: '晨星设计圈', creator: '晨星增长工作室', valid: true },
          ],
        },
      ],
    })
    expect(rows[0]!.kind).toBe('skill')
    expect(rows[0]!.availability).toBe('installable')
    expect(rows[0]!.fallbackNote).toEqual({ kind: 'install-note' })
  })

  it('works revoked everywhere but still shared stay installable for skills', () => {
    const rows = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈' },
      apps: [],
      skills: revokeCircleSources(
        [
          {
            appId: 'skill-case-search',
            name: '增长案例检索',
            sources: [
              { circleId: 'circle-design', circleName: '晨星设计圈', creator: '晨星增长工作室', valid: true },
              { circleId: 'circle-growth', circleName: '晨星增长圈', creator: '晨星增长工作室', valid: true },
            ],
          },
        ],
        'circle-design',
      ),
    })
    expect(rows[0]!.availability).toBe('stillAuthorized')
    expect(rows[0]!.fallbackNote).toEqual({
      kind: 'other-source',
      circleName: '晨星增长圈',
    })
  })

  it('skips works the circle does not provide', () => {
    const rows = buildCircleWorkRows({
      circle: { id: 'circle-growth', name: '晨星增长圈' },
      apps: sourcedApps(),
      skills: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe('会议纪要整理')
  })

  it('carries the installed flag for the stillAuthorized install action', () => {
    const after = revokeCircleSources(sourcedApps(), 'circle-design')
    const skills = revokeCircleSources(sharedSkills(), 'circle-design')
    const uninstalled = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈' },
      apps: after,
      skills,
    })
    expect(uninstalled[2]!.kind).toBe('skill')
    expect(uninstalled[2]!.availability).toBe('stillAuthorized')
    expect(uninstalled[2]!.installed).toBe(false)

    const installed = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈' },
      apps: after,
      skills,
      installedSkillIds: ['skill-case-search'],
    })
    expect(installed[2]!.installed).toBe(true)
  })
})

describe('row availability by membership state (expired vs left)', () => {
  const revokedApps = () => revokeCircleSources(sourcedApps(), 'circle-design')

  it('an expired subscription keeps only-here works actionable as expired', () => {
    const rows = buildCircleWorkRows({
      circle: {
        id: 'circle-design',
        name: '晨星设计圈',
        membership: 'active',
        subscription: { price: '¥39 / 月', expiresAt: '2026-09-01' },
      },
      apps: revokedApps(),
      skills: [],
      now: '2026-09-22',
    })
    // 品牌语气分析 only comes from this circle → 已到期 (+ 打开/续费恢复).
    expect(rows[0]!.name).toBe('品牌语气分析')
    expect(rows[0]!.availability).toBe('expired')
    // 会议纪要整理 is co-authorized → still usable via the other source.
    expect(rows[1]!.availability).toBe('stillAuthorized')
  })

  it('a left circle renders its only-here works unavailable, not expired', () => {
    const rows = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈', membership: 'left' },
      apps: revokedApps(),
      skills: [],
      now: '2026-09-22',
    })
    expect(rows[0]!.availability).toBe('unavailable')
    expect(rows[1]!.availability).toBe('stillAuthorized')
  })

  it('revoked sources without an expired subscription stay unavailable', () => {
    const rows = buildCircleWorkRows({
      circle: { id: 'circle-design', name: '晨星设计圈' },
      apps: revokedApps(),
      skills: [],
      now: '2026-09-22',
    })
    expect(rows[0]!.availability).toBe('unavailable')
  })

  it('the expiry date itself is still an active membership (usable rows)', () => {
    const rows = buildCircleWorkRows({
      circle: {
        id: 'circle-design',
        name: '晨星设计圈',
        membership: 'active',
        subscription: { price: '¥39 / 月', expiresAt: '2026-09-22' },
      },
      apps: sourcedApps(),
      skills: [],
      now: '2026-09-22',
    })
    expect(rows[0]!.availability).toBe('usable')
    expect(rows[1]!.availability).toBe('usable')
  })

  it('expired shared skills stay authorized through the other source', () => {
    const rows = buildCircleWorkRows({
      circle: {
        id: 'circle-design',
        name: '晨星设计圈',
        membership: 'active',
        subscription: { price: '¥39 / 月', expiresAt: '2026-09-01' },
      },
      apps: [],
      skills: revokeCircleSources(sharedSkills(), 'circle-design'),
      now: '2026-09-22',
    })
    expect(rows[0]!.kind).toBe('skill')
    expect(rows[0]!.availability).toBe('stillAuthorized')
    expect(rows[0]!.fallbackNote).toEqual({
      kind: 'other-source',
      circleName: '晨星增长圈',
    })
  })
})
