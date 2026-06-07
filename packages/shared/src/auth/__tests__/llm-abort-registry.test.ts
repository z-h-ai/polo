import { describe, expect, it, mock } from 'bun:test'
import {
  getInFlightLlmAbortControllers,
  resetInFlightLlmAbortControllersForTests,
  trackInFlightLlmAbortController,
} from '../llm-abort-registry.ts'

describe('LLM abort registry', () => {
  it('tracks real in-flight LLM AbortControllers for force logout', () => {
    resetInFlightLlmAbortControllersForTests()
    const abort = mock(() => {})
    const controller = { abort }

    const untrack = trackInFlightLlmAbortController(controller)

    for (const tracked of getInFlightLlmAbortControllers()) {
      tracked.abort()
    }
    expect(abort).toHaveBeenCalledTimes(1)

    untrack()
    expect(Array.from(getInFlightLlmAbortControllers())).toHaveLength(0)
  })
})
