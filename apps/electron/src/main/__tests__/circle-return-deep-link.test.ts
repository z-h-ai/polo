/**
 * Circle web→desktop return bridge tests (POO-70 B1).
 *
 * P70-RETURN-BRIDGE-01: legacy provider launch entry polo://open — launch
 * compat only, no target ever guessed; scheme mismatch with the registered
 * poloai and the POLO_AI_DEEPLINK_SCHEME override are both handled.
 * P70-RETURN-BRIDGE-02: strict F1 versioned circle-return parsing (UUID /
 * unknown params / host / version, all fail closed) + candidate retention
 * across cold start and the login-pending phase.
 * P70-RETURN-BRIDGE-03: account-epoch semantics — pre-login retention,
 * account-switch retention vs full-logout clearing, wrong-account delivery
 * can never carry authorization (ids only), dedup by candidateId, ack/cancel
 * cleanup, and the event/read race consuming exactly once (store-side).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { handleDeepLink, parseDeepLink } from '../deep-link'
import {
  getCircleReturnCandidateStore,
  resetCircleReturnCandidateStoreForTests,
  CircleReturnCandidateStore,
} from '../circle-return-candidate-store'
import type { CircleReturnAccountView } from '../circle-return-candidate-store'
import { RPC_CHANNELS } from '../../shared/types'
import { setSyncTrustedProductSpaceAccountState } from '@polo-ai/server-core/handlers/rpc/trusted-product-space-account'
import type { EventSink } from '@polo-ai/server-core/transport'
import type { WindowManager } from '../window-manager'

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222'
const CIRCLE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MEMBERSHIP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const ORDER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const AUTH_A: CircleReturnAccountView = { status: 'authenticated', accountId: ACCOUNT_A, accountGeneration: 5 }
const AUTH_B: CircleReturnAccountView = { status: 'authenticated', accountId: ACCOUNT_B, accountGeneration: 7 }
const SIGNED_OUT: CircleReturnAccountView = { status: 'signed_out' }
const UNKNOWN: CircleReturnAccountView = { status: 'unknown' }

function createMockWindow(webContentsId: number) {
  return {
    isMinimized: () => false,
    restore: () => {},
    focus: () => {},
    isDestroyed: () => false,
    webContents: {
      id: webContentsId,
      isLoading: () => false,
      isDestroyed: () => false,
      once: () => {},
    },
  }
}

function createMockWindowManager(window: ReturnType<typeof createMockWindow>) {
  let createdWindows = 0
  return {
    manager: {
      focusOrCreateWindow: () => window,
      getFocusedWindow: () => window,
      getLastActiveWindow: () => window,
      getWorkspaceForWindow: (webContentsId: number) => webContentsId === window.webContents.id ? 'ws-main' : undefined,
      createWindow: () => {
        createdWindows += 1
        return window
      },
    } as unknown as WindowManager,
    get createdWindows() {
      return createdWindows
    },
  }
}

function createRecordingSink() {
  const sent: Array<{ channel: string; target: unknown; args: unknown[] }> = []
  const sink: EventSink = (channel, target, ...args) => {
    sent.push({ channel, target, args })
  }
  return { sink, sent }
}

describe('parseDeepLink — poloai://circle-return (P70-RETURN-BRIDGE-02)', () => {
  it('parses a full valid target (all three UUID ids)', () => {
    const target = parseDeepLink(`poloai://circle-return?circleId=${CIRCLE_ID}&membershipId=${MEMBERSHIP_ID}&orderId=${ORDER_ID}`)
    expect(target).toEqual({
      workspaceId: undefined,
      circleReturn: { circleId: CIRCLE_ID, membershipId: MEMBERSHIP_ID, orderId: ORDER_ID },
    })
  })

  it('parses a single-id target (each id alone is enough)', () => {
    for (const [key, value] of [
      ['circleId', CIRCLE_ID],
      ['membershipId', MEMBERSHIP_ID],
      ['orderId', ORDER_ID],
    ] as const) {
      const target = parseDeepLink(`poloai://circle-return?${key}=${value}`)
      expect(target?.circleReturn).toEqual({ [key]: value })
    }
  })

  it('accepts the explicit current protocol version', () => {
    const target = parseDeepLink(`poloai://circle-return?v=1&circleId=${CIRCLE_ID}`)
    expect(target?.circleReturn).toEqual({ circleId: CIRCLE_ID })
  })

  it('rejects a non-UUID id', () => {
    const target = parseDeepLink('poloai://circle-return?circleId=not-a-uuid')
    expect(target).toBeNull()
  })

  it('rejects an unknown parameter (fail closed, incl. assistant callbackId)', () => {
    expect(parseDeepLink(`poloai://circle-return?circleId=${CIRCLE_ID}&shareId=xyz`)).toBeNull()
    expect(parseDeepLink(`poloai://circle-return?circleId=${CIRCLE_ID}&callbackId=abcdefgh`)).toBeNull()
  })

  it('rejects an unsupported protocol version', () => {
    const target = parseDeepLink(`poloai://circle-return?v=2&circleId=${CIRCLE_ID}`)
    expect(target).toBeNull()
  })

  it('rejects a link with no target id', () => {
    expect(parseDeepLink('poloai://circle-return?v=1')).toBeNull()
    expect(parseDeepLink('poloai://circle-return')).toBeNull()
  })

  it('rejects path segments under the return host', () => {
    const target = parseDeepLink(`poloai://circle-return/extra?circleId=${CIRCLE_ID}`)
    expect(target).toBeNull()
  })

  it('rejects a duplicated parameter', () => {
    const target = parseDeepLink(`poloai://circle-return?circleId=${CIRCLE_ID}&circleId=${CIRCLE_ID}`)
    expect(target).toBeNull()
  })

  it('rejects other hosts (near-miss host is not the return protocol)', () => {
    expect(parseDeepLink(`poloai://circle-return-other?circleId=${CIRCLE_ID}`)).toBeNull()
    expect(parseDeepLink(`poloai://open?circleId=${CIRCLE_ID}`)).toBeNull()
  })

  it('rejects a return target under the legacy scheme (polo:// is launch-only)', () => {
    expect(parseDeepLink(`polo://circle-return?circleId=${CIRCLE_ID}`)).toBeNull()
  })

  it('rejects OAuth auth-callback (stays excluded from the return bridge)', () => {
    expect(parseDeepLink('poloai://auth-callback?code=xyz')).toBeNull()
  })
})

describe('parseDeepLink — legacy provider launch entry polo://open (P70-RETURN-BRIDGE-01)', () => {
  it('parses the exact published entry as a no-target launch', () => {
    expect(parseDeepLink('polo://open')).toEqual({ workspaceId: undefined, legacyLaunch: true })
  })

  it('rejects the legacy entry with params or path (no target may be guessed)', () => {
    expect(parseDeepLink('polo://open?orderId=' + ORDER_ID)).toBeNull()
    expect(parseDeepLink('polo://open/extra')).toBeNull()
    expect(parseDeepLink('polo://other')).toBeNull()
  })

  it('accepts the legacy entry regardless of the configured dev scheme override', () => {
    const previous = process.env.POLO_AI_DEEPLINK_SCHEME
    process.env.POLO_AI_DEEPLINK_SCHEME = 'poloai-dev2'
    try {
      expect(parseDeepLink('polo://open')).toEqual({ workspaceId: undefined, legacyLaunch: true })
      expect(parseDeepLink('poloai-dev2://circle-return?orderId=' + ORDER_ID)?.circleReturn).toEqual({ orderId: ORDER_ID })
      // The default scheme keeps working under an override (multi-instance dev).
      expect(parseDeepLink('poloai://circle-return?orderId=' + ORDER_ID)?.circleReturn).toEqual({ orderId: ORDER_ID })
    } finally {
      if (previous == null) delete process.env.POLO_AI_DEEPLINK_SCHEME
      else process.env.POLO_AI_DEEPLINK_SCHEME = previous
    }
  })
})

describe('CircleReturnCandidateStore — account epoch semantics (P70-RETURN-BRIDGE-03)', () => {
  let store: CircleReturnCandidateStore

  const TARGET = { circleId: CIRCLE_ID, membershipId: MEMBERSHIP_ID, orderId: ORDER_ID }

  beforeEach(() => {
    store = new CircleReturnCandidateStore()
  })

  it('keeps a pre-login candidate through the signed-out phase and delivers it after login', () => {
    const recorded = store.recordCandidate(TARGET, SIGNED_OUT)
    expect(recorded.duplicated).toBe(false)

    // Still at login: nothing is delivered while unauthenticated…
    expect(store.getPending(SIGNED_OUT)).toEqual({ status: 'none' })
    // …but the candidate is retained (login-pending)…
    expect(store.peekForTests()?.candidateId).toBe(recorded.candidate.candidateId)
    // …and after the login is verified the late reader still gets the ORIGINAL target.
    const delivered = store.getPending(AUTH_A)
    expect(delivered).toEqual({ status: 'pending', candidate: recorded.candidate })
  })

  it('clears an account-bound candidate on full logout and never delivers it signed out', () => {
    const recorded = store.recordCandidate(TARGET, AUTH_A)
    store.noteAccountSessionEnding(ACCOUNT_A)

    // Signed-out read after the session ended: cleared (注销清理), not delivered.
    expect(store.getPending(SIGNED_OUT)).toEqual({ status: 'none' })
    expect(store.peekForTests()).toBeNull()
    expect(recorded.candidate.candidateId).toBeTruthy()
  })

  it('retains the navigation candidate across a deliberate account switch for re-verification', () => {
    const recorded = store.recordCandidate(TARGET, AUTH_A)

    store.noteAccountSessionEnding(ACCOUNT_A)
    store.noteAccountSessionStarted(ACCOUNT_B)

    const delivered = store.getPending(AUTH_B)
    expect(delivered.status).toBe('pending')
    if (delivered.status === 'pending') {
      // Same navigation target, re-anchored to the NEW account — the candidate
      // carries no authorization, so the wrong-account worst case is a
      // no-access page after C1 re-verification, never another account's data.
      expect(delivered.candidate.candidateId).toBe(recorded.candidate.candidateId)
      expect(delivered.candidate.target).toEqual(TARGET)
    }
  })

  it('fails closed without mutation while the startup mirror is unknown', () => {
    store.recordCandidate(TARGET, SIGNED_OUT)
    expect(store.getPending(UNKNOWN)).toEqual({ status: 'unavailable', reason: 'session_unavailable' })
    expect(store.peekForTests()).not.toBeNull()
  })

  it('delivery does not consume: repeated reads return the same candidate until ack/cancel', () => {
    const recorded = store.recordCandidate(TARGET, AUTH_A)
    const first = store.getPending(AUTH_A)
    const second = store.getPending(AUTH_A)
    expect(first).toEqual({ status: 'pending', candidate: recorded.candidate })
    expect(second).toEqual(first)
  })

  it('ack consumes exactly once; a foreign candidateId is a no-op', () => {
    const recorded = store.recordCandidate(TARGET, AUTH_A)
    expect(store.ack('99999999-9999-4999-8999-999999999999')).toEqual({ status: 'not_found' })
    expect(store.ack(recorded.candidate.candidateId)).toEqual({ status: 'acked' })
    expect(store.ack(recorded.candidate.candidateId)).toEqual({ status: 'not_found' })
    expect(store.peekForTests()).toBeNull()
  })

  it('cancel clears the candidate; foreign candidateId is a no-op', () => {
    const recorded = store.recordCandidate(TARGET, AUTH_A)
    expect(store.cancel('99999999-9999-4999-8999-999999999999')).toEqual({ status: 'not_found' })
    expect(store.cancel(recorded.candidate.candidateId)).toEqual({ status: 'cancelled' })
    expect(store.peekForTests()).toBeNull()
  })

  it('dedups an identical re-record by candidateId and replaces a different target', () => {
    const first = store.recordCandidate(TARGET, AUTH_A)
    const duplicate = store.recordCandidate(TARGET, AUTH_A)
    expect(duplicate.duplicated).toBe(true)
    expect(duplicate.candidate.candidateId).toBe(first.candidate.candidateId)

    const replaced = store.recordCandidate({ circleId: CIRCLE_ID }, AUTH_A)
    expect(replaced.duplicated).toBe(false)
    expect(replaced.candidate.candidateId).not.toBe(first.candidate.candidateId)
    expect(store.getPending(AUTH_A)).toEqual({ status: 'pending', candidate: replaced.candidate })
  })
})

describe('handleDeepLink — circle-return recording and typed event (P70-RETURN-BRIDGE-02/03)', () => {
  beforeEach(() => {
    resetCircleReturnCandidateStoreForTests()
    setSyncTrustedProductSpaceAccountState({ status: 'signed_out' })
  })

  afterEach(() => {
    setSyncTrustedProductSpaceAccountState({ status: 'signed_out' })
    resetCircleReturnCandidateStoreForTests()
  })

  it('records the candidate and pushes the typed event without a NAVIGATE payload', async () => {
    const mock = createMockWindowManager(createMockWindow(101))
    const { sink, sent } = createRecordingSink()
    setSyncTrustedProductSpaceAccountState({ status: 'authenticated', accountId: ACCOUNT_A })

    const result = await handleDeepLink(
      `poloai://circle-return?circleId=${CIRCLE_ID}&orderId=${ORDER_ID}`,
      mock.manager,
      sink,
      (wcId) => wcId === 101 ? 'client-main' : undefined,
    )

    expect(result.success).toBe(true)
    expect(mock.createdWindows).toBe(0) // no windowMode → never creates a window

    const candidateEvents = sent.filter(e => e.channel === RPC_CHANNELS.circleReturn.CANDIDATE)
    expect(candidateEvents.length).toBe(1)
    expect(candidateEvents[0]!.target).toEqual({ to: 'client', clientId: 'client-main' })
    const candidate = candidateEvents[0]!.args[0] as { candidateId: string; target: unknown }
    expect(candidate.target).toEqual({ circleId: CIRCLE_ID, orderId: ORDER_ID })

    // No deeplink NAVIGATE — the candidate is not a view/action route.
    expect(sent.filter(e => e.channel === RPC_CHANNELS.deeplink.NAVIGATE).length).toBe(0)
  })

  it('cold start: candidate recorded before any renderer is delivered to a late reader after login', async () => {
    // Main receives the candidate while the user is still at the login screen
    // (signed_out) — the OS-level open-url path ran before any subscription.
    const mock = createMockWindowManager(createMockWindow(102))
    const { sink, sent } = createRecordingSink()

    const result = await handleDeepLink(
      `poloai://circle-return?membershipId=${MEMBERSHIP_ID}`,
      mock.manager,
      sink,
      () => undefined,
    )
    expect(result.success).toBe(true)

    // The typed event was pushed best-effort (workspace-targeted, buffered by
    // the transport for whoever reconnects), but the store remains the
    // authoritative late-subscription path.
    const candidateEvents = sent.filter(e => e.channel === RPC_CHANNELS.circleReturn.CANDIDATE)
    expect(candidateEvents.length).toBe(1)

    // Still logged in nobody: nothing is delivered while signed out, but the
    // login-pending retention keeps the original target.
    const store = getCircleReturnCandidateStore()
    expect(store.getPending({ status: 'signed_out' })).toEqual({ status: 'none' })

    // The user logs in; C9 subscribes LATE and reads the ORIGINAL target.
    setSyncTrustedProductSpaceAccountState({ status: 'authenticated', accountId: ACCOUNT_A })
    const delivered = store.getPending({ status: 'authenticated', accountId: ACCOUNT_A, accountGeneration: 3 })
    expect(delivered.status).toBe('pending')
    if (delivered.status === 'pending') {
      expect(delivered.candidate.target).toEqual({ membershipId: MEMBERSHIP_ID })
    }
  })

  it('event/read race consumes exactly once: duplicate link keeps one candidateId', async () => {
    const mock = createMockWindowManager(createMockWindow(103))
    const { sink, sent } = createRecordingSink()
    setSyncTrustedProductSpaceAccountState({ status: 'authenticated', accountId: ACCOUNT_A })
    const url = `poloai://circle-return?circleId=${CIRCLE_ID}`

    await handleDeepLink(url, mock.manager, sink, () => undefined)
    await handleDeepLink(url, mock.manager, sink, () => undefined) // OS redelivery

    const candidateEvents = sent.filter(e => e.channel === RPC_CHANNELS.circleReturn.CANDIDATE)
    expect(candidateEvents.length).toBe(2)
    const firstId = (candidateEvents[0]!.args[0] as { candidateId: string }).candidateId
    const secondId = (candidateEvents[1]!.args[0] as { candidateId: string }).candidateId
    expect(secondId).toBe(firstId) // store-side dedup → consumer dedups by candidateId

    const store = getCircleReturnCandidateStore()
    expect(store.ack(firstId)).toEqual({ status: 'acked' })
    expect(store.ack(firstId)).toEqual({ status: 'not_found' }) // second consumer finds it consumed
  })

  it('legacy polo://open focuses the app, records nothing and pushes nothing', async () => {
    const mock = createMockWindowManager(createMockWindow(104))
    const { sink, sent } = createRecordingSink()
    setSyncTrustedProductSpaceAccountState({ status: 'authenticated', accountId: ACCOUNT_A })

    const result = await handleDeepLink('polo://open', mock.manager, sink, () => undefined)

    expect(result.success).toBe(true)
    expect(sent.length).toBe(0)
    const store = getCircleReturnCandidateStore()
    expect(store.peekForTests()).toBeNull()
  })

  it('an invalid circle-return link is rejected without recording a candidate', async () => {
    const mock = createMockWindowManager(createMockWindow(105))
    const { sink, sent } = createRecordingSink()
    setSyncTrustedProductSpaceAccountState({ status: 'authenticated', accountId: ACCOUNT_A })

    const result = await handleDeepLink('poloai://circle-return?circleId=not-a-uuid', mock.manager, sink, () => undefined)

    expect(result.success).toBe(false)
    expect(sent.length).toBe(0)
    const store = getCircleReturnCandidateStore()
    expect(store.peekForTests()).toBeNull()
  })
})
