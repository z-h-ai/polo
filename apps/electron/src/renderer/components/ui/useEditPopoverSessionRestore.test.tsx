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
})
