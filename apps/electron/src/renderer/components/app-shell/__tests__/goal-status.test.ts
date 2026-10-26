import { describe, expect, test } from 'bun:test'
import { GOAL_BADGE_META, goalBadgeState, isGoalRecordTerminal } from '../goal-status'
import { describeGoalVerification } from '../goal-verification-view'
import type { GoalRecord, GoalVerificationReceipt } from '@polo-ai/shared/protocol'

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: 'goal-1',
    sessionId: 's1',
    anchorMessageId: 'm1',
    objective: 'obj',
    supplementMessageIds: [],
    status: 'active',
    version: 1,
    runGeneration: 1,
    elapsedMs: 0,
    criteria: [],
    todos: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('goalBadgeState (journey #5 badge mapping)', () => {
  test('running states map to their own badges, not a blanket paused', () => {
    expect(goalBadgeState({ status: 'active' })).toBe('running')
    expect(goalBadgeState({ status: 'verifying' })).toBe('verifying')
  })

  test('each server pause reason gets its own badge', () => {
    expect(goalBadgeState({ status: 'paused', pauseReason: 'awaiting_user' })).toBe('awaiting-user')
    expect(goalBadgeState({ status: 'paused', pauseReason: 'error' })).toBe('paused-error')
    expect(goalBadgeState({ status: 'paused', pauseReason: 'no_progress' })).toBe('paused-no-progress')
    expect(goalBadgeState({ status: 'paused', pauseReason: 'restart_required' })).toBe('paused-restart-required')
    // manual/stop/awaiting_permission/absent stay on the plain paused badge.
    expect(goalBadgeState({ status: 'paused', pauseReason: 'manual' })).toBe('paused')
    expect(goalBadgeState({ status: 'paused', pauseReason: 'stop' })).toBe('paused')
    expect(goalBadgeState({ status: 'paused', pauseReason: 'awaiting_permission' })).toBe('paused')
    expect(goalBadgeState({ status: 'paused' })).toBe('paused')
  })

  test('terminal states get their own badges', () => {
    expect(goalBadgeState({ status: 'completed' })).toBe('completed')
    expect(goalBadgeState({ status: 'ended' })).toBe('ended')
    expect(isGoalRecordTerminal({ status: 'completed' })).toBe(true)
    expect(isGoalRecordTerminal({ status: 'ended' })).toBe(true)
    expect(isGoalRecordTerminal({ status: 'active' })).toBe(false)
  })

  test('awaiting-user is the emphasized badge with a reply hint', () => {
    const meta = GOAL_BADGE_META[goalBadgeState({ status: 'paused', pauseReason: 'awaiting_user' })]
    expect(meta.emphasized).toBe(true)
    expect(meta.hintKey).toBe('goal.awaitingUserHint')
    // Every other badge stays calm.
    for (const [state, meta] of Object.entries(GOAL_BADGE_META)) {
      if (state !== 'awaiting-user') {
        expect(meta.emphasized).toBeFalsy()
      }
    }
  })
})

describe('describeGoalVerification (journey #5 receipt panel)', () => {
  const receipt: GoalVerificationReceipt = {
    status: 'not_satisfied',
    verifiedAt: 1735689600000,
    criteria: [
      { criterion: 'tests pass', passed: true, evidenceIds: [0] },
      { criterion: 'docs updated', passed: false, evidenceIds: [1, 9] },
    ],
  }

  test('maps criteria to evidence from THIS goal\'s candidate, in receipt order', () => {
    const view = describeGoalVerification(goal({
      status: 'verifying',
      candidate: {
        summary: 'done',
        reportedAt: 1,
        evidence: [
          { kind: 'file', path: 'reports/x.md' },
          { kind: 'message', messageId: 'm-42', note: 'summary reply' },
        ],
      },
      verification: receipt,
    }))
    expect(view?.status).toBe('not_satisfied')
    expect(view?.criteria[0]).toMatchObject({ criterion: 'tests pass', passed: true })
    expect(view?.criteria[0].evidence[0]).toMatchObject({ status: 'known-file', path: 'reports/x.md' })
    expect(view?.criteria[1].evidence[0]).toMatchObject({ status: 'known-message', messageId: 'm-42' })
  })

  test('missing model, missing evidence and out-of-range ids all render as unknown', () => {
    const view = describeGoalVerification(goal({
      status: 'completed',
      verification: { ...receipt, model: undefined },
      candidate: undefined,
    }))
    expect(view?.model).toBeNull()
    // No candidate pool: every evidence slot degrades to unknown, never invented.
    expect(view?.criteria[0].evidence[0]).toMatchObject({ status: 'unknown' })
    // Out-of-range id is unknown too.
    const withPool = describeGoalVerification(goal({
      verification: receipt,
      candidate: { summary: 's', reportedAt: 1, evidence: [{ kind: 'file', path: 'a.md' }] },
    }))
    expect(withPool?.criteria[1].evidence[1]).toMatchObject({ status: 'unknown' })
  })

  test('blank/whitespace model strings count as unknown, real ones survive', () => {
    const base = { status: 'passed' as const, verifiedAt: 1, criteria: [] }
    expect(describeGoalVerification(goal({ verification: { ...base, model: '  ' } }))?.model).toBeNull()
    expect(describeGoalVerification(goal({ verification: { ...base, model: 'glm-5.3-flash' } }))?.model).toBe('glm-5.3-flash')
  })

  test('file evidence without a path and message evidence without an id are unknown', () => {
    const view = describeGoalVerification(goal({
      verification: {
        status: 'passed', verifiedAt: 1,
        criteria: [{ criterion: 'c', passed: true, evidenceIds: [0, 1] }],
      },
      candidate: { summary: 's', reportedAt: 1, evidence: [{ kind: 'file' }, { kind: 'message' }] },
    }))
    expect(view?.criteria[0].evidence[0]).toMatchObject({ status: 'unknown' })
    expect(view?.criteria[0].evidence[1]).toMatchObject({ status: 'unknown' })
  })

  test('a goal without a verification receipt shows no panel at all', () => {
    expect(describeGoalVerification(goal())).toBeNull()
    expect(describeGoalVerification(goal({ verification: undefined }))).toBeNull()
  })

  test('warning / error / executionFactsNote ride through untouched', () => {
    const view = describeGoalVerification(goal({
      verification: {
        status: 'failed', verifiedAt: 1, criteria: [],
        warning: 'record truncated', error: 'verifier timeout', executionFactsNote: 'last turn incomplete',
      },
    }))
    expect(view?.warning).toBe('record truncated')
    expect(view?.error).toBe('verifier timeout')
    expect(view?.executionFactsNote).toBe('last turn incomplete')
  })
})
