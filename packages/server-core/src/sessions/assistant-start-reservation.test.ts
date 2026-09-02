import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager, createManagedSession } from './SessionManager.ts'
import type { SessionStorage } from '@polo-ai/shared/sessions/session-storage.ts'
import {
  listRegisteredProductSpaceExecutions,
  resetProductSpaceExecutionRegistryForTests,
  revokeRuntimeProductSpaceFence,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  stopRegisteredProductSpaceExecutionsForAccount,
} from '../runtime/product-space-executions.ts'
import {
  beginAccountTransition,
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../handlers/rpc/trusted-product-space-account.ts'
import { resetAssistantStartReservationsForTests } from '../runtime/assistant-executions.ts'

// R30-B: the Assistant start reservation must survive — or be invalidated
// by — an account replacement regardless of whether the replacement lands
// before, during or after the send bootstrap. No processing session agent
// may ever survive without a registered ProductSpace execution.

const accountId = 'account-a'
const otherAccountId = 'account-b'
const personalId = 'space-personal'

describe('assistant start reservation versus account replacement (R30-B)', () => {
  let tmpRoot: string
  let sm: SessionManager

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'sm-reservation-'))
    sm = new SessionManager()
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    setTrustedProductSpaceAccountProvider(async () => accountId)
    setSyncTrustedProductSpaceAccountId(accountId)
    setRuntimeActiveProductSpace(personalId)
    setRuntimeActiveProductSpaceAccount(accountId)
  })

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  function buildSession(id: string): ReturnType<typeof createManagedSession> {
    const workspace = {
      id: 'ws_test',
      name: 'Test Workspace',
      rootPath: tmpRoot,
      createdAt: Date.now(),
    }
    const managed = createManagedSession(
      { id, name: 'reservation test' },
      workspace as never,
      { messagesLoaded: true },
    )
    managed.productSpaceId = personalId
    ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(id, managed)
    return managed
  }

  /** Gates the FIRST flushSession of one session: the send parks after its
   * registration and before the transition to processing (bootstrap). */
  function gateFirstFlush(sessionId: string): { release: () => void; gated: Promise<void> } {
    let release!: () => void
    const gated = new Promise<void>(resolve => { release = () => resolve() })
    const real = (sm as unknown as { sessionStorage: SessionStorage }).sessionStorage
    let gatedCount = 0
    const storage = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'flush') {
          return (id: string) => {
            if (id === sessionId && gatedCount === 0) {
              gatedCount += 1
              return gated
            }
            return real.flush(id)
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    ;(sm as unknown as { sessionStorage: SessionStorage }).sessionStorage = storage
    return { release, gated }
  }

  function registeredAssistantRecords(): number {
    return listRegisteredProductSpaceExecutions().filter(
      execution => execution.kind === 'assistant_session',
    ).length
  }

  it('replacement during bootstrap cancels the reservation and the send fails closed before processing', async () => {
    const managed = buildSession('reservation-during')
    const { release } = gateFirstFlush('reservation-during')

    const sending = sm.sendMessage('reservation-during', 'hello')
    // The send rejects only after the bootstrap resumes (the assertions
    // below await it); keep bun from flagging the transient unhandled
    // rejection while cleanup runs first.
    sending.catch(() => {})
    // The send registered its execution with a live reservation and is now
    // parked inside the bootstrap flush.
    for (let i = 0; i < 300 && registeredAssistantRecords() === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(registeredAssistantRecords()).toBe(1)
    expect(managed.isProcessing).toBe(false)

    // Account replacement cleanup runs DURING bootstrap: the live
    // reservation keeps the record visible and active, so cleanup stops it
    // (cancelling the reservation) and unregisters it.
    const cleanup = await stopRegisteredProductSpaceExecutionsForAccount(accountId)
    expect(cleanup.ok).toBe(true)
    await revokeRuntimeProductSpaceFence()
    expect(registeredAssistantRecords()).toBe(0)

    // The bootstrap resumes: the pre-processing CAS must refuse the stale
    // reservation — no processing session agent may start unregistered.
    release()
    await expect(sending).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')
    expect(managed.isProcessing).toBe(false)
    expect(registeredAssistantRecords()).toBe(0)
  })

  it('replacement before registration refuses the whole send with nothing registered', async () => {
    const managed = buildSession('reservation-before')
    // Park the send BEFORE its registration: the account provider is gated.
    let releaseProvider!: () => void
    const gatedProvider = new Promise<string | null>(resolve => { releaseProvider = () => resolve(accountId) })
    setTrustedProductSpaceAccountProvider(() => gatedProvider)

    const sending = sm.sendMessage('reservation-before', 'hello')
    sending.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 25))

    // The replacement begins and completes its cleanup: nothing was
    // registered yet, the epoch advances and the fence is revoked.
    beginAccountTransition()
    const cleanup = await stopRegisteredProductSpaceExecutionsForAccount(accountId)
    expect(cleanup.ok).toBe(true)
    await revokeRuntimeProductSpaceFence()

    // The send's account resolution and gate capture land after the
    // transition: the null fence refuses the registration critical section.
    releaseProvider()
    await expect(sending).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')
    expect(managed.isProcessing).toBe(false)
    expect(registeredAssistantRecords()).toBe(0)
  })

  /** Gates the FIRST flushSession of one session into a REJECTION: the send
   * fails inside its bootstrap persistence (R31-4). */
  function rejectFirstFlush(sessionId: string): void {
    const real = (sm as unknown as { sessionStorage: SessionStorage }).sessionStorage
    let rejectedCount = 0
    const storage = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'flush') {
          return (id: string) => {
            if (id === sessionId && rejectedCount === 0) {
              rejectedCount += 1
              return Promise.reject(new Error('disk full'))
            }
            return real.flush(id)
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    ;(sm as unknown as { sessionStorage: SessionStorage }).sessionStorage = storage
  }

  it('replacement after the transition to processing stops the processing session and unregisters it', async () => {
    const managed = buildSession('reservation-after')
    // No flush gating: the send runs to setProcessing and then fails during
    // agent-init (no platform in this harness) — but the window with
    // isProcessing=true is real.
    const sending = sm.sendMessage('reservation-after', 'hello')
    sending.catch(() => {})
    for (let i = 0; i < 300 && !managed.isProcessing; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // Cleanup while processing: the execution is active (isProcessing), the
    // stop cancels processing. cancelProcessing deliberately leaves
    // isProcessing to the chat loop's drain (5s safety timeout), so this
    // drain is bounded but slower than one test tick.
    const cleanup = await stopRegisteredProductSpaceExecutionsForAccount(accountId)
    expect(cleanup.ok).toBe(true)
    expect(registeredAssistantRecords()).toBe(0)
    expect(managed.isProcessing).toBe(false)

    await expect(sending).rejects.toThrow()
    expect(managed.isProcessing).toBe(false)
    expect(registeredAssistantRecords()).toBe(0)
  }, 20000)

  it('a sequential second send owns the reservation; the parked first send can neither consume nor unregister it (R31-3)', async () => {
    const managed = buildSession('ownership-seq')
    // Gate BOTH flushes: A parks on flush #1, B parks on flush #2 — both
    // live with their own reservations (v1, v2).
    let releaseA!: () => void
    let releaseB!: () => void
    const gatedA = new Promise<void>(resolve => { releaseA = () => resolve() })
    const gatedB = new Promise<void>(resolve => { releaseB = () => resolve() })
    const real = (sm as unknown as { sessionStorage: SessionStorage }).sessionStorage
    let flushCalls = 0
    const storage = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'flush') {
          return (id: string) => {
            flushCalls += 1
            if (flushCalls === 1) return gatedA
            if (flushCalls === 2) return gatedB
            return real.flush(id)
          }
        }
        const value = Reflect.get(target, prop)
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value
      },
    })
    ;(sm as unknown as { sessionStorage: SessionStorage }).sessionStorage = storage

    const firstSend = sm.sendMessage('ownership-seq', 'first')
    firstSend.catch(() => {})
    for (let i = 0; i < 300 && flushCalls < 1; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const secondSend = sm.sendMessage('ownership-seq', 'second')
    secondSend.catch(() => {})
    for (let i = 0; i < 300 && flushCalls < 2; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // Both sends are parked, each owning its own reservation.
    expect(registeredAssistantRecords()).toBe(1)

    // A resumes first: its CAS must fail (v1 ≠ v2) WITHOUT unregistering
    // B's owned execution.
    releaseA()
    await expect(firstSend).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')
    expect(registeredAssistantRecords()).toBe(1)

    // B then resumes, confirms its own reservation and fails at (harness)
    // agent bootstrap — releasing ITS OWN execution only.
    releaseB()
    await expect(secondSend).rejects.toThrow()
    expect(registeredAssistantRecords()).toBe(0)
    expect(managed.isProcessing).toBe(false)
  })

  it('a flush persistence rejection releases the reservation and a retry starts clean (R31-4)', async () => {
    const managed = buildSession('flush-reject')
    rejectFirstFlush('flush-reject')

    await expect(sm.sendMessage('flush-reject', 'hello')).rejects.toThrow('disk full')
    // The pre-confirm throw released the reservation and unregistered the
    // owned execution — no permanently active record remains.
    expect(registeredAssistantRecords()).toBe(0)
    expect(managed.isProcessing).toBe(false)

    // The retry starts clean: it re-registers and proceeds to the (harness)
    // agent-bootstrap failure with no residue from the failed attempt.
    const retry = sm.sendMessage('flush-reject', 'hello again')
    let retryError: unknown
    retry.catch(e => { retryError = e })
    for (let i = 0; i < 300 && !managed.isProcessing; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
      if (retryError) { console.log('[dbg retry] rejected early with:', (retryError as Error)?.message); break }
      if (i % 10 === 0) console.log('[dbg retry] i=', i, 'processing=', managed.isProcessing, 'registered=', listRegisteredProductSpaceExecutions().length)
    }
    console.log('[dbg retry] after poll: processing=', managed.isProcessing, 'registered=', listRegisteredProductSpaceExecutions().length, 'error=', (retryError as Error)?.message)
    await expect(retry).rejects.toThrow()
    expect(managed.isProcessing).toBe(false)
    expect(registeredAssistantRecords()).toBe(0)
  })

  it('a post-confirm/agent-bootstrap failure clears processing and releases the execution; a retry stays clean (R31-5)', async () => {
    const managed = buildSession('agent-fail')
    // No platform in this harness: agent creation fails right after the
    // transition to processing. The generation counter proves the send
    // reached the post-confirm transition.
    const generationBefore = managed.processingGeneration

    const first = sm.sendMessage('agent-fail', 'one')
    first.catch(() => {})
    await expect(first).rejects.toThrow()
    expect(managed.processingGeneration).toBeGreaterThan(generationBefore)
    // The extended lifecycle cleared processing and released the execution.
    expect(managed.isProcessing).toBe(false)
    expect(registeredAssistantRecords()).toBe(0)

    // The retry registers cleanly and fails identically — no corruption.
    const second = sm.sendMessage('agent-fail', 'two')
    second.catch(() => {})
    await expect(second).rejects.toThrow()
    expect(managed.processingGeneration).toBeGreaterThan(generationBefore + 1)
    expect(managed.isProcessing).toBe(false)
    expect(registeredAssistantRecords()).toBe(0)
  })
})
