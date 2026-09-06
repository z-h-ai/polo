import { beforeEach, describe, expect, it } from 'bun:test'
import {
  listRegisteredProductSpaceExecutions,
  registerProductSpaceExecution,
  resetProductSpaceExecutionRegistryForTests,
  setRuntimeActiveProductSpace,
  setRuntimeActiveProductSpaceAccount,
  setRuntimeProductSpaceRestricted,
  stopRegisteredProductSpaceExecutionsForAccount,
  type RegisteredProductSpaceExecution,
} from './product-space-executions'
import { withSwitchLock } from './switch-lock-internal'
import {
  beginAccountTransition,
  setSyncTrustedProductSpaceAccountId,
  setTrustedProductSpaceAccountProvider,
} from '../handlers/rpc/trusted-product-space-account'
import { resetAssistantStartReservationsForTests } from './assistant-executions'

const trustedAccountId = 'account-trusted'
const otherAccountId = 'account-other'
const organizationA = 'organization-a'

function fakeLocalAppExecution(executionId: string): RegisteredProductSpaceExecution {
  return {
    scope: {
      contractVersion: 1,
      executionId,
      accountId: trustedAccountId,
      productSpaceId: organizationA,
      workspaceId: 'ws-a',
      subject: { kind: 'artifact_instance', artifactType: 'app', artifactInstanceId: 'app-1', versionId: 'app-1', version: '1' },
    } as unknown as RegisteredProductSpaceExecution['scope'],
    kind: 'local_app',
    name: executionId,
    ref: executionId,
    generation: 0,
    isActive: async () => true,
    stop: async () => 'stopped',
  }
}

function sessionManagerStub() {
  return {
    getSessions: (): Array<{ id: string; isProcessing: boolean }> => [],
    cancelProcessing: async () => {},
  }
}

beforeEach(() => {
  resetProductSpaceExecutionRegistryForTests()
  resetAssistantStartReservationsForTests()
  setRuntimeActiveProductSpace(organizationA)
  setRuntimeActiveProductSpaceAccount(trustedAccountId)
  setSyncTrustedProductSpaceAccountId(trustedAccountId)
  setTrustedProductSpaceAccountProvider(async () => trustedAccountId)
})

describe('assistant send-path execution registration (R29 lock order)', () => {
  it('resolves the trusted account BEFORE the switch lock and registers under a stable account', async () => {
    // Gate the Admin account provider: the send registration must be blocked
    // on the provider BEFORE it acquires the switch lock.
    let releaseProvider!: () => void
    const gatedProvider = new Promise<string | null>(resolve => { releaseProvider = () => resolve(trustedAccountId) })
    setTrustedProductSpaceAccountProvider(() => gatedProvider)

    const { registerAssistantExecutionForSend } = await import('./assistant-executions')
    const registering = registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Session 1',
    })

    // The helper must NOT hold the switch lock while it resolves the
    // trusted account through the Admin session lock. Bounded assertion.
    const lockAcquired = await Promise.race([
      withSwitchLock(async () => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 250)),
    ])
    expect(lockAcquired).toBe(true)

    releaseProvider()
    await registering
    const registered = listRegisteredProductSpaceExecutions().find(
      execution => execution.scope.executionId === 'session-1',
    )
    expect(registered).toBeDefined()
    expect(registered!.scope.accountId as string).toBe(trustedAccountId)
  })

  it('an account replacement that wins concurrently fails the stale send closed', async () => {
    // Hold the switch lock: the helper resolves the account (outside the
    // lock), captures the mirror generation, then queues for the lock —
    // the replacement flips the mirror while it waits.
    let releaseSwitchLock!: () => void
    const switchLockReleased = new Promise<void>(resolve => { releaseSwitchLock = () => resolve() })
    const lockHolder = withSwitchLock(async () => {
      await switchLockReleased
    })
    let releaseProvider!: () => void
    const gatedProvider = new Promise<string | null>(resolve => { releaseProvider = () => resolve(trustedAccountId) })
    setTrustedProductSpaceAccountProvider(() => gatedProvider)

    const { registerAssistantExecutionForSend } = await import('./assistant-executions')
    const registering = registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-stale',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Stale session',
    })
    // Deterministic interleave: the account resolves (generation captured)
    // and the helper queues for the held switch lock...
    await new Promise(resolve => setTimeout(resolve, 25))
    // ...then account replacement wins: mirror + fence account flip to B.
    setSyncTrustedProductSpaceAccountId(otherAccountId)
    setRuntimeActiveProductSpaceAccount(otherAccountId)
    // The provider resolves for the helper's pre-lock resolution; the
    // refusal then comes from the in-lock mirror/generation recheck.
    releaseProvider()
    releaseSwitchLock()
    await lockHolder

    // The stale send must fail closed — no execution may be registered
    // under the replaced account.
    await expect(registering).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')
    expect(listRegisteredProductSpaceExecutions()).toHaveLength(0)

    // Sanity: registration still works after the replacement settled on the
    // new account — proving the refusal came from the mirror/generation
    // recheck, not from a broken registration path.
    setTrustedProductSpaceAccountProvider(async () => otherAccountId)
    setSyncTrustedProductSpaceAccountId(otherAccountId)
    setRuntimeActiveProductSpace(organizationA)
    setRuntimeActiveProductSpaceAccount(otherAccountId)
    await registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-fresh',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Fresh session',
    })
    expect(listRegisteredProductSpaceExecutions().map(execution => execution.scope.executionId as string))
      .toEqual(['session-fresh'])
  })

  it('a session bound to another account is rebound to the current trusted account on send', async () => {
    // A pre-existing execution bound to ANOTHER account is not silently
    // reused: the send-path helper rebinds the scope to the current trusted
    // account instead of keeping the replaced account's execution.
    registerProductSpaceExecution(fakeLocalAppExecution('session-1'))
    setTrustedProductSpaceAccountProvider(async () => otherAccountId)
    setSyncTrustedProductSpaceAccountId(otherAccountId)
    setRuntimeActiveProductSpaceAccount(otherAccountId)

    const { registerAssistantExecutionForSend } = await import('./assistant-executions')
    await registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-1',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Rebound session',
    })
    const registered = listRegisteredProductSpaceExecutions().find(
      execution => execution.scope.executionId === 'session-1',
    )
    expect(registered!.scope.accountId as string).toBe(otherAccountId)
    expect(registered!.kind).toBe('assistant_session')
  })

  it('the transition epoch brackets account resolution (R31-1)', async () => {
    // Gated provider: the capture resolves the account, the transition
    // begins BEFORE the post-await epoch re-read, and the capture must
    // refuse instead of presenting the new epoch as if fresh.
    let releaseProvider!: () => void
    const gatedProvider = new Promise<string | null>(resolve => { releaseProvider = () => resolve(trustedAccountId) })
    setTrustedProductSpaceAccountProvider(() => gatedProvider)
    const { captureTrustedStartGate } = await import('./trusted-start-gate')
    const capture = captureTrustedStartGate()
    await new Promise(resolve => setTimeout(resolve, 25))
    beginAccountTransition()
    releaseProvider()
    expect(await capture).toBeNull()

    // A clean capture without an interleaved transition still works.
    const gate = await captureTrustedStartGate()
    expect(gate).not.toBeNull()
    expect(gate!.accountId).toBe(trustedAccountId)
  })

  it('a newer non-starting send preserves the older confirmed processing turn (R32-1)', async () => {
    // Send A is CONFIRMED and processing on the shared session record.
    const processingState = { isProcessing: true }
    const processingStub = {
      getSessions: (): Array<{ id: string; isProcessing: boolean }> => [
        { id: 'session-live', isProcessing: processingState.isProcessing },
      ],
      // Mirrors the real cancelProcessing: clears the processing state so
      // the stop drain can reach a terminal outcome.
      cancelProcessing: async () => {
        processingState.isProcessing = false
      },
    }
    const { registerAssistantExecutionForSend, confirmAssistantStartProcessing } = await import('./assistant-executions')
    const reservationA = await registerAssistantExecutionForSend({
      sessionManager: processingStub,
      sessionId: 'session-live',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Live turn',
    })
    expect(confirmAssistantStartProcessing({
      sessionId: 'session-live',
      reservation: reservationA,
    })).toBe(true)

    // Send B acquires the NEWEST registration version but never starts
    // (dedup, steer, queue or a pre-confirm failure) — its release must
    // only cancel B's own reservation, never unregister the processing
    // execution A owns.
    const reservationB = await registerAssistantExecutionForSend({
      sessionManager: processingStub,
      sessionId: 'session-live',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Non-starting send',
    })
    const { releaseAssistantStartExecution } = await import('./assistant-executions')
    releaseAssistantStartExecution(reservationB)

    // The processing execution is still registered and visible.
    const registered = listRegisteredProductSpaceExecutions().find(
      execution => execution.scope.executionId === 'session-live',
    )
    expect(registered).toBeDefined()
    expect(await registered!.isActive()).toBe(true)

    // Account cleanup / ProductSpace switching still sees and stops A.
    const stopped = await stopRegisteredProductSpaceExecutionsForAccount(trustedAccountId)
    expect(stopped.ok).toBe(true)
    expect(listRegisteredProductSpaceExecutions()).toHaveLength(0)
  })

  it('a read_only-restricted space refuses Assistant registration and confirmation (R32-3)', async () => {
    const { registerAssistantExecutionForSend, confirmAssistantStartProcessing } = await import('./assistant-executions')
    // Registration fails closed while restricted.
    setRuntimeProductSpaceRestricted(organizationA, true)
    await expect(registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-restricted',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Restricted',
    })).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')
    expect(listRegisteredProductSpaceExecutions()).toHaveLength(0)

    // The atomic transition to processing is equally gated: register while
    // active, restrict, then confirm — the reservation is cancelled and the
    // execution unregistered.
    setRuntimeProductSpaceRestricted(organizationA, false)
    const reservation = await registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-restricted-2',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Restricted after register',
    })
    expect(listRegisteredProductSpaceExecutions().length).toBe(1)
    setRuntimeProductSpaceRestricted(organizationA, true)
    expect(confirmAssistantStartProcessing({
      sessionId: 'session-restricted-2',
      reservation,
    })).toBe(false)
    expect(listRegisteredProductSpaceExecutions()).toHaveLength(0)

    // Recovery: clearing the restriction allows registration again without
    // restarting any prior work.
    setRuntimeProductSpaceRestricted(organizationA, false)
    const recovered = await registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-recovered',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Recovered',
    })
    expect(recovered.accountId).toBe(trustedAccountId)
  })

  it('production replacement order — cleanup before revoke refuses the queued start with no orphan (R30-A)', async () => {
    // EXACT production ordering of an account replacement, without manually
    // flipping the mirror or fence:
    //   1. the Assistant start resolved account A (provider gated) and is
    //      queued for the switch lock;
    //   2. the replacement begins — the transition epoch is advanced
    //      SYNCHRONOUSLY before the first cleanup await; cleanup enumerates
    //      no execution of A yet and completes;
    //   3. the fence revoke queues behind the switch lock (held here);
    //   4. the queued start resumes — the transition epoch recheck must
    //      refuse it so no account-A execution survives the revoke.
    let releaseSwitchLock!: () => void
    const switchLockReleased = new Promise<void>(resolve => { releaseSwitchLock = () => resolve() })
    const lockHolder = withSwitchLock(async () => {
      await switchLockReleased
    })
    let releaseProvider!: () => void
    const gatedProvider = new Promise<string | null>(resolve => { releaseProvider = () => resolve(trustedAccountId) })
    setTrustedProductSpaceAccountProvider(() => gatedProvider)

    const { registerAssistantExecutionForSend } = await import('./assistant-executions')
    const registering = registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-orphan',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Orphan candidate',
    })
    // (1) the start resolves account A: the provider is released and the
    // helper captures its trusted-start gate, then queues for the switch
    // lock — all BEFORE the replacement begins.
    releaseProvider()
    await new Promise(resolve => setTimeout(resolve, 25))
    // (2) replacement begins: the epoch advances SYNCHRONOUSLY before
    // cleanup. Cleanup enumerates account A's registered executions — none
    // yet — and completes.
    beginAccountTransition()
    const cleanup = await stopRegisteredProductSpaceExecutionsForAccount(trustedAccountId)
    expect(cleanup.ok).toBe(true)
    // (3) the revoke would queue behind the held switch lock — simulated by
    // keeping it held until the queued start has been judged.
    releaseSwitchLock()
    await lockHolder

    // (4) the queued start must fail closed — no orphan execution of the
    // replaced account may survive cleanup+revoke.
    await expect(registering).rejects.toThrow('EXECUTION_REGISTRATION_REFUSED')
    expect(listRegisteredProductSpaceExecutions()).toHaveLength(0)

    // An aborted/replaced transition leaves nothing stuck: a FRESH start
    // that captures the new epoch registers normally.
    setSyncTrustedProductSpaceAccountId(otherAccountId)
    setRuntimeActiveProductSpaceAccount(otherAccountId)
    setTrustedProductSpaceAccountProvider(async () => otherAccountId)
    await registerAssistantExecutionForSend({
      sessionManager: sessionManagerStub(),
      sessionId: 'session-fresh',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Fresh session',
    })
    expect(listRegisteredProductSpaceExecutions().map(execution => execution.scope.executionId as string))
      .toEqual(['session-fresh'])
  })
})

describe('assistant execution real status projection (R34-3)', () => {
  it('the production provider projects preparing during bootstrap, running in the turn, and stopping after stop dispatch until terminal', async () => {
    resetProductSpaceExecutionRegistryForTests()
    resetAssistantStartReservationsForTests()
    setRuntimeActiveProductSpace(organizationA)
    setRuntimeActiveProductSpaceAccount(trustedAccountId)
    setSyncTrustedProductSpaceAccountId(trustedAccountId)
    setTrustedProductSpaceAccountProvider(async () => trustedAccountId)

    const processingState = { isProcessing: false }
    const sessionStub = {
      getSessions: (): Array<{ id: string; isProcessing: boolean }> => [
        { id: 'session-status', isProcessing: processingState.isProcessing },
      ],
      // Cancel is REQUESTED here; the in-flight turn winds down separately
      // (as in production), so the stop drain must observe it stay active
      // until the terminal transition below.
      cancelProcessing: async () => {},
    }
    const { registerAssistantExecutionForSend, confirmAssistantStartProcessing } = await import('./assistant-executions')

    // Bootstrap window: the live reservation is genuinely 'preparing'.
    const reservation = await registerAssistantExecutionForSend({
      sessionManager: sessionStub,
      sessionId: 'session-status',
      workspaceId: 'ws-a',
      productSpaceId: organizationA,
      name: 'Status turn',
    })
    const registered = listRegisteredProductSpaceExecutions().find(
      execution => execution.scope.executionId === 'session-status',
    )
    expect(registered).toBeDefined()
    expect(registered!.getStatus?.()).toBe('preparing')
    expect(await registered!.isActive()).toBe(true)

    // Confirmed processing turn: 'running', still active for PREPARE/COMMIT.
    expect(confirmAssistantStartProcessing({
      sessionId: 'session-status',
      reservation,
    })).toBe(true)
    processingState.isProcessing = true
    expect(registered!.getStatus?.()).toBe('running')

    // Stop dispatch: 'stopping' immediately — BEFORE the turn reaches a
    // terminal state — and it stays active until the drain confirms.
    const stopPromise = registered!.stop!()
    expect(registered!.getStatus?.()).toBe('stopping')
    expect(await registered!.isActive()).toBe(true)

    // The turn reaches its terminal outcome: the stop drain confirms.
    processingState.isProcessing = false
    expect(await stopPromise).toBe('stopped')
    expect(await registered!.isActive()).toBe(false)
  })
})
