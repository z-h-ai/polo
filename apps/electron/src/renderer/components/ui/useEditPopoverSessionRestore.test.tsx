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
type RestoreOutcome = import('./useEditPopoverSessionRestore').EditPopoverRestoreOutcome
/** renderHook's return, re-typed across the dynamic-import boundary. */
type HookRender = { result: { current: HookState }; rerender: (props: HookParams) => void }

const emptyOutcome: RestoreOutcome = { outcome: 'empty' }
const found = (sessionId: string): RestoreOutcome => ({ outcome: 'found', sessionId })

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
    restorePendingSession: async () => emptyOutcome,
    createPopoverSession: async () => 'session-created',
    ...overrides,
  }
}

describe('useEditPopoverSessionRestore (delayed restore vs quick send)', () => {
  it('restoring gate: true while the adoption query is in flight, false once it settles', async () => {
    const deferred = makeDeferred<RestoreOutcome>()
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({ restorePendingSession: () => deferred.promise as Promise<RestoreOutcome> }),
    }) as unknown as HookRender

    expect(result.current.restoring).toBe(true)
    expect(result.current.inlineSessionId).toBeNull()

    await act(async () => {
      deferred.resolve(emptyOutcome)
    })

    await waitFor(() => expect(result.current.restoring).toBe(false))
    expect(result.current.inlineSessionId).toBeNull()
  })

  it('adopts the scoped pending-question session when the restore resolves with a result', async () => {
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({ restorePendingSession: async () => found('session-pending') }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.inlineSessionId).toBe('session-pending'))
    expect(result.current.restoring).toBe(false)
  })

  it('THE RACE: a send during an in-flight restore settles the adoption — the found pending session is adopted, never a created orphan', async () => {
    const restoreDeferred = makeDeferred<RestoreOutcome>()
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

    // The send happens BEFORE the restore query resolves. The send's
    // fail-closed gate runs the authoritative query to a verdict instead of
    // creating blind.
    const sendResult: { sessionId: string | null } = { sessionId: null }
    await act(async () => {
      const sendPromise = result.current.ensureSessionForSend().then(id => {
        sendResult.sessionId = id
      })
      // The scoped lookup resolves FOUND while the send is waiting on it.
      restoreDeferred.resolve(found('session-stale-pending'))
      await sendPromise
    })

    // The pending session is ADOPTED — no orphaning creation happened.
    expect(sendResult.sessionId).toBe('session-stale-pending')
    expect(createCalls).toBe(0)
    expect(result.current.inlineSessionId).toBe('session-stale-pending')
    expect(result.current.restoring).toBe(false)

    // A follow-up send reuses the adopted session (single session, CAS).
    const second: { sessionId: string | null } = { sessionId: null }
    await act(async () => {
      second.sessionId = await result.current.ensureSessionForSend()
    })
    expect(second.sessionId).toBe('session-stale-pending')
    expect(createCalls).toBe(0)
  })

  it('no race: when the restore resolves first, the send reuses the adopted session (no extra creation)', async () => {
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => found('session-adopted'),
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
        restorePendingSession: async () => emptyOutcome,
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

  // A create in flight when the scope changes (workspace A → B) must commit
  // nothing — the stale A session is never adopted, never handed back, and
  // B's messages can never land in it.
  it('stale creation across a workspace A→B switch: commits nothing, hands back null, B creates its own session', async () => {
    const createDeferred = makeDeferred<string>()
    let createCalls = 0
    const createdFor: string[] = []
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        restorePendingSession: async () => emptyOutcome,
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
      restorePendingSession: async () => emptyOutcome,
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

  // Concurrent sends dedupe onto ONE in-flight creation — a double send
  // creates exactly one hidden session.
  it('concurrent double send shares one in-flight creation (single hidden session)', async () => {
    const createDeferred = makeDeferred<string>()
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => emptyOutcome,
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

  // An RPC rejection is TRANSIENT — the restore gate stays closed
  // (restoring true) and the bounded retry adopts once a later attempt finds
  // the pending session.
  it('RPC rejection keeps the gate closed and the bounded retry recovers on a later attempt', async () => {
    let attempts = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => {
          attempts++
          if (attempts === 1) {
            // Hold the FIRST attempt in flight so the closed gate is
            // observable while a transient failure is pending.
            await new Promise(r => setTimeout(r, 40))
            throw new Error('IPC temporarily unavailable (injected)')
          }
          if (attempts === 2) throw new Error('IPC temporarily unavailable (injected)')
          return found('session-recovered')
        },
        backoffMs: () => 1,
      }),
    }) as unknown as HookRender

    // Gate stays closed while the first (slow) attempt is in flight.
    await act(async () => {
      await new Promise(r => setTimeout(r, 10))
    })
    expect(result.current.restoring).toBe(true)
    expect(result.current.inlineSessionId).toBeNull()
    expect(attempts).toBe(1)

    // The bounded retry adopts; the gate releases.
    await waitFor(() => expect(result.current.inlineSessionId).toBe('session-recovered'))
    expect(result.current.restoring).toBe(false)
    expect(attempts).toBe(3)
  })

  it('a transient outcome retries within the bounded budget, then budget exhaustion releases the gate', async () => {
    let attempts = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => {
          attempts++
          if (attempts === 1) {
            // Hold the FIRST attempt in flight so the closed gate is
            // observable while a transient failure is pending.
            await new Promise(r => setTimeout(r, 40))
          }
          return { outcome: 'transient' as const, message: 'session listing failed' }
        },
        backoffMs: () => 1,
      }),
    }) as unknown as HookRender

    // Gate stays closed while the bounded budget is running.
    await act(async () => {
      await new Promise(r => setTimeout(r, 10))
    })
    expect(result.current.restoring).toBe(true)
    expect(attempts).toBe(1)

    // Budget exhaustion releases the disable flag — but the restore is
    // INCONCLUSIVE, so creation stays fail-closed (see the send-gate tests).
    await waitFor(() => expect(result.current.restoring).toBe(false))
    expect(attempts).toBe(3)
    expect(result.current.inlineSessionId).toBeNull()
  })

  it('inconclusive restore: a send runs ONE final authoritative query; still-transient → fail-closed error and NO session creation', async () => {
    let attempts = 0
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => {
          attempts++
          // The bounded restore loop (3 attempts) AND the send's final
          // authoritative query are all transient.
          return { outcome: 'transient' as const, message: 'session listing failed' }
        },
        createPopoverSession: async () => {
          createCalls++
          return 'session-orphan'
        },
        backoffMs: () => 1,
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))
    expect(attempts).toBe(3)

    // The send must NOT silently create a fresh hidden session.
    let sendError: unknown = null
    await act(async () => {
      try {
        await result.current.ensureSessionForSend()
      } catch (error) {
        sendError = error
      }
    })
    expect((sendError as Error)?.name).toBe('EditPopoverRestoreUnavailableError')
    expect(createCalls).toBe(0)
    expect(result.current.inlineSessionId).toBeNull()
    // The final authoritative query ran exactly once (4th attempt overall)
    // and is deduped for concurrent sends.
    expect(attempts).toBe(4)
  })

  it('inconclusive restore: the send’s final authoritative query ADOPTS a found pending session (no creation)', async () => {
    let attempts = 0
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => {
          attempts++
          if (attempts <= 3) return { outcome: 'transient' as const }
          return found('session-late-pending')
        },
        createPopoverSession: async () => {
          createCalls++
          return 'session-orphan'
        },
        backoffMs: () => 1,
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))

    const id: { value: string | null } = { value: null }
    await act(async () => {
      id.value = await result.current.ensureSessionForSend()
    })
    expect(id.value).toBe('session-late-pending')
    expect(result.current.inlineSessionId).toBe('session-late-pending')
    expect(createCalls).toBe(0)
  })

  it('inconclusive restore: the send’s final authoritative query settling empty AUTHORIZES creation; a later send skips the query', async () => {
    let attempts = 0
    let createCalls = 0
    const { result } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        restorePendingSession: async () => {
          attempts++
          if (attempts <= 3) return { outcome: 'transient' as const }
          return emptyOutcome
        },
        createPopoverSession: async () => {
          createCalls++
          return 'session-created'
        },
        backoffMs: () => 1,
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))

    const id: { value: string | null } = { value: null }
    await act(async () => {
      id.value = await result.current.ensureSessionForSend()
    })
    expect(id.value).toBe('session-created')
    expect(createCalls).toBe(1)

    // A second send reuses the session — no extra query, no extra creation.
    const second: { value: string | null } = { value: null }
    await act(async () => {
      second.value = await result.current.ensureSessionForSend()
    })
    expect(second.value).toBe('session-created')
    expect(createCalls).toBe(1)
    expect(attempts).toBe(4)
  })

  it('reopen (scope change) after an inconclusive restore restarts the bounded restore loop', async () => {
    let attempts = 0
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        restorePendingSession: async () => {
          attempts++
          return { outcome: 'transient' as const }
        },
        backoffMs: () => 1,
      }),
    }) as unknown as HookRender

    await waitFor(() => expect(result.current.restoring).toBe(false))
    const attemptsAfterFirstScope = attempts
    expect(attemptsAfterFirstScope).toBe(3)

    // Reopen in workspace B: the bounded loop reruns for the new scope.
    rerender(baseParams({
      workspaceId: 'ws-b',
      restorePendingSession: async () => {
        attempts++
        return emptyOutcome
      },
      backoffMs: () => 1,
    }))
    await waitFor(() => expect(result.current.restoring).toBe(false))
    expect(attempts).toBe(attemptsAfterFirstScope + 1)
    // Authoritative empty for B: creation is authorized for the new scope.
    let created = false
    await act(async () => {
      const id = await result.current.ensureSessionForSend()
      created = id === 'session-created'
    })
    expect(created).toBe(true)
  })

  // The adoption path is also generation-bound — a restore result for the
  // OLD scope must not adopt after the scope changed.
  it('late restore for a superseded scope does not adopt into the new scope', async () => {
    const restoreDeferred = makeDeferred<RestoreOutcome>()
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
      restorePendingSession: async () => emptyOutcome,
    }))
    await act(async () => {
      restoreDeferred.resolve(found('session-old-scope'))
      await new Promise(r => setTimeout(r, 20))
    })

    expect(result.current.inlineSessionId).toBeNull()
    // restoring belongs to the NEW scope's query now (it resolved null).
    await waitFor(() => expect(result.current.restoring).toBe(false))
  })

  // While A's create is still in flight, a send from scope B must NOT reuse
  // A's promise — B starts its own creation and gets its own session; A's
  // late settlement commits nothing.
  it('overlapping window: B sends while A\u2019s create is unsettled — B builds its own session, A\u2019s late result is discarded', async () => {
    const createADeferred = makeDeferred<string>()
    const createdFor: string[] = []
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        restorePendingSession: async () => emptyOutcome,
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
      restorePendingSession: async () => emptyOutcome,
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

  // While A's create is unsettled and the scope switched to B, B's
  // pending-question restore must NOT be blocked by A's in-flight creation —
  // B adopts its pending session.
  it('overlapping window: B adopts its pending session while A\u2019s create is still unsettled', async () => {
    const createADeferred = makeDeferred<string>()
    const { result, rerender } = renderHook((props: HookParams) => useEditPopoverSessionRestore(props), {
      initialProps: baseParams({
        workspaceId: 'ws-a',
        restorePendingSession: async () => emptyOutcome,
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
      restorePendingSession: async () => found('session-b-pending'),
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
