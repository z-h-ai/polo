import { describe, expect, it } from 'bun:test'
import { runNonCriticalTerminalOnboarding } from '../startup-continuation'

describe('main startup continuation after terminal onboarding', () => {
  it('runs all later initialization steps when onboarding unexpectedly throws', async () => {
    const diagnostic = new Error('raw onboarding diagnostic')
    const logged: unknown[] = []
    const steps: string[] = []

    await runNonCriticalTerminalOnboarding(
      async () => {
        throw diagnostic
      },
      error => logged.push(error),
    )

    for (const step of [
      'credential-health',
      'power',
      'sentry',
      'update',
      'deep-link',
    ]) {
      steps.push(step)
    }

    expect(logged).toEqual([diagnostic])
    expect(steps).toEqual([
      'credential-health',
      'power',
      'sentry',
      'update',
      'deep-link',
    ])
  })
})
