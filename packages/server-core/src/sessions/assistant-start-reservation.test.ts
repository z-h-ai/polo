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

  it('a follower queues behind a parked owner without stealing ownership; the stale owner is refused and nothing re-arms an execution (R31-3)', async () => {
    const managed = buildSession('ownership-seq')
    // Gate the OWNER's first bootstrap flush: A parks inside its own locked
    // critical section with reservation v1 live and visible. Under the
    // merged single-lock linearization (POO-53) the follower's whole branch
    // decision runs inside the session's question-state lock, so it can
    // never park a second flush beside the owner — the pre-merge "both
    // parked on their own flush" interleaving is structurally unreachable.
    const { release } = gateFirstFlush('ownership-seq')

    const firstSend = sm.sendMessage('ownership-seq', 'first')
    firstSend.catch(() => {})
    for (let i = 0; i < 300 && registeredAssistantRecords() === 0; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(registeredAssistantRecords()).toBe(1)
    expect(managed.isProcessing).toBe(false)

    // The follower arrives while the owner is parked: its entry claim
    // loses (the owner holds turnStartReserved), so it waits in the lock
    // queue. It must NEVER register a superseding execution or unseat the
    // parked owner's reservation (R31-3 ownership CAS).
    const secondSend = sm.sendMessage('ownership-seq', 'second')
    secondSend.catch(() => {})
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(registeredAssistantRecords()).toBe(1)
    expect(managed.isProcessing).toBe(false)

    // Account replacement makes the parked owner stale while the follower
    // still holds nothing: cleanup stops and unregisters the owner's live
    // execution and revokes the fence.
    const cleanup = await stopRegisteredProductSpaceExecutionsForAccount(accountId)
    expect(cleanup.ok).toBe(true)
    await revokeRuntimeProductSpaceFence()
    expect(registeredAssistantRecords()).toBe(0)

    // The owner resumes: its pre-processing CAS refuses the stale
    // reservation (fail-closed, pre-processing — no half-started turn).
    release()
    await expect(firstSend).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')

    // The follower then re-evaluates in-lock, finds the reservation freed
    // by the owner's failed turn start, and claims it itself — but the
    // revoked fence refuses its registration too, so it also fails closed.
    // Neither send can consume an execution it does not own and none is
    // left behind.
    await expect(secondSend).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')
    expect(managed.isProcessing).toBe(false)
    expect(registeredAssistantRecords()).toBe(0)
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
    retry.catch(() => {})
    for (let i = 0; i < 300 && !managed.isProcessing; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
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
