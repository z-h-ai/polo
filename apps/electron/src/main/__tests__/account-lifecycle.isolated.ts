import { describe, expect, it, afterEach } from 'bun:test'
import { endAccountProductSpaceRuntimes } from '../account-lifecycle'
import {
  registerProductSpaceExecution,
  resetProductSpaceExecutionRegistryForTests,
} from '@polo-ai/server-core/runtime/product-space-executions'

afterEach(() => {
  // Never leak a registered execution into sibling test files that share
  // this process when run together.
  resetProductSpaceExecutionRegistryForTests()
})

describe('production account-session-ending wiring', () => {
  it('awaits Local App cleanup before resolving and registers nothing as done early', async () => {
    resetProductSpaceExecutionRegistryForTests()
    const events: string[] = []
    let stopAccountResolved = false

    // A prior-account assistant execution that stops (registered path).
    let assistantStopped = false
    registerProductSpaceExecution({
      scope: {
        contractVersion: 1,
        executionId: 'exec-assistant',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'assistant',
      ref: 'session-a',
      isActive: () => !assistantStopped,
      stop: async () => {
        events.push('assistant-stop')
        assistantStopped = true
        return 'stopped'
      },
    })

    // A Local App runtime recovered from a persisted manager: its cleanup is
    // slow, and endAccountProductSpaceRuntimes must not resolve before it
    // finishes.
    const registry = {
      stopAccount: async (accountId: string) => {
        events.push(`local-app-cleanup-start:${accountId}`)
        await new Promise(resolve => setTimeout(resolve, 30))
        stopAccountResolved = true
        events.push('local-app-cleanup-done')
      },
    }

    await endAccountProductSpaceRuntimes('account-a', registry)

    expect(stopAccountResolved).toBe(true)
    expect(events).toEqual([
      'assistant-stop',
      'local-app-cleanup-start:account-a',
      'local-app-cleanup-done',
    ])
  })

  it('propagates Local App cleanup failure so a replacement is refused', async () => {
    resetProductSpaceExecutionRegistryForTests()
    const registry = {
      stopAccount: async () => {
        throw new Error('local app cleanup failed')
      },
    }
    await expect(endAccountProductSpaceRuntimes('account-a', registry))
      .rejects.toThrow('local app cleanup failed')
  })

  it('fails before Local App cleanup when a registered execution cannot be stopped', async () => {
    resetProductSpaceExecutionRegistryForTests()
    const events: string[] = []
    registerProductSpaceExecution({
      scope: {
        contractVersion: 1,
        executionId: 'exec-stuck',
        accountId: 'account-a',
        productSpaceId: 'space-a',
        workspaceId: 'ws-a',
        subject: { kind: 'built_in_app', builtInAppId: 'polo_assistant' },
      } as never,
      kind: 'assistant_session',
      name: 'assistant',
      ref: 'session-a',
      isActive: () => true,
      stop: async () => 'failed',
    })
    const registry = {
      stopAccount: async () => {
        events.push('local-app-cleanup')
      },
    }

    await expect(endAccountProductSpaceRuntimes('account-a', registry))
      .rejects.toThrow('product_space_execution_stop_failed')
    // The Local App registry is never touched after a stop failure — the
    // replacement login fails with account_transition_pending instead.
    expect(events).toEqual([])
  }, 20_000)
})
