import { afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement } from 'react'
import type { ClientCreateColleagueInvitationResponse } from '@polo-ai/shared/admin/client-enterprise-contract'
import { COLLEAGUE_COMPOSE_MAX_TARGETS } from '../useColleagueInvitations'

/**
 * POO-196 R3 colleague-invitation compose hook (adjudication D5, B3 gate
 * "hooks 用例，mock transport"). Proven here against a mocked electronAPI
 * transport:
 *
 * - the multi-select fans out into ONE command per object (the wire never
 *   carries a batch), each object under its own `createRequestKey`;
 * - outcomes are kept PER OBJECT in submit order — a partial failure leaves
 *   the settled objects untouched and visible;
 * - a retry re-sends ONLY the failed/unresolved objects: a DEFINITE failure
 *   mints a FRESH key, an UNRESOLVED one REPLAYS the held key;
 * - the pool never exceeds the concurrency bound (4);
 * - the recovery query resolves the caller's own held key (`unknown` stays
 *   retryable, `found` settles with the real masked status);
 * - >50 targets are refused before any wire call.
 */

GlobalRegistrator.register()

const { act, cleanup, render } = await import('@testing-library/react')
const { useColleagueInvitations } = await import('../useColleagueInvitations')

afterEach(() => {
  cleanup()
})

type Hook = ReturnType<typeof useColleagueInvitations>
type ProbeRecorder = { current: Hook | null }

const SCOPE = {
  accountId: 'account-a',
  productSpaceId: 'space-project',
  sourceEnterpriseId: '11111111-1111-4111-8111-111111111111',
}

function target(userId: string, name: string) {
  return { userId, displayName: name }
}

const invitationFor = (userId: string) => ({
  invitationId: `${userId.slice(0, 8)}-2222-4222-8222-222222222222`,
  status: 'active' as const,
  maskedPhone: '138****0000',
  maskedEmail: null,
  expiresAt: '2026-11-11T00:00:00.000Z',
  createdAt: '2026-11-04T00:00:00.000Z',
  acceptedAt: null,
})

function createdFor(userId: string, key: string): ClientCreateColleagueInvitationResponse {
  return {
    result: 'created',
    invitation: invitationFor(userId),
    invitationUrl: `https://admin.example.com/invite/${key}`,
  }
}

interface Harness {
  createCalls: Array<{ input: Record<string, unknown>; key: string }>
  queryCalls: Array<Record<string, unknown>>
  inFlight: number
  maxInFlight: number
  respond: (call: { input: Record<string, unknown>; key: string; slot: number }) => Promise<ClientCreateColleagueInvitationResponse>
  queryRespond: (input: Record<string, unknown>) => Promise<Record<string, unknown>>
}

function makeHarness(overrides: {
  respond?: (harness: Harness, call: { input: Record<string, unknown>; key: string; slot: number }) => Promise<ClientCreateColleagueInvitationResponse>
  queryRespond?: (harness: Harness, input: Record<string, unknown>) => Promise<Record<string, unknown>>
  delayMs?: number
} = {}): Harness {
  const harness: Harness = {
    createCalls: [],
    queryCalls: [],
    inFlight: 0,
    maxInFlight: 0,
    respond: async () => { throw new Error('no response configured') },
    queryRespond: async () => ({ state: 'unknown' }),
  }
  if (overrides.respond) harness.respond = call => overrides.respond!(harness, call)
  if (overrides.queryRespond) harness.queryRespond = input => overrides.queryRespond!(harness, input)
  const delay = overrides.delayMs ?? 0
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      pmCreateColleagueInvitation: async (input: Record<string, unknown>) => {
        const command = input.command as Record<string, unknown>
        const key = String(command.createRequestKey)
        harness.inFlight += 1
        harness.maxInFlight = Math.max(harness.maxInFlight, harness.inFlight)
        const call = { input, key, slot: harness.createCalls.length }
        harness.createCalls.push(call)
        try {
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
          return await harness.respond(call)
        } finally {
          harness.inFlight -= 1
        }
      },
      pmQueryColleagueInvitation: async (input: Record<string, unknown>) => {
        harness.queryCalls.push(input)
        return harness.queryRespond(input)
      },
    },
  })
  return harness
}

function Probe({ scope, recorder }: { scope: typeof SCOPE | null; recorder: ProbeRecorder }) {
  recorder.current = useColleagueInvitations(scope)
  return null
}

async function mountWith(scope: typeof SCOPE | null, recorder: ProbeRecorder) {
  const view = render(createElement(Probe, { scope, recorder }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  return view
}

const TARGETS = [
  target('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '王芳'),
  target('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '李明'),
  target('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '赵六'),
]

describe('useColleagueInvitations (POO-196 R3, D5)', () => {
  it('fans out per object, keeps results per object, and bounds concurrency at 4', async () => {
    const harness = makeHarness({
      delayMs: 10,
      respond: async (_h, call) => createdFor(String((call.input.command as Record<string, unknown>).targetUserId), call.key),
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    // 12 objects through the pool: concurrency never exceeds 4.
    const twelve = Array.from({ length: 12 }, (_, index) => target(
      `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${String(index).padStart(2, '0')}`.slice(0, 36) as string,
      `成员${index}`,
    ))
    let settled!: boolean
    await act(async () => {
      settled = await recorder.current!.confirmInvitations(twelve)
    })
    expect(settled).toBe(true)
    expect(harness.createCalls).toHaveLength(12)
    expect(harness.maxInFlight).toBeLessThanOrEqual(4)
    expect(harness.maxInFlight).toBeGreaterThan(1)
    // Every object carries the SAME source reference and its OWN key.
    for (const call of harness.createCalls) {
      expect(call.input).toMatchObject({ accountId: SCOPE.accountId, productSpaceId: SCOPE.productSpaceId })
      expect((call.input.command as Record<string, unknown>).sourceEnterpriseId).toBe(SCOPE.sourceEnterpriseId)
    }
    expect(recorder.current?.failedCount).toBe(0)
    expect(recorder.current?.pendingCount).toBe(0)
  })

  it('partial failure keeps per-object results; retry re-sends ONLY failures with a FRESH key', async () => {
    const seenKeys = new Map<string, string>()
    const harness = makeHarness({
      respond: async (_h, call) => {
        const command = call.input.command as Record<string, unknown>
        const userId = String(command.targetUserId)
        seenKeys.set(userId, call.key)
        if (userId === TARGETS[1]!.userId) {
          throw Object.assign(new Error('colleague_target_unavailable'), { code: 'colleague_target_unavailable' })
        }
        return createdFor(userId, call.key)
      },
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    let settled!: boolean
    await act(async () => {
      settled = await recorder.current!.confirmInvitations(TARGETS)
    })
    expect(settled).toBe(false)
    expect(harness.createCalls).toHaveLength(3)
    // Per-object outcomes in SUBMIT order — created / failed / created.
    expect(recorder.current?.results.map(result => result.state)).toEqual(['created', 'failed', 'created'])
    expect(recorder.current?.failedCount).toBe(1)
    expect(recorder.current?.results[1]?.errorCode).toBe('colleague_target_unavailable')
    expect(recorder.current?.results[1]?.errorKey).toBe('projectMembers.directory.targetUnavailable')
    expect(recorder.current?.results[1]?.definiteFailure).toBe(true)
    expect(recorder.current?.results[0]?.invitationUrl).toContain('/invite/')
    const firstAttemptKey = seenKeys.get(TARGETS[1]!.userId)

    // Retry: ONLY the failed object is re-sent, under a FRESH key (a definite
    // failure abandoned the old one); the settled objects are not re-sent.
    seenKeys.clear()
    harness.respond = async function newRespond(call) {
      const command = call.input.command as Record<string, unknown>
      return createdFor(String(command.targetUserId), call.key)
    }
    let retried!: boolean
    await act(async () => {
      retried = await recorder.current!.retryFailed()
    })
    expect(retried).toBe(true)
    expect(harness.createCalls).toHaveLength(4)
    expect((harness.createCalls[3]!.input.command as Record<string, unknown>).targetUserId).toBe(TARGETS[1]!.userId)
    expect(harness.createCalls[3]!.key).not.toBe(firstAttemptKey)
    expect(recorder.current?.results.map(result => result.state)).toEqual(['created', 'created', 'created'])
  })

  it('an UNRESOLVED failure keeps the SAME key: retry replays, query recovers', async () => {
    const seenKeys = new Map<string, string>()
    let firstAttempt = true
    const harness = makeHarness({
      respond: async (_h, call) => {
        const command = call.input.command as Record<string, unknown>
        const userId = String(command.targetUserId)
        seenKeys.set(userId, call.key)
        if (firstAttempt) {
          // Transport-style loss: NO code — the server may or may not have
          // committed, so the key must survive for the replay.
          firstAttempt = false
          throw new Error('request dropped')
        }
        return { result: 'replayed', invitation: invitationFor(userId), invitationUrl: `https://admin.example.com/invite/${call.key}` }
      },
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    await act(async () => { await recorder.current!.confirmInvitations(TARGETS.slice(0, 1)) })
    const unresolvedKey = seenKeys.get(TARGETS[0]!.userId)
    expect(recorder.current?.results[0]?.state).toBe('failed')
    expect(recorder.current?.results[0]?.definiteFailure).toBe(false)
    expect(recorder.current?.results[0]?.errorCode).toBeNull()

    // The recovery query resolves the HELD key: found settles the object
    // with the real masked status and the re-derived link.
    harness.queryRespond = async () => ({
      state: 'found',
      invitation: invitationFor(TARGETS[0]!.userId),
      invitationUrl: `https://admin.example.com/invite/${unresolvedKey}`,
    })
    let queried!: Awaited<ReturnType<Hook['queryTarget']>>
    await act(async () => {
      queried = await recorder.current!.queryTarget(TARGETS[0]!.userId)
    })
    expect(harness.queryCalls).toHaveLength(1)
    expect(harness.queryCalls[0]).toMatchObject({
      accountId: SCOPE.accountId,
      productSpaceId: SCOPE.productSpaceId,
      createRequestKey: unresolvedKey,
    })
    expect(queried?.state).toBe('found')
    expect(recorder.current?.results[0]?.invitationUrl).toContain('/invite/')

    // A later explicit retry of a settled object re-sends NOTHING.
    const callsBefore = harness.createCalls.length
    await act(async () => { await recorder.current!.retryFailed() })
    expect(harness.createCalls).toHaveLength(callsBefore)
  })

  it('an `unknown` receipt keeps the object retryable and REPLAYS the held key on retry', async () => {
    const seenKeys = new Map<string, string>()
    let attempts = 0
    const harness = makeHarness({
      respond: async (_h, call) => {
        const command = call.input.command as Record<string, unknown>
        const userId = String(command.targetUserId)
        seenKeys.set(userId, call.key)
        attempts += 1
        if (attempts === 1) throw new Error('request dropped')
        return createdFor(userId, call.key)
      },
    })
    const recorder: ProbeRecorder = { current: null }
    await mountWith(SCOPE, recorder)

    await act(async () => { await recorder.current!.confirmInvitations(TARGETS.slice(0, 1)) })
    const heldKey = seenKeys.get(TARGETS[0]!.userId)!
    expect(heldKey).toMatch(/^pm-colleague-/)

    harness.queryRespond = async () => ({ state: 'unknown' })
    await act(async () => { await recorder.current!.queryTarget(TARGETS[0]!.userId) })
    expect(recorder.current?.results[0]?.state).toBe('unknown')
    expect(recorder.current?.pendingCount).toBe(1)

    // The explicit retry REPLAYS the SAME key (never a fresh one).
    await act(async () => { await recorder.current!.retryFailed() })
    expect(harness.createCalls).toHaveLength(2)
    expect(harness.createCalls[1]!.key).toBe(heldKey)
    expect(recorder.current?.results[0]?.state).toBe('created')
  })

  it('refuses more than the 50-object bound before any wire call, and clears with the scope', async () => {
    const harness = makeHarness({
      respond: async (_h, call) => createdFor(String((call.input.command as Record<string, unknown>).targetUserId), call.key),
    })
    const recorder: ProbeRecorder = { current: null }
    const view = await mountWith(SCOPE, recorder)

    const tooMany = Array.from({ length: COLLEAGUE_COMPOSE_MAX_TARGETS + 1 }, (_, index) => target(
      `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index % 10}`,
      `成员${index}`,
    ))
    let settled!: boolean
    await act(async () => {
      settled = await recorder.current!.confirmInvitations(tooMany)
    })
    expect(settled).toBe(false)
    expect(harness.createCalls).toHaveLength(0)
    expect(recorder.current?.composeErrorKey).toBe('projectMembers.directory.selectionLimit')

    // A scope change clears per-object results, held keys and the error.
    await act(async () => {
      view.rerender(createElement(Probe, { scope: { ...SCOPE, accountId: 'account-b' }, recorder }))
    })
    expect(recorder.current?.results).toHaveLength(0)
    expect(recorder.current?.composeErrorKey).toBeNull()
  })
})
