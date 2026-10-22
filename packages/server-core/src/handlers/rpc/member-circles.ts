/**
 * Member circle trusted RPC bridge (POO-70 C1 / POO-88).
 *
 * Every member-circle channel resolves its permission subject from the
 * Main-process trusted Admin session — the synchronous trusted-account mirror
 * maintained by the Admin session lifecycle — and NEVER from a renderer
 * argument (P70-CIRCLE-API-01). Renderer-supplied resource ids
 * (membershipId/orderId/circleId) only ADDRESS a request; they can never
 * widen it to another account, because the provider filters rows by the
 * authenticated actor (`actor.sub`).
 *
 * Epoch fencing (P70-CIRCLE-API-03): each request captures the trusted
 * account id, the trusted account-binding generation and the runtime
 * ProductSpace fence generation BEFORE its first await, and revalidates all
 * three immediately before any success payload is returned. A logout, an
 * account replacement, a session-ending transition or a space exit during
 * the request discards the response fail-closed (`session_changed`) — stale
 * data from a dead identity/space is never published.
 *
 * Gaps G2 (updates) and G3 (public profile by circleId) have no member-side endpoint upstream (F1 contract,
 * upstream-expected). Their channels answer with the explicit
 * `upstream_pending` capability state — never fabricated content, never an
 * empty-list success, and never a creator-management API substitute. G4 now
 * uses the authenticated POL-115 global reader and Main-validated image bytes.
 */
import sharp from 'sharp'
import { createHash } from 'node:crypto'
import {
  AdminClient,
  AdminError,
  type AdminClientTokenStore,
  type MemberCircleApiErrorCode,
  type MemberCircleCheckoutResult,
  type MemberCircleLeaveMembership,
  type MemberCircleRenewalPreview,
  type MemberCircleSnapshot,
  type MemberCircleSupportState,
  type MemberCircleUpstreamPendingState,
  type MemberMembership,
  type OriginalCircleOrder,
  mapMemberCircleApiError,
  resolveMemberCirclePurchaseUrl,
  MemberCircleUuidSchema,
  MemberCircleInvalidResponseError,
  parseSupportConfiguration,
  parseMemberCircleSupportState,
  hasSupportImageSignature,
  SUPPORT_MAX_IMAGE_BYTES,
  SUPPORT_MAX_IMAGE_PIXELS,
} from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import { getCredentialManager, type CredentialManager } from '@polo-ai/shared/credentials'
import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { HandlerDeps } from '../handler-deps'
import { getRuntimeFenceGeneration } from '../../runtime/product-space-executions'
import {
  getSyncTrustedProductSpaceAccountState,
  getSyncTrustedProductSpaceAccountId,
  getTrustedAccountGeneration,
  isAccountTransitionInProgress,
} from './trusted-product-space-account'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.memberCircles.LIST,
  RPC_CHANNELS.memberCircles.LIST_MEMBERSHIPS,
  RPC_CHANNELS.memberCircles.PREVIEW_RENEWAL,
  RPC_CHANNELS.memberCircles.LEAVE,
  RPC_CHANNELS.memberCircles.GET_ORDER,
  RPC_CHANNELS.memberCircles.GET_CHECKOUT_RESULT,
  RPC_CHANNELS.memberCircles.GET_UPDATES,
  RPC_CHANNELS.memberCircles.GET_PROFILE,
  RPC_CHANNELS.memberCircles.GET_SUPPORT,
] as const

/** The member-circle slice of AdminClient consumed by this bridge. */
export type MemberCircleAdminClient = Pick<
  AdminClient,
  | 'listMemberCircles'
  | 'listMemberCircleMemberships'
  | 'previewMemberCircleRenewal'
  | 'leaveMemberCircle'
  | 'getMemberCircleOriginalOrder'
  | 'getMemberCircleCheckoutResult'
  | 'getSupportConfiguration'
>

export type MemberCircleRpcErrorCode =
  | MemberCircleApiErrorCode
  | 'session_changed'
  | 'session_unavailable'

export interface MemberCircleRpcFailure {
  success: false
  errorCode: MemberCircleRpcErrorCode
  message: string
  status?: number
}

export type MemberCircleListResult =
  | { success: true; circles: MemberCircleSnapshot[] }
  | MemberCircleRpcFailure

export type MemberMembershipListResult =
  | { success: true; memberships: MemberMembership[] }
  | MemberCircleRpcFailure

export type MemberCircleRenewalPreviewResult =
  | {
    success: true
    purchaseUrl: string
    /** Absolute URL resolved against the confirmed Admin origin; null when unresolvable. */
    resolvedPurchaseUrl: string | null
    /** Set when resolution failed closed; the raw purchaseUrl stays untouched. */
    purchaseUrlResolutionError: 'invalid_purchase_url' | 'untrusted_purchase_url_origin' | null
    preview: MemberCircleRenewalPreview
  }
  | MemberCircleRpcFailure

export type MemberCircleLeaveResult =
  | { success: true; membership: MemberCircleLeaveMembership }
  | MemberCircleRpcFailure

export type MemberCircleOrderResult =
  | { success: true; order: OriginalCircleOrder }
  | MemberCircleRpcFailure

export type MemberCircleCheckoutReadResult =
  | { success: true; checkout: MemberCircleCheckoutResult }
  | MemberCircleRpcFailure

export type MemberCircleUpdatesResult =
  | { success: true; updates: MemberCircleUpstreamPendingState }
  | MemberCircleRpcFailure

export type MemberCircleProfileResult =
  | { success: true; profile: MemberCircleUpstreamPendingState }
  | MemberCircleRpcFailure

export type MemberCircleSupportResult =
  | { success: true; support: MemberCircleSupportState }
  | MemberCircleRpcFailure

/** Test/host seams; production defaults resolve the process singletons. */
export interface MemberCircleHandlerOptions {
  credentialManager?: Pick<CredentialManager, 'getAdminTokens' | 'setAdminTokens'>
  resolveAdminUrl?: () => string | null
  createAdminClient?: (
    adminUrl: string,
    tokenStore?: AdminClientTokenStore,
  ) => MemberCircleAdminClient
}

type StoredMemberCircleTokens = NonNullable<
  Awaited<ReturnType<CredentialManager['getAdminTokens']>>
>

/**
 * Await-spanning request fence: the trusted account plus both monotonic
 * generations that move when the identity or the space binding dies.
 */
interface MemberCircleRequestFence {
  accountId: string
  accountGeneration: number
  fenceGeneration: number
}

type MemberCircleFenceCapture =
  | { ok: true; fence: MemberCircleRequestFence }
  | {
    ok: false
    errorCode: 'session_changed' | 'session_unavailable' | 'unauthorized'
  }

/**
 * Captured SYNCHRONOUSLY at RPC entry, before any await. The synchronous
 * mirror is the fail-closed gate documented on the trusted account module:
 * `unknown` (startup not settled) is `session_unavailable`, `signed_out` is
 * `unauthorized` — neither may fall through to a network call.
 */
function captureMemberCircleRequestFence(): MemberCircleFenceCapture {
  // R37-1 semantics: while a session transition (logout/account replacement)
  // owns its cleanup, nothing may run against the dying account — refuse
  // before any await, not just at the pre-response revalidation.
  if (isAccountTransitionInProgress()) return { ok: false, errorCode: 'session_changed' }
  const state = getSyncTrustedProductSpaceAccountState()
  if (state.status === 'unknown') return { ok: false, errorCode: 'session_unavailable' }
  if (state.status === 'signed_out') return { ok: false, errorCode: 'unauthorized' }
  return {
    ok: true,
    fence: {
      accountId: state.accountId,
      accountGeneration: getTrustedAccountGeneration(),
      fenceGeneration: getRuntimeFenceGeneration(),
    },
  }
}

/** Fail-closed revalidation: identity, account generation and space fence must all still be current. */
function isMemberCircleRequestFenceCurrent(fence: MemberCircleRequestFence): boolean {
  if (isAccountTransitionInProgress()) return false
  if (getSyncTrustedProductSpaceAccountId() !== fence.accountId) return false
  if (getTrustedAccountGeneration() !== fence.accountGeneration) return false
  if (getRuntimeFenceGeneration() !== fence.fenceGeneration) return false
  return true
}

/**
 * Token refresh store with a value-compare-and-set persist. The member
 * bridge does not own the Admin session coordinator, so a refreshed token is
 * only written back when the stored credentials are STILL exactly the ones
 * this request started from; any concurrent login/logout/refresh wins and
 * this request fails closed instead of writing across the transition.
 */
function createMemberCircleTokenStore(
  manager: Pick<CredentialManager, 'getAdminTokens' | 'setAdminTokens'>,
  started: StoredMemberCircleTokens,
): AdminClientTokenStore {
  return {
    async getRefreshToken() {
      const current = await manager.getAdminTokens()
      return current
        && current.userId === started.userId
        && current.refreshToken === started.refreshToken
        ? current.refreshToken
        : null
    },
    async onTokensRefreshed(refreshed) {
      const current = await manager.getAdminTokens()
      if (
        !current
        || current.userId !== started.userId
        || current.accessToken !== started.accessToken
        || current.refreshToken !== started.refreshToken
      ) {
        throw new AdminError(
          'Admin session changed while refreshing member circle tokens',
          'TOKEN_REVOKED',
        )
      }
      await manager.setAdminTokens({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: Date.now() + refreshed.expiresIn * 1000,
        userId: current.userId,
        username: current.username,
        displayName: current.displayName,
        role: current.role,
        groupIds: current.groupIds,
      })
    },
  }
}

function memberCircleGateFailure(
  errorCode: 'session_changed' | 'session_unavailable' | 'unauthorized',
): MemberCircleRpcFailure {
  const message = errorCode === 'session_changed'
    ? 'Admin session changed'
    : errorCode === 'session_unavailable'
      ? 'Trusted Admin session is not ready'
      : 'Admin session is not logged in'
  return { success: false, errorCode, message }
}

function toMemberCircleRpcFailure(error: unknown): MemberCircleRpcFailure {
  const mapped = mapMemberCircleApiError(error)
  return {
    success: false,
    errorCode: mapped.code,
    message: mapped.message,
    ...(mapped.status !== null ? { status: mapped.status } : {}),
  }
}

function memberCircleInputError(): MemberCircleRpcFailure {
  return {
    success: false,
    errorCode: 'validation_error',
    message: 'Member circle request identifier is invalid',
  }
}

export function registerMemberCircleHandlers(
  server: RpcServer,
  deps: HandlerDeps,
  options?: MemberCircleHandlerOptions,
): void {
  const log = deps.platform.logger
  const resolveAdminUrl = options?.resolveAdminUrl ?? (() => getAdminUrl())
  const manager = options?.credentialManager ?? getCredentialManager()
  const createAdminClient = options?.createAdminClient
    ?? ((adminUrl: string, tokenStore?: AdminClientTokenStore) =>
      new AdminClient(adminUrl, { tokenStore }))

  /**
   * Shared trusted execution body: entry fence capture (synchronous), token
   * resolution against the trusted mirror, the operation itself, and the
   * pre-response fence revalidation that discards stale identities' data.
   */
  const runInTrustedSession = async <T>(
    operation: string,
    run: (client: MemberCircleAdminClient, accessToken: string, adminUrl: string) => Promise<T>,
  ): Promise<T | MemberCircleRpcFailure> => {
    const capture = captureMemberCircleRequestFence()
    if (!capture.ok) return memberCircleGateFailure(capture.errorCode)
    try {
      const tokens = await manager.getAdminTokens()
      if (!isMemberCircleRequestFenceCurrent(capture.fence)) return memberCircleGateFailure('session_changed')
      if (!tokens) return memberCircleGateFailure('unauthorized')
      if (tokens.userId !== capture.fence.accountId) {
        // Stored credentials disagree with the trusted mirror: a transition
        // is in flight or the credentials are stale — never send them.
        return memberCircleGateFailure('session_changed')
      }
      const adminUrl = resolveAdminUrl()
      if (!adminUrl) {
        return {
          success: false,
          errorCode: 'validation_error',
          message: 'Admin URL is not configured',
        }
      }
      const client = createAdminClient(
        adminUrl,
        createMemberCircleTokenStore(manager, tokens),
      )
      const result = await run(client, tokens.accessToken, adminUrl)
      if (!isMemberCircleRequestFenceCurrent(capture.fence)) {
        // Identity/space exited while the request was in flight: the payload
        // is stale by definition and must never reach the renderer.
        log?.warn(`[MemberCircles] ${operation} discarded: trusted session changed mid-request`)
        return memberCircleGateFailure('session_changed')
      }
      return result
    } catch (error) {
      if (!isMemberCircleRequestFenceCurrent(capture.fence)) return memberCircleGateFailure('session_changed')
      const failure = toMemberCircleRpcFailure(error)
      log?.warn(`[MemberCircles] ${operation} failed:`, failure.message)
      return failure
    }
  }

  server.handle(RPC_CHANNELS.memberCircles.LIST, async (): Promise<MemberCircleListResult> => {
    return runInTrustedSession('listCircles', async (client, accessToken) => {
      const list = await client.listMemberCircles(accessToken)
      return { success: true as const, circles: list.circles }
    })
  })

  server.handle(
    RPC_CHANNELS.memberCircles.LIST_MEMBERSHIPS,
    async (): Promise<MemberMembershipListResult> => {
      return runInTrustedSession('listMemberships', async (client, accessToken) => {
        const list = await client.listMemberCircleMemberships(accessToken)
        return { success: true as const, memberships: list.memberships }
      })
    },
  )

  server.handle(
    RPC_CHANNELS.memberCircles.PREVIEW_RENEWAL,
    async (_ctx, membershipId: unknown): Promise<MemberCircleRenewalPreviewResult> => {
      const input = MemberCircleUuidSchema.safeParse(membershipId)
      if (!input.success) return memberCircleInputError()
      return runInTrustedSession('previewRenewal', async (client, accessToken, adminUrl) => {
        const payload = await client.previewMemberCircleRenewal(accessToken, input.data)
        // The raw purchaseUrl is a relative path (/c/{shareId}?renew=1).
        // Only the confirmed Admin origin may resolve it for browser handoff;
        // anything else fails closed while the authoritative preview stays.
        const resolution = resolveMemberCirclePurchaseUrl(payload.purchaseUrl, adminUrl)
        return {
          success: true as const,
          purchaseUrl: payload.purchaseUrl,
          resolvedPurchaseUrl: resolution.ok ? resolution.url : null,
          purchaseUrlResolutionError: resolution.ok ? null : resolution.reason,
          preview: payload.preview,
        }
      })
    },
  )

  server.handle(
    RPC_CHANNELS.memberCircles.LEAVE,
    async (_ctx, membershipId: unknown): Promise<MemberCircleLeaveResult> => {
      const input = MemberCircleUuidSchema.safeParse(membershipId)
      if (!input.success) return memberCircleInputError()
      return runInTrustedSession('leave', async (client, accessToken) => {
        const membership = await client.leaveMemberCircle(accessToken, input.data)
        return { success: true as const, membership }
      })
    },
  )

  server.handle(
    RPC_CHANNELS.memberCircles.GET_ORDER,
    async (_ctx, orderId: unknown): Promise<MemberCircleOrderResult> => {
      const input = MemberCircleUuidSchema.safeParse(orderId)
      if (!input.success) return memberCircleInputError()
      return runInTrustedSession('getOrder', async (client, accessToken) => {
        const order = await client.getMemberCircleOriginalOrder(accessToken, input.data)
        return { success: true as const, order }
      })
    },
  )

  server.handle(
    RPC_CHANNELS.memberCircles.GET_CHECKOUT_RESULT,
    async (_ctx, orderId: unknown): Promise<MemberCircleCheckoutReadResult> => {
      const input = MemberCircleUuidSchema.safeParse(orderId)
      if (!input.success) return memberCircleInputError()
      return runInTrustedSession('getCheckoutResult', async (client, accessToken) => {
        const checkout = await client.getMemberCircleCheckoutResult(accessToken, input.data)
        return { success: true as const, checkout }
      })
    },
  )

  // Upstream-pending capabilities (F1 gaps G2/G3/G4). They validate the
  // addressing id (the re-pinned implementation will need it) and answer with
  // the explicit capability state — without touching the Admin session and
  // without inventing data. These are static capability facts, not per-user
  // reads, so no trusted-session gate is required.
  //
  // RE-PIN OBLIGATION (G2/G3/G4): when the provider lands the real member
  // endpoints, each of these three handlers MUST be re-routed through
  // `runInTrustedSession(...)` — trusted-session gating, uuid-validated
  // addressing and epoch fencing are mandatory for every channel that then
  // reads per-user data from Admin. Shipping the real read without that
  // wrapper would reintroduce exactly the stale-identity disclosure this
  // bridge exists to prevent.
  server.handle(
    RPC_CHANNELS.memberCircles.GET_UPDATES,
    async (_ctx, circleId: unknown): Promise<MemberCircleUpdatesResult> => {
      const input = MemberCircleUuidSchema.safeParse(circleId)
      if (!input.success) return memberCircleInputError()
      const updates: MemberCircleUpstreamPendingState = {
        availability: 'upstream_pending',
        contractGap: 'G2',
      }
      return { success: true, updates }
    },
  )

  server.handle(
    RPC_CHANNELS.memberCircles.GET_PROFILE,
    async (_ctx, circleId: unknown): Promise<MemberCircleProfileResult> => {
      const input = MemberCircleUuidSchema.safeParse(circleId)
      if (!input.success) return memberCircleInputError()
      const profile: MemberCircleUpstreamPendingState = {
        availability: 'upstream_pending',
        contractGap: 'G3',
      }
      return { success: true, profile }
    },
  )

  server.handle(
    RPC_CHANNELS.memberCircles.GET_SUPPORT,
    async (): Promise<MemberCircleSupportResult> => {
      return runInTrustedSession('getSupport', async (client, accessToken) => {
        const receipt = await client.getSupportConfiguration(accessToken)
        const metadata = parseSupportConfiguration(receipt)
        let support: MemberCircleSupportState
        if (!metadata.configured) {
          support = { availability: 'available', configured: false, guidance: metadata.guidance }
        } else {
          const bytes = 'bytes' in receipt ? receipt.bytes : undefined
          if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > SUPPORT_MAX_IMAGE_BYTES
            || !hasSupportImageSignature(bytes, metadata.qrContentType)
            || createHash('sha256').update(bytes).digest('hex') !== metadata.qrSha256) {
            throw new MemberCircleInvalidResponseError()
          }
          try {
            // Same full-decoding boundary as the POL-115 writer. Keep original bytes.
            await sharp(bytes, { failOn: 'warning', limitInputPixels: SUPPORT_MAX_IMAGE_PIXELS }).stats()
          } catch { throw new MemberCircleInvalidResponseError() }
          support = parseMemberCircleSupportState({
            availability: 'available', configured: true, guidance: null,
            qrSha256: metadata.qrSha256, qrContentType: metadata.qrContentType, updatedAt: metadata.updatedAt,
            qrDataUri: `data:${metadata.qrContentType};base64,${Buffer.from(bytes).toString('base64')}`,
          })
        }
        return { success: true as const, support }
      })
    },
  )
}
