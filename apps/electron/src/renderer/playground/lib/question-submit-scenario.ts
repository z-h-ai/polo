/**
 * Deterministic question-submit behaviors for the Playground.
 *
 * Extracted from registry/chat.tsx so the scenario semantics (including
 * attempt-count reset on scenario change) are unit-testable:
 * - 'normal': resolves immediately (no error, no blocking)
 * - 'submitting': NEVER settles — deterministic stuck-submitting state
 * - 'error': first submit rejects (transient_failure — the component keeps
 *   selections and shows a retryable error), retry succeeds
 */

export type QuestionSubmitScenario = 'normal' | 'submitting' | 'error'

const ERROR_DELAY_MS = 300

export class QuestionSubmitScenarioRunner {
  private attempts = 0

  constructor(private scenario: QuestionSubmitScenario) {}

  get scenarioValue(): QuestionSubmitScenario {
    return this.scenario
  }

  /** Reset the attempt counter — called when the scenario or input mode changes. */
  reset(): void {
    this.attempts = 0
  }

  /** Handle a structured question response according to the scenario. */
  handle(_response: unknown): void | Promise<void> {
    if (this.scenario === 'submitting') {
      // Never settles: deterministic stuck-submitting state.
      return new Promise<void>(() => {})
    }

    if (this.scenario === 'error') {
      this.attempts += 1
      if (this.attempts === 1) {
        return new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error('Simulated transient failure — retry to succeed')), ERROR_DELAY_MS)
        })
      }
      return Promise.resolve()
    }

    return undefined
  }
}
