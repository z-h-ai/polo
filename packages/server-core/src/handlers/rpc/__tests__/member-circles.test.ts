import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { AdminClientTokenStore } from '@polo-ai/shared/admin'
import { AdminError } from '@polo-ai/shared/admin'
// Imported through the real module path (not the barrel): the member-circle
// contract error class and the provider-error fixtures must stay the REAL
// classes even in processes where the admin.test.ts barrel stub is
// registered (review P2-1/P2-2) — the real AdminClient throws real
// AdminError instances, and the real mapMemberCircleApiError instanceofs
// against the real class.
import { AdminError as RealProviderAdminError } from '../../../../../shared/src/admin/types'
import { MemberCircleInvalidResponseError } from '../../../../../shared/src/admin/member-circles'
import type { HandlerFn, RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../../handler-deps'
import { setRuntimeActiveProductSpace } from '../../../runtime/product-space-executions'
import {
  beginAccountTransition,
  setSyncTrustedProductSpaceAccountState,
  setSyncTrustedProductSpaceAccountId,
  settleAccountTransition,
} from '../trusted-product-space-account'
import {
  HANDLED_CHANNELS,
  registerMemberCircleHandlers,
  type MemberCircleAdminClient,
} from '../member-circles'

const ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER_ACCOUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab'
const MEMBERSHIP_ID = '11111111-1111-4111-8111-111111111111'
const CIRCLE_ID = '22222222-2222-4222-8222-222222222221'
const ORDER_ID = '77777777-7777-4777-8777-777777777771'
const ADMIN_URL = 'https://admin.example.com'

type StoredTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
  userId: string
  username: string
  displayName?: string
  role?: string
  groupIds?: string[]
}

interface RecordedCall {
  method: string
  args?: unknown[]
  accessToken?: string
}

class FakeMemberCircleAdminClient {
  readonly calls: RecordedCall[] = []
  listMemberCirclesError: unknown = null
  leaveMemberCircleError: unknown = null
  previewMemberCircleRenewalResult: unknown = {
    purchaseUrl: '/c/share-1?renew=1',
    preview: {
      membershipId: MEMBERSHIP_ID,
      circleId: CIRCLE_ID,
      billingCycle: 'month',
      periodKind: 'calendar_month',
      priceMinor: 9900,
      currency: 'CNY',
      anchorAt: '2026-04-01T00:00:00.000Z',
      projectedPeriodStartAt: '2026-05-01T00:00:00.000Z',
      projectedPeriodEndAt: '2026-06-01T00:00:00.000Z',
      periodCapEndAt: '2027-05-01T00:00:00.000Z',
      canRenew: true,
      capReason: null,
    },
  }
  listMemberCirclesGate: (() => Promise<unknown>) | null = null
  leaveMemberCircleResult: unknown = {}

  async listMemberCircles(accessToken: string): Promise<unknown> {
    this.calls.push({ method: 'listMemberCircles', accessToken })
    if (this.listMemberCirclesGate) return await this.listMemberCirclesGate()
    if (this.listMemberCirclesError) throw this.listMemberCirclesError
    return validCirclesList()
  }

  async listMemberCircleMemberships(accessToken: string): Promise<unknown> {
    this.calls.push({ method: 'listMemberCircleMemberships', accessToken })
    return { memberships: [] }
  }

  async previewMemberCircleRenewal(accessToken: string, membershipId: string): Promise<unknown> {
    this.calls.push({ method: 'previewMemberCircleRenewal', args: [membershipId], accessToken })
    return this.previewMemberCircleRenewalResult
  }

  async leaveMemberCircle(accessToken: string, membershipId: string): Promise<unknown> {
    this.calls.push({ method: 'leaveMemberCircle', args: [membershipId], accessToken })
    if (this.leaveMemberCircleError) throw this.leaveMemberCircleError
    return this.leaveMemberCircleResult
  }

  async getMemberCircleOriginalOrder(accessToken: string, orderId: string): Promise<unknown> {
    this.calls.push({ method: 'getMemberCircleOriginalOrder', args: [orderId], accessToken })
    // Parsed DTO shape (the real AdminClient method parses the provider payload).
    return {
      orderId,
      storedStatus: 'paid',
      amountMinor: 9900,
      currency: 'CNY',
      checkoutUrl: 'https://pay.example.com/qr/abc',
      periodEndAt: null,
      circle: { circleId: CIRCLE_ID, name: 'Design Circle' },
      paymentOwner: 'B01',
    }
  }

  async getMemberCircleCheckoutResult(accessToken: string, orderId: string): Promise<unknown> {
    this.calls.push({ method: 'getMemberCircleCheckoutResult', args: [orderId], accessToken })
    return {
      state: 'processing',
      orderId,
      circleId: CIRCLE_ID,
      circleName: 'Design Circle',
      amountMinor: 9900,
      currency: 'CNY',
      periodDays: null,
      period: null,
      periodEndAt: null,
      membershipPeriodEndAt: null,
      projectedPeriodEndAt: null,
      periodCapEndAt: null,
      expiresAt: null,
      qrIssuedAt: null,
      qrExpiresAt: null,
      codeUrl: null,
      merchantExpiresAt: null,
      providerState: 'unpaid',
      canRecoverQr: false,
      canReconsent: false,
      recoveryOrderId: null,
      consentVersion: null,
      channel: null,
      currentPriceMinor: null,
      replacedByOrderId: null,
      canRetry: false,
    }
  }
}

function validCirclesList() {
  return {
    circles: [
      {
        id: MEMBERSHIP_ID,
        status: 'active',
        billingKind: 'paid',
        modeTransitionEndsAt: null,
        currentPeriodEnd: '2026-11-01T00:00:00.000Z',
        joinSource: 'paid_join',
        joinedAt: '2026-01-01T00:00:00.000Z',
        circle: {
          id: CIRCLE_ID,
          name: 'Design Circle',
          purpose: 'Design reviews',
          status: 'active',
          ownerUserId: ACCOUNT_ID,
        },
        entitlements: [],
      },
    ],
  }
}

function validLeaveResponse() {
  // Parsed DTO shape (the real AdminClient method parses the provider payload).
  return {
    membershipId: MEMBERSHIP_ID,
    circleId: CIRCLE_ID,
    userId: ACCOUNT_ID,
    status: 'expired',
    billingKind: 'paid',
    currentPeriodEnd: null,
    modeTransitionEndsAt: null,
    suspendedReason: null,
    joinedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
  }
}

function createHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) {
      handlers.set(channel, handler)
    },
    push() {},
    async invokeClient() {
      return undefined
    },
    hasClientCapability() {
      return false
    },
    findClientsWithCapability() {
      return []
    },
  }

  const managerState: { tokens: StoredTokens | null } = {
    tokens: {
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      expiresAt: Date.now() + 60 * 60 * 1000,
      userId: ACCOUNT_ID,
      username: 'member-a',
    },
  }
  const fakeManager = {
    async getAdminTokens(): Promise<StoredTokens | null> {
      return managerState.tokens
    },
    async setAdminTokens(tokens: StoredTokens): Promise<void> {
      managerState.tokens = { ...tokens }
    },
  }

  const deps = {
    sessionManager: {} as HandlerDeps['sessionManager'],
    oauthFlowStore: {} as HandlerDeps['oauthFlowStore'],
    platform: {
      appRootPath: '/',
      resourcesPath: '/',
      isPackaged: false,
      appVersion: '0.0.0-test',
      isDebugMode: true,
      logger: {
        info: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
        debug: mock(() => {}),
      },
      imageProcessor: {
        getMetadata: async () => null,
        process: async () => Buffer.from(''),
      },
    },
  } satisfies HandlerDeps

  const client = new FakeMemberCircleAdminClient()
  const tokenStores: Array<AdminClientTokenStore | undefined> = []
  registerMemberCircleHandlers(server, deps, {
    credentialManager: fakeManager,
    resolveAdminUrl: () => ADMIN_URL,
    createAdminClient: (_adminUrl, tokenStore) => {
      tokenStores.push(tokenStore)
      // The fake mirrors the parsed-DTO surface of the real AdminClient methods.
      return client as unknown as MemberCircleAdminClient
    },
  })

  const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`handler not registered: ${channel}`)
    return await handler({} as never, ...args)
  }

  return {
    handlers,
    invoke,
    managerState,
    client,
    tokenStore: () => {
      if (tokenStores.length === 0) throw new Error('no trusted session was established')
      return tokenStores[0]!
    },
  }
}

describe('registerMemberCircleHandlers', () => {
  let harness: ReturnType<typeof createHarness>

  beforeEach(() => {
    harness = createHarness()
    setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
  })

  afterEach(() => {
    setSyncTrustedProductSpaceAccountId(null)
  })

  it('registers exactly the nine member-circle channels and never a purchase channel', () => {
    expect(HANDLED_CHANNELS).toHaveLength(9)
    for (const channel of HANDLED_CHANNELS) {
      expect(harness.handlers.has(channel)).toBe(true)
    }
    const forbidden = HANDLED_CHANNELS.filter(channel =>
      channel.includes('purchase') || channel.includes('createOrder') || channel.includes('grant'))
    expect(forbidden).toEqual([])
  })

  it('lists circles through the trusted session without any renderer-supplied identity', async () => {
    const result = await harness.invoke(RPC_CHANNELS.memberCircles.LIST) as Record<string, unknown>
    expect(result).toMatchObject({ success: true })
    expect((result.circles as unknown[]).length).toBe(1)
    expect(harness.client.calls[0]).toMatchObject({
      method: 'listMemberCircles',
      accessToken: 'access-token-1',
    })
  })

  it('reads the original order read-only and never triggers payment mutations', async () => {
    const result = await harness.invoke(RPC_CHANNELS.memberCircles.GET_ORDER, ORDER_ID) as Record<string, unknown>
    expect(result).toMatchObject({
      success: true,
      order: { orderId: ORDER_ID, paymentOwner: 'B01', storedStatus: 'paid' },
    })
    expect(harness.client.calls[0]).toMatchObject({
      method: 'getMemberCircleOriginalOrder',
      args: [ORDER_ID],
    })
    expect(harness.client.calls.some(call => call.method !== 'getMemberCircleOriginalOrder')).toBe(false)
  })

  it('ignores extra renderer arguments: a smuggled userId never reaches the Admin client', async () => {
    const result = await harness.invoke(
      RPC_CHANNELS.memberCircles.PREVIEW_RENEWAL,
      MEMBERSHIP_ID,
      OTHER_ACCOUNT_ID,
    ) as Record<string, unknown>
    expect(result).toMatchObject({ success: true, purchaseUrl: '/c/share-1?renew=1' })
    expect(result.resolvedPurchaseUrl).toBe(`${ADMIN_URL}/c/share-1?renew=1`)
    expect(result.purchaseUrlResolutionError).toBeNull()
    expect(harness.client.calls[0]).toEqual({
      method: 'previewMemberCircleRenewal',
      args: [MEMBERSHIP_ID],
      accessToken: 'access-token-1',
    })
  })

  it('leaves via leave_now and answers a replayed leave (409) as conflict', async () => {
    harness.client.leaveMemberCircleResult = validLeaveResponse()
    const result = await harness.invoke(
      RPC_CHANNELS.memberCircles.LEAVE,
      MEMBERSHIP_ID,
      OTHER_ACCOUNT_ID,
    ) as Record<string, unknown>
    expect(result).toMatchObject({ success: true, membership: { status: 'expired' } })
    expect(harness.client.calls[0]).toMatchObject({
      method: 'leaveMemberCircle',
      args: [MEMBERSHIP_ID],
    })

    // leave-replay: the provider answers 409 for a non-active membership.
    harness.client.leaveMemberCircleError = new RealProviderAdminError('x', 'VALIDATION_ERROR', { status: 409 })
    const replay = await harness.invoke(RPC_CHANNELS.memberCircles.LEAVE, MEMBERSHIP_ID) as Record<string, unknown>
    expect(replay).toMatchObject({ success: false, errorCode: 'conflict', status: 409 })
  })

  it('validates resource ids as uuids before touching the trusted session', async () => {
    const bad = await harness.invoke(RPC_CHANNELS.memberCircles.GET_ORDER, 'not-a-uuid') as Record<string, unknown>
    expect(bad).toMatchObject({ success: false, errorCode: 'validation_error' })
    expect(harness.client.calls).toHaveLength(0)
  })

  it('maps provider errors without collapsing them into success', async () => {
    // 401 → unauthorized
    harness.client.listMemberCirclesError = new RealProviderAdminError('x', 'UNAUTHORIZED', { status: 401 })
    expect(await harness.invoke(RPC_CHANNELS.memberCircles.LIST))
      .toMatchObject({ success: false, errorCode: 'unauthorized', status: 401 })

    // 503 → service_unavailable
    harness.client.listMemberCirclesError = new RealProviderAdminError('x', 'SERVER_ERROR', { status: 503 })
    expect(await harness.invoke(RPC_CHANNELS.memberCircles.LIST))
      .toMatchObject({ success: false, errorCode: 'service_unavailable', status: 503 })

    // 404 → not_found
    harness.client.listMemberCirclesError = new RealProviderAdminError('x', 'NOT_FOUND', { status: 404 })
    expect(await harness.invoke(RPC_CHANNELS.memberCircles.LIST))
      .toMatchObject({ success: false, errorCode: 'not_found', status: 404 })

    // 429 → rate_limited (status survives the generic Admin code collapse)
    harness.client.listMemberCirclesError = new RealProviderAdminError('x', 'VALIDATION_ERROR', { status: 429 })
    expect(await harness.invoke(RPC_CHANNELS.memberCircles.LIST))
      .toMatchObject({ success: false, errorCode: 'rate_limited', status: 429 })

    // Contract parse failure → invalid_response, verbatim across the bridge
    // (review P2-1: it must NOT collapse into service_unavailable).
    harness.client.listMemberCirclesError = new MemberCircleInvalidResponseError('unknown circle status')
    expect(await harness.invoke(RPC_CHANNELS.memberCircles.LIST))
      .toMatchObject({ success: false, errorCode: 'invalid_response' })
    const invalid = await harness.invoke(RPC_CHANNELS.memberCircles.LIST) as Record<string, unknown>
    expect(invalid.success).toBe(false)
    expect(invalid.errorCode).not.toBe('service_unavailable')
    expect(invalid.status).toBeUndefined()
  })

  describe('trusted identity gates (P70-CIRCLE-API-01/03)', () => {
    it('fails closed while the trusted mirror is not settled (unknown)', async () => {
      setSyncTrustedProductSpaceAccountState({ status: 'unknown' })
      const result = await harness.invoke(RPC_CHANNELS.memberCircles.LIST) as Record<string, unknown>
      expect(result).toMatchObject({ success: false, errorCode: 'session_unavailable' })
      expect(harness.client.calls).toHaveLength(0)
    })

    it('fails closed as unauthorized when signed out', async () => {
      setSyncTrustedProductSpaceAccountId(null)
      const result = await harness.invoke(RPC_CHANNELS.memberCircles.LIST) as Record<string, unknown>
      expect(result).toMatchObject({ success: false, errorCode: 'unauthorized' })
      expect(harness.client.calls).toHaveLength(0)
    })

    it('fails closed when stored credentials belong to another account (wrong-user)', async () => {
      harness.managerState.tokens!.userId = OTHER_ACCOUNT_ID
      const result = await harness.invoke(RPC_CHANNELS.memberCircles.LIST) as Record<string, unknown>
      expect(result).toMatchObject({ success: false, errorCode: 'session_changed' })
      expect(harness.client.calls).toHaveLength(0)
    })

    it('fails closed when credentials were deleted', async () => {
      harness.managerState.tokens = null
      const result = await harness.invoke(RPC_CHANNELS.memberCircles.LIST) as Record<string, unknown>
      expect(result).toMatchObject({ success: false, errorCode: 'unauthorized' })
    })

    it('discards the response when the space exits while the request is in flight', async () => {
      let releaseList!: (value: unknown) => void
      const gate = new Promise<unknown>(resolve => {
        releaseList = resolve
      })
      harness.client.listMemberCirclesGate = () => gate

      const pending = harness.invoke(RPC_CHANNELS.memberCircles.LIST)
      // The request fence was captured synchronously at handler entry; the
      // in-flight operation is now parked on the gate.
      await Bun.sleep(1)
      setRuntimeActiveProductSpace(null) // space exit → fence generation bump
      releaseList(validCirclesList())
      const result = await pending as Record<string, unknown>
      expect(result).toMatchObject({ success: false, errorCode: 'session_changed' })
    })

    it('discards the response when the account is replaced while the request is in flight', async () => {
      let releaseList!: (value: unknown) => void
      const gate = new Promise<unknown>(resolve => {
        releaseList = resolve
      })
      harness.client.listMemberCirclesGate = () => gate

      const pending = harness.invoke(RPC_CHANNELS.memberCircles.LIST)
      await Bun.sleep(1)
      setSyncTrustedProductSpaceAccountId(OTHER_ACCOUNT_ID) // account replacement
      releaseList(validCirclesList())
      const result = await pending as Record<string, unknown>
      expect(result).toMatchObject({ success: false, errorCode: 'session_changed' })
      setSyncTrustedProductSpaceAccountId(ACCOUNT_ID)
    })

    it('fails closed while an account transition (logout) is in progress', async () => {
      const epoch = beginAccountTransition()
      try {
        const result = await harness.invoke(RPC_CHANNELS.memberCircles.LIST) as Record<string, unknown>
        expect(result).toMatchObject({ success: false, errorCode: 'session_changed' })
        expect(harness.client.calls).toHaveLength(0)
      } finally {
        settleAccountTransition(epoch, 'commit')
      }
    })
  })

  describe('token refresh store (value-CAS persist)', () => {
    it('persists refreshed tokens only while the stored credentials are unchanged', async () => {
      await harness.invoke(RPC_CHANNELS.memberCircles.LIST)
      const tokenStore = harness.tokenStore()
      expect(await tokenStore.getRefreshToken!()).toBe('refresh-token-1')
      await tokenStore.onTokensRefreshed!({
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
        expiresIn: 600,
      })
      expect(harness.managerState.tokens).toMatchObject({
        accessToken: 'access-token-2',
        refreshToken: 'refresh-token-2',
        userId: ACCOUNT_ID,
      })
    })

    it('refuses to persist across a concurrent credential rotation and keeps the winner', async () => {
      await harness.invoke(RPC_CHANNELS.memberCircles.LIST)
      const tokenStore = harness.tokenStore()
      // A concurrent login rotated the stored credentials mid-refresh.
      harness.managerState.tokens = {
        ...harness.managerState.tokens!,
        accessToken: 'rotated-by-login',
        refreshToken: 'refresh-token-rotated',
      }
      expect(await tokenStore.getRefreshToken!()).toBeNull()
      await expect(tokenStore.onTokensRefreshed!({
        accessToken: 'access-token-stale',
        refreshToken: 'refresh-token-stale',
        expiresIn: 600,
      })).rejects.toBeInstanceOf(AdminError)
      expect(harness.managerState.tokens!.accessToken).toBe('rotated-by-login')
    })
  })

  describe('upstream-pending capabilities (G2/G3/G4)', () => {
    it('answers getUpdates/getProfile/getSupport with explicit unsupported states', async () => {
      const updates = await harness.invoke(RPC_CHANNELS.memberCircles.GET_UPDATES, CIRCLE_ID) as Record<string, unknown>
      expect(updates).toEqual({
        success: true,
        updates: { availability: 'upstream_pending', contractGap: 'G2' },
      })
      const profile = await harness.invoke(RPC_CHANNELS.memberCircles.GET_PROFILE, CIRCLE_ID) as Record<string, unknown>
      expect(profile).toEqual({
        success: true,
        profile: { availability: 'upstream_pending', contractGap: 'G3' },
      })
      const support = await harness.invoke(RPC_CHANNELS.memberCircles.GET_SUPPORT) as Record<string, unknown>
      expect(support).toEqual({
        success: true,
        support: { availability: 'upstream_pending', contractGap: 'G4' },
      })
      // Capability facts never call the Admin bridge.
      expect(harness.client.calls).toHaveLength(0)
    })

    it('still validates the addressing id for future re-pin implementations', async () => {
      const bad = await harness.invoke(RPC_CHANNELS.memberCircles.GET_UPDATES, 'short') as Record<string, unknown>
      expect(bad).toMatchObject({ success: false, errorCode: 'validation_error' })
    })
  })
})
