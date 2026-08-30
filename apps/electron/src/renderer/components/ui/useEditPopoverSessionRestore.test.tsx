import { describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// DOM first, then component/hook imports via dynamic import (same pattern as
// QuestionRequest.test.tsx — no mock.module, keeps the process clean for the
// full-suite shared-process run).
//
// IMPORTANT: pin a macOS userAgent. happy-dom defaults to a Windows one, so
// `navigator.platform` would report Win32 and flip `isWindows`/`PATH_SEP` in
// @/lib/platform for EVERY test file that runs after this one in the shared
// bun process — silently breaking path-basename assertions elsewhere.
if (typeof window === 'undefined') {
  GlobalRegistrator.register({
    settings: {
      navigator: {
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
    },
  })
}

const { renderHook, act, waitFor } = await import('@testing-library/react')
const { useEditPopoverSessionRestore } = await import('./useEditPopoverSessionRestore')

type HookParams = import('./useEditPopoverSessionRestore').EditPopoverSessionRestoreParams
type HookState = import('./useEditPopoverSessionRestore').EditPopoverSessionRestoreState
/** renderHook's return, re-typed across the dynamic-import boundary. */
type HookRender = { result: { current: HookState }; rerender: (props: HookParams) => void }

function makeDeferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function baseParams(overrides: Partial<HookParams> = {}): HookParams {
  return {
    open: true,
    workspaceId: 'ws-1',
    popoverOwnerId: 'Permissions::/ws/a/config.json',
    restorePendingSession: async () => null,
    createPopoverSession: async () => 'session-created',
    ...overrides,
  }
}

describe('useEditPopoverSessionRestore (delayed restore vs quick send)', () => {
  it('restoring gate: true while the adoption query is in flight, false once it settles', async () => {
    const deferred = makeDeferred<{ sessionId: string } | null>()
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({ restorePendingSession: () => deferred.promise }),
    }) as unknown as HookRender

    expect(result.current.restoring).toBe(true)
    expect(result.current.inlineSessionId).toBeNull()

    await act(async () => {
      deferred.resolve(null)
    })

    await waitFor(() => expect(result.current.restoring).toBe(false))
    expect(result.current.inlineSessionId).toBeNull()
  })

  it('adopts the scoped pending-question session when the restore resolves with a result', async () => {
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({ restorePendingSession: async () => ({ sessionId: 'session-pending' }) }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.inlineSessionId).toBe('session-pending'))
    expect(result.current.restoring).toBe(false)
  })

  it('THE RACE: a quick send during the restore window wins — a late restore result is discarded (CAS), the created session is not stranded', async () => {
    const restoreDeferred = makeDeferred<{ sessionId: string } | null>()
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: () => restoreDeferred.promise,
        createPopoverSession: async () => {
          createCalls++
          return 'session-created-late-restore'
        },
      }),
    }) as unknown as HookRender

    // The send happens BEFORE the restore query resolves.
    const sendResult: { sessionId: string | null } = { sessionId: null }
    await act(async () => {
      const sendPromise = result.current.ensureSessionForSend().then(id => {
        sendResult.sessionId = id
      })
      // Reserve happens synchronously; the restore now resolves LATE.
      restoreDeferred.resolve({ sessionId: 'session-stale-pending' })
      await sendPromise
    })

    expect(sendResult.sessionId).toBe('session-created-late-restore')
    expect(createCalls).toBe(1)

    // Let the late adoption attempt flush — it must NOT overwrite the session
    // the user's send created.
    await act(async () => {
      await new Promise(r => setTimeout(r, 20))
    })
    expect(result.current.inlineSessionId).toBe('session-created-late-restore')
    expect(result.current.restoring).toBe(false)
  })

  it('no race: when the restore resolves first, the send reuses the adopted session (no extra creation)', async () => {
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => ({ sessionId: 'session-adopted' }),
        createPopoverSession: async () => {
          createCalls++
          return 'session-created'
        },
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.inlineSessionId).toBe('session-adopted'))

    const sendResult: { sessionId: string | null } = { sessionId: null }
    await act(async () => {
      sendResult.sessionId = await result.current.ensureSessionForSend()
    })
    expect(sendResult.sessionId).toBe('session-adopted')
    expect(createCalls).toBe(0)
  })

  it('a failed creation releases the slot so a later open can still adopt', async () => {
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => null,
        createPopoverSession: () => {
          createCalls++
          throw new Error('backend init failed (injected)')
        },
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))

    await act(async () => {
      await expect(result.current.ensureSessionForSend()).rejects.toThrow('backend init failed (injected)')
    })
    expect(createCalls).toBe(1)
    expect(result.current.inlineSessionId).toBeNull()
  })

  // Round 3, issue 4: a create in flight when the scope changes (workspace
  // A → B) must commit nothing — the stale A session is never adopted, never
  // handed back, and B's messages can never land in it.
  it('stale creation across a workspace A→B switch: commits nothing, hands back null, B creates its own session', async () => {
    const createDeferred = makeDeferred<string>()
    let createCalls = 0
    const createdFor: string[] = []
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        restorePendingSession: async () => null,
        createPopoverSession: () => {
          createCalls++
          createdFor.push(`ws-${createCalls}`)
          return createDeferred.promise
        },
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))

    // Send in scope A — the creation is in flight when the scope switches.
    const staleResult: { id: string | null } = { id: null }
    await act(async () => {
      void result.current.ensureSessionForSend().then(id => {
        staleResult.id = id
      })
    })
    // Switch scope — its effect bumps the generation BEFORE the A create
    // resolves (separate act scope guarantees the passive effect has flushed).
    rerender(baseParams({
      workspaceId: 'ws-b',
      restorePendingSession: async () => null,
      createPopoverSession: async () => {
        createCalls++
        createdFor.push(`ws-${createCalls}`)
        return 'session-b'
      },
    }))
    await act(async () => {
      createDeferred.resolve('session-a')
      await new Promise(r => setTimeout(r, 20))
    })

    // The stale A creation handed back nothing and committed nothing.
    expect(staleResult.id).toBeNull()
    expect(result.current.inlineSessionId).toBeNull()

    // B's own send creates B's session — A's late result cannot take over.
    const bResult: { id: string | null } = { id: null }
    await act(async () => {
      bResult.id = await result.current.ensureSessionForSend()
    })
    expect(bResult.id).toBe('session-b')
    expect(result.current.inlineSessionId).toBe('session-b')
    expect(createdFor).toEqual(['ws-1', 'ws-2'])
  })

  // Round 3, issue 4: concurrent sends dedupe onto ONE in-flight creation —
  // a double send creates exactly one hidden session.
  it('concurrent double send shares one in-flight creation (single hidden session)', async () => {
    const createDeferred = makeDeferred<string>()
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => null,
        createPopoverSession: () => {
          createCalls++
          return createDeferred.promise
        },
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))

    const first: { id: string | null } = { id: null }
    const second: { id: string | null } = { id: null }
    await act(async () => {
      const p1 = result.current.ensureSessionForSend().then(id => {
        first.id = id
      })
      const p2 = result.current.ensureSessionForSend().then(id => {
        second.id = id
      })
      createDeferred.resolve('session-single')
      await Promise.all([p1, p2])
    })

    expect(createCalls).toBe(1)
    expect(first.id).toBe('session-single')
    expect(second.id).toBe('session-single')
    expect(result.current.inlineSessionId).toBe('session-single')
  })

  // Round 3, issue 4: the adoption path is also generation-bound — a restore
  // result for the OLD scope must not adopt after the scope changed.
  it('late restore for a superseded scope does not adopt into the new scope', async () => {
    const restoreDeferred = makeDeferred<{ sessionId: string } | null>()
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        popoverOwnerId: 'owner-a',
        restorePendingSession: () => restoreDeferred.promise,
      }),
    }) as unknown as HookRender

    expect(result.current.restoring).toBe(true)

    // Switch scope BEFORE the restore resolves.
    rerender(baseParams({
      workspaceId: 'ws-b',
      popoverOwnerId: 'owner-b',
      restorePendingSession: async () => null,
    }))
    await act(async () => {
      restoreDeferred.resolve({ sessionId: 'session-old-scope' })
      await new Promise(r => setTimeout(r, 20))
    })

    expect(result.current.inlineSessionId).toBeNull()
    // restoring belongs to the NEW scope's query now (it resolved null).
    await waitFor(() => expect(result.current.restoring).toBe(false))
  })

  // Round 4, issue 1: while A's create is still in flight, a send from scope
  // B must NOT reuse A's promise — B starts its own creation and gets its own
  // session; A's late settlement commits nothing.
  it('overlapping window: B sends while A\u2019s create is unsettled — B builds its own session, A\u2019s late result is discarded', async () => {
    const createADeferred = makeDeferred<string>()
    const createdFor: string[] = []
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        restorePendingSession: async () => null,
        createPopoverSession: () => {
          createdFor.push('a')
          return createADeferred.promise
        },
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))

    // Scope A send — creation in flight.
    const aResult: { id: string | null } = { id: null }
    await act(async () => {
      void result.current.ensureSessionForSend().then(id => {
        aResult.id = id
      })
    })

    // Switch to scope B and send IMMEDIATELY (A still unsettled).
    rerender(baseParams({
      workspaceId: 'ws-b',
      restorePendingSession: async () => null,
      createPopoverSession: async () => {
        createdFor.push('b')
        return 'session-b'
      },
    }))
    await act(async () => {})

    const bResult: { id: string | null } = { id: null }
    await act(async () => {
      bResult.id = await result.current.ensureSessionForSend()
    })

    // B must have started its OWN creation — not inherited A's promise.
    expect(createdFor).toEqual(['a', 'b'])
    expect(bResult.id).toBe('session-b')
    expect(result.current.inlineSessionId).toBe('session-b')

    // A settles late: hands back nothing, commits nothing into B's scope.
    await act(async () => {
      createADeferred.resolve('session-a')
      await new Promise(r => setTimeout(r, 20))
    })
    expect(aResult.id).toBeNull()
    expect(result.current.inlineSessionId).toBe('session-b')
  })

  // Round 4, issue 1: while A's create is unsettled and the scope switched
  // to B, B's pending-question restore must NOT be blocked by A's in-flight
  // creation — B adopts its pending session.
  it('overlapping window: B adopts its pending session while A\u2019s create is still unsettled', async () => {
    const createADeferred = makeDeferred<string>()
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        restorePendingSession: async () => null,
        createPopoverSession: () => createADeferred.promise,
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))

    // Scope A send — creation in flight.
    await act(async () => {
      void result.current.ensureSessionForSend()
    })

    // Switch to scope B whose restore has a pending session.
    rerender(baseParams({
      workspaceId: 'ws-b',
      restorePendingSession: async () => ({ sessionId: 'session-b-pending' }),
      createPopoverSession: async () => 'session-b-created',
    }))
    await act(async () => {
      await new Promise(r => setTimeout(r, 20))
    })

    // B's restore won the adoption race (B has not sent yet) — A's stale
    // in-flight creation did not block it.
    expect(result.current.inlineSessionId).toBe('session-b-pending')

    // A settles late: commits nothing into B's scope.
    await act(async () => {
      createADeferred.resolve('session-a')
      await new Promise(r => setTimeout(r, 20))
    })
    expect(result.current.inlineSessionId).toBe('session-b-pending')
  })
})
