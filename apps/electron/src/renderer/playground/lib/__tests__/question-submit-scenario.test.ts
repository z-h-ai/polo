/**
 * QuestionSubmitScenarioRunner tests (review round 5, issue #3).
 *
 * Covers the deterministic Playground question behaviors and the required
 * error → normal → error sequence: after the scenario changes the attempt
 * counter resets, so a NEW error scenario rejects on its first submit and
 * succeeds on retry.
 */

import { describe, expect, it } from 'bun:test'
import { QuestionSubmitScenarioRunner } from '../question-submit-scenario'

function settlesWithin(promise: void | Promise<void>, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    void Promise.resolve(promise).then(
      () => { settled = true; resolve(true) },
      () => { settled = true; resolve(true) },
    )
    setTimeout(() => { if (!settled) resolve(false) }, ms)
  })
}

function rejectsWithin(promise: void | Promise<void>, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    void Promise.resolve(promise).then(
      () => { if (!done) { done = true; resolve(false) } },
      () => { if (!done) { done = true; resolve(true) } },
    )
    setTimeout(() => { if (!done) resolve(false) }, ms)
  })
}

describe('QuestionSubmitScenarioRunner', () => {
  it('normal: resolves immediately', async () => {
    const runner = new QuestionSubmitScenarioRunner('normal')
    expect(await settlesWithin(runner.handle({}), 20)).toBe(true)
  })

  it('submitting: never settles (deterministic stuck-submitting state)', async () => {
    const runner = new QuestionSubmitScenarioRunner('submitting')
    expect(await settlesWithin(runner.handle({}), 80)).toBe(false)
  })

  it('error: first submit rejects after the simulated delay, retry succeeds', async () => {
    const runner = new QuestionSubmitScenarioRunner('error')
    expect(await rejectsWithin(runner.handle({}), 600)).toBe(true)
    expect(await settlesWithin(runner.handle({}), 50)).toBe(true)
  })

  it('error → normal → error: the new error scenario rejects on its FIRST submit again', async () => {
    // Old defect: the attempt counter lived in a parent ref and survived the
    // scenario switch, so the second Error run's first submit "succeeded".
    const runner = new QuestionSubmitScenarioRunner('error')
    expect(await rejectsWithin(runner.handle({}), 600)).toBe(true)
    expect(await settlesWithin(runner.handle({}), 50)).toBe(true)

    // Scenario switches to normal — fresh runner (registry recreates on change)
    const normalRunner = new QuestionSubmitScenarioRunner('normal')
    expect(await settlesWithin(normalRunner.handle({}), 20)).toBe(true)

    // Scenario switches back to error — a FRESH runner must reject first
    const errorRunner = new QuestionSubmitScenarioRunner('error')
    expect(await rejectsWithin(errorRunner.handle({}), 600)).toBe(true)
    expect(await settlesWithin(errorRunner.handle({}), 50)).toBe(true)
  })

  it('reset() restores first-submit rejection semantics without a new runner', async () => {
    const runner = new QuestionSubmitScenarioRunner('error')
    expect(await rejectsWithin(runner.handle({}), 600)).toBe(true)
    expect(await settlesWithin(runner.handle({}), 50)).toBe(true)

    runner.reset()
    expect(await rejectsWithin(runner.handle({}), 600)).toBe(true)
  })
})
