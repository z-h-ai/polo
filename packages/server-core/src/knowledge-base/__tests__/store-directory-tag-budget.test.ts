import { afterEach, describe, expect, it } from 'bun:test'
import {
  KB_DIRECTORY_TAG_WINDOW_MS,
  KB_SERVICE_UNAVAILABLE_MESSAGE,
  KbStoreError,
  resetKbDirectoryTagRetryDelayForTests,
  resetKbDirectoryTagWindowForTests,
  setKbDirectoryTagRetryDelayForTests,
  setKbDirectoryTagWindowForTests,
  writeKbDirectoryTagsVerified,
  type KbDirectoryTagWriteHost,
  type KbRemoteAuditRecord,
} from '../store'

/**
 * The budget discipline of the verified directory-tag loop (`raceRemainingBudget`,
 * review round N1 + the P2 residual): the window bounds every REQUEST, a step is
 * only started while the window can still answer it, and a dispatched step never
 * answers to nobody. These are unit-level pins over a controllable host — the
 * RPC-layer window tests in
 * `handlers/rpc/__tests__/knowledge-base-openviking.test.ts` cover the same loop
 * through the real transport.
 */

type RecordedEntry = Parameters<KbRemoteAuditRecord>[0]

/** Burns real wall clock WITHOUT yielding — a synchronous fs/gate spend. */
function burnSync(ms: number): void {
  const until = Date.now() + ms
  while (Date.now() < until) { /* spin */ }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A promise that rejects `ms` from now — a transport failure arriving late. */
function rejectAfter(ms: number, error: Error): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(error), ms)
  })
}

function resolveAfter<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => {
    setTimeout(() => resolve(value), ms)
  })
}

/**
 * Captures the process-level rejections a leaked step promise would raise.
 * Installed only inside a test and always disposed, so an orphan from a
 * broken shape is SEEN here and fails the assertion instead of the runner.
 */
function captureUnhandledRejections(): { seen: () => unknown[]; dispose: () => void } {
  const seen: unknown[] = []
  const onRejected = (reason: unknown): void => { seen.push(reason) }
  process.on('unhandledRejection', onRejected)
  return {
    seen: () => seen,
    dispose: () => { process.off('unhandledRejection', onRejected) },
  }
}

/** The loop's own audit pair, captured through its host sink. */
function resultDetailOf(audit: RecordedEntry[], uri: string): Record<string, unknown> | undefined {
  return audit.find(entry => entry.action === 'remote.directory_tags.result' && entry.target === uri)?.detail
}

/** A host whose write never verifies — the loop must run to its exhaustion. */
function neverVerifyingHost(
  audit: RecordedEntry[],
  hooks: Partial<Pick<KbDirectoryTagWriteHost, 'beforeWrite' | 'write' | 'read' | 'wait'>>,
): KbDirectoryTagWriteHost {
  return {
    record: entry => { audit.push(entry) },
    actor: 'actor-budget-test',
    beforeWrite: hooks.beforeWrite,
    write: hooks.write ?? (async () => {}),
    read: hooks.read ?? (async () => null),
    wait: hooks.wait ?? (async () => {}),
  }
}

describe('verified directory-tag budget (N1 + P2 residual)', () => {
  afterEach(() => {
    resetKbDirectoryTagWindowForTests()
    resetKbDirectoryTagRetryDelayForTests()
  })

  it('refuses the attempt before dispatch when synchronous work has spent the window (P2 residual)', async () => {
    // The eager shape built the write promise FIRST and read the remaining
    // budget afterwards: synchronous spend ahead of the request (the
    // per-attempt audit write at `appendAudit`, a slow writability gate)
    // could push the budget below zero between the dispatch and the race, so
    // the race answered `null` without ever touching an already-running
    // promise — the request had left, and its later rejection answered to
    // nobody (one unhandledRejection per hit). Now the budget is read BEFORE
    // anything is built: a spent window refuses the attempt here, dispatches
    // nothing, and leaves no orphan behind.
    const URI = 'viking://resources/Frozen-1'
    setKbDirectoryTagWindowForTests(5)
    setKbDirectoryTagRetryDelayForTests(1_000)
    let dispatched = 0
    const audit: RecordedEntry[] = []
    const lateFailure = new Error('set_tags transport failed after the window closed')
    const host = neverVerifyingHost(audit, {
      beforeWrite: () => burnSync(25),
      write: () => {
        dispatched += 1
        return rejectAfter(20, lateFailure)
      },
    })
    const capture = captureUnhandledRejections()
    try {
      await expect(writeKbDirectoryTagsVerified(host, URI, () => false))
        .rejects.toMatchObject({ code: 'kb_service_unavailable', message: KB_SERVICE_UNAVAILABLE_MESSAGE })
      // Nothing was dispatched: no request, no orphaned promise.
      expect(dispatched).toBe(0)
      // A would-be orphan had its whole lateness to reject into — none did.
      await sleep(60)
      expect(capture.seen()).toEqual([])
      // No request left, so the run reports zero attempts, not one.
      expect(resultDetailOf(audit, URI)).toMatchObject({ outcome: 'failed', attempts: 0 })
    } finally {
      capture.dispose()
    }
  })

  it('keeps a race loser late rejection silent instead of leaking it (P2 residual)', async () => {
    // A dispatched step that loses the race is never aborted — the transport
    // has no cancellation — so it still settles, possibly with a REJECTION,
    // long after the loop gave up on it. The loser branch must swallow that
    // late failure: the loop already answered the exhausted error, and the
    // loser's own audit pair records the real outcome.
    const URI = 'viking://resources/Slow-1'
    setKbDirectoryTagWindowForTests(20)
    setKbDirectoryTagRetryDelayForTests(1_000)
    const audit: RecordedEntry[] = []
    let dispatched = 0
    const host = neverVerifyingHost(audit, {
      write: () => {
        dispatched += 1
        return rejectAfter(60, new Error('the write outlived the window and then failed'))
      },
    })
    const capture = captureUnhandledRejections()
    try {
      await expect(writeKbDirectoryTagsVerified(host, URI, () => false))
        .rejects.toMatchObject({ code: 'kb_service_unavailable' })
      // The attempt IS counted — the request left before the clock won.
      expect(resultDetailOf(audit, URI)).toMatchObject({ outcome: 'failed', attempts: 1 })
      expect(dispatched).toBe(1)
      // The loser rejects at ~60ms, well inside this settle window.
      await sleep(90)
      expect(capture.seen()).toEqual([])
    } finally {
      capture.dispose()
    }
  })

  it('answers the exhausted error when one request outlasts the window (review round N1)', async () => {
    // The unit-level shape of the RPC-layer pin: a write that RESOLVES past
    // the budget is a failed attempt, not a verified success — and its late
    // resolution leaks nothing.
    const URI = 'viking://resources/Raced-1'
    setKbDirectoryTagWindowForTests(30)
    setKbDirectoryTagRetryDelayForTests(1_000)
    const audit: RecordedEntry[] = []
    let dispatched = 0
    const host = neverVerifyingHost(audit, {
      write: () => {
        dispatched += 1
        return resolveAfter(80, undefined)
      },
    })
    const capture = captureUnhandledRejections()
    try {
      await expect(writeKbDirectoryTagsVerified(host, URI, () => false))
        .rejects.toMatchObject({ code: 'kb_service_unavailable' })
      expect(resultDetailOf(audit, URI)).toMatchObject({ outcome: 'failed', attempts: 1 })
      expect(dispatched).toBe(1)
      await sleep(100)
      expect(capture.seen()).toEqual([])
    } finally {
      capture.dispose()
    }
  })

  it('propagates a write refusal that lands inside the window unchanged', async () => {
    // A transport failure the window could still answer is the step's own
    // failure: it must surface as-is (coded, audited) — never be remapped
    // into an exhaustion the window did not reach, and never be swallowed by
    // the loser branch.
    const URI = 'viking://resources/Forbidden-1'
    setKbDirectoryTagWindowForTests(4_000)
    setKbDirectoryTagRetryDelayForTests(1_000)
    const audit: RecordedEntry[] = []
    let dispatched = 0
    const refusal = new KbStoreError(
      'kb_service_unavailable',
      KB_SERVICE_UNAVAILABLE_MESSAGE,
      `set_tags ${URI} failed: 403`,
    )
    const host = neverVerifyingHost(audit, {
      write: () => {
        dispatched += 1
        return Promise.reject(refusal)
      },
    })
    const capture = captureUnhandledRejections()
    try {
      await expect(writeKbDirectoryTagsVerified(host, URI, () => false)).rejects.toBe(refusal)
      // One attempt, no retry: a hard refusal is not poll-able.
      expect(dispatched).toBe(1)
      expect(resultDetailOf(audit, URI)).toMatchObject({ outcome: 'failed', attempts: 1 })
      await sleep(20)
      expect(capture.seen()).toEqual([])
    } finally {
      capture.dispose()
    }
  })

  it('lands a first-attempt verified write and reports the success detail', async () => {
    const URI = 'viking://resources/Sticks-1'
    setKbDirectoryTagWindowForTests(KB_DIRECTORY_TAG_WINDOW_MS)
    setKbDirectoryTagRetryDelayForTests(1_000)
    const audit: RecordedEntry[] = []
    let writes = 0
    let reads = 0
    const host: KbDirectoryTagWriteHost = {
      record: entry => { audit.push(entry) },
      actor: 'actor-budget-test',
      write: async () => { writes += 1 },
      read: async () => {
        reads += 1
        return { 'collection=stick-1': '' }
      },
      wait: async () => {},
    }
    await expect(writeKbDirectoryTagsVerified(host, URI, tags => 'collection=stick-1' in tags))
      .resolves.toBeUndefined()
    expect(writes).toBe(1)
    expect(reads).toBe(1)
    expect(resultDetailOf(audit, URI)).toMatchObject({ outcome: 'success', attempts: 1 })
  })
})
