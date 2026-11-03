/**
 * POO-177 QUOTA-01 — send-attempt capture on the two real deep-link/action
 * send points of NavigationContext.
 *
 * The attempt must be captured BEFORE the send RPC fires (never guessed from
 * the current default model after a catch), carried opaquely back through the
 * SAME failure callback (optional 4th argument keeps old callers valid), and
 * a late failure from send A must never be attributed to send B. A send
 * stopped by the access latch never fires, so it never captures an attempt.
 *
 * Runs against the REAL NavigationProvider: the action routes are dispatched
 * through the real navigate event, and the bridge (sendMessage /
 * sendDeepLinkActionResult) is a deferred double.
 */
import { describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import { I18nextProvider } from 'react-i18next'
import { i18n, setupI18n } from '@polo-ai/shared/i18n'

setupI18n()
await i18n.changeLanguage('zh-Hans')

const { act, cleanup, render } = await import('@testing-library/react')
const { createElement } = await import('react')
const { NavigationProvider } = await import('../NavigationContext')
const { NAVIGATE_EVENT, navigate } = await import('@/lib/navigate')

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

interface Harness {
  events: Array<[kind: 'capture' | 'send' | 'failure' | 'blocked', string]>
  failures: Array<unknown[]>
  blocked: Array<unknown[]>
  actionResults: Array<Record<string, unknown>>
  sends: Array<unknown[]>
  sendGate: { current: Map<string, ReturnType<typeof deferred<unknown>>> }
}

function mountHarness(overrides: {
  isSendBlocked?: () => boolean
  captureAttempt?: (sessionId: string) => string | undefined
} = {}): Harness {
  const harness: Harness = {
    events: [],
    failures: [],
    blocked: [],
    actionResults: [],
    sends: [],
    sendGate: { current: new Map() },
  }
  const recorded = (kind: Harness['events'][number][0], id: string) => harness.events.push([kind, id])

  window.electronAPI = {
    onDeepLinkNavigate: () => () => {},
    sendMessage: mock(async (sessionId: string) => {
      recorded('send', sessionId)
      harness.sends.push([sessionId])
      const gate = deferred<unknown>()
      harness.sendGate.current.set(sessionId, gate)
      return gate.promise
    }),
    sessionCommand: mock(async () => ({})),
    sendDeepLinkActionResult: mock((result: Record<string, unknown>) => {
      harness.actionResults.push(result)
    }),
  } as unknown as typeof window.electronAPI

  const props = {
    workspaceId: 'ws-1',
    workspaceSlug: 'ws',
    onCreateSession: async () => ({ id: 'session-new' }) as never,
    onApplySendFailure: (...args: unknown[]) => {
      recorded('failure', String(args[0]))
      harness.failures.push(args)
    },
    onApplySendBlocked: (...args: unknown[]) => {
      recorded('blocked', String(args[0]))
      harness.blocked.push(args)
    },
    isSendBlocked: overrides.isSendBlocked ?? (() => false),
    onCaptureSendAttempt: overrides.captureAttempt ?? ((sessionId: string) => {
      recorded('capture', sessionId)
      return `attempt-${harness.events.filter(([kind]) => kind === 'capture').length}`
    }),
    children: null,
  }
  render(createElement(I18nextProvider, { i18n, children: createElement(NavigationProvider, props) }))
  return harness
}

async function dispatchAction(route: string) {
  act(() => {
    void navigate(route as never)
  })
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

const flush = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })

describe('deep-link/action send attempt capture (POO-177)', () => {
  it('captures the send-message attempt before the RPC and brings it back on failure', async () => {
    const harness = mountHarness()
    await dispatchAction('action/send-message/session-a?input=hello&callbackId=cb-1')
    expect(harness.events).toEqual([
      ['capture', 'session-a'],
      ['send', 'session-a'],
    ])

    const gate = harness.sendGate.current.get('session-a')!
    const failure = Object.assign(new Error('insufficient credit'), { status: 402 })
    await act(async () => {
      gate.reject(failure)
      await flush()
    })

    expect(harness.failures).toEqual([['session-a', failure, 'hello', 'attempt-1']])
    // exactly-once action callback with an error code; draft text preserved.
    expect(harness.actionResults.length).toBe(1)
    expect((harness.actionResults[0] as { callbackId?: string }).callbackId).toBe('cb-1')
    expect((harness.actionResults[0] as { error?: { code?: string } }).error?.code).toBe('rate_limited')
    cleanup()
  })

  it('returns an unknown attempt when capture yields nothing', async () => {
    const harness = mountHarness({ captureAttempt: () => undefined })
    await dispatchAction('action/send-message/session-a?input=hello&callbackId=cb-1')
    const gate = harness.sendGate.current.get('session-a')!
    await act(async () => {
      gate.reject(new Error('boom'))
      await flush()
    })

    expect(harness.failures.length).toBe(1)
    expect(harness.failures[0]![3]).toBeUndefined()
    cleanup()
  })

  it('attributes a late failure to its own send, never to the newer one', async () => {
    const harness = mountHarness()
    await dispatchAction('action/send-message/session-a?input=first&callbackId=cb-1')
    await dispatchAction('action/send-message/session-b?input=second&callbackId=cb-2')

    // B settles first; A rejects later and must still carry A's attempt.
    await act(async () => {
      harness.sendGate.current.get('session-b')!.resolve({ ok: true })
      await flush()
    })
    expect(harness.failures.length).toBe(0)

    await act(async () => {
      harness.sendGate.current.get('session-a')!.reject(new Error('late billing block'))
      await flush()
    })

    expect(harness.failures).toEqual([['session-a', expect.any(Error), 'first', 'attempt-1']])
    expect(harness.events).toEqual([
      ['capture', 'session-a'],
      ['send', 'session-a'],
      ['capture', 'session-b'],
      ['send', 'session-b'],
      ['failure', 'session-a'],
    ])
    cleanup()
  })

  it('never captures an attempt for a send the latch stopped before firing', async () => {
    const harness = mountHarness({ isSendBlocked: () => true })
    await dispatchAction('action/send-message/session-a?input=hello&callbackId=cb-1')

    expect(harness.sends.length).toBe(0)
    expect(harness.events.filter(([kind]) => kind === 'capture')).toEqual([])
    expect(harness.blocked).toEqual([['session-a', 'hello']])
    cleanup()
  })

  it('captures the new-session auto-send attempt before its RPC fires', async () => {
    const harness = mountHarness()
    await dispatchAction('action/new-session?input=hello&send=true&callbackId=cb-1')
    // The auto-send runs from a setTimeout inside the action handler.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 150))
    })

    expect(harness.events.slice(0, 2)).toEqual([
      ['capture', 'session-new'],
      ['send', 'session-new'],
    ])
    const gate = harness.sendGate.current.get('session-new')!
    await act(async () => {
      gate.reject(Object.assign(new Error('no credit'), { status: 402 }))
      await flush()
    })
    expect(harness.failures).toEqual([['session-new', expect.any(Error), 'hello', 'attempt-1']])
    cleanup()
  })
})
