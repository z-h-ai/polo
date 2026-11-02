import { AdminError } from '@polo-ai/shared/admin'
import { getProductSpaceContextStorage } from '@polo-ai/shared/config'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type {
  ClientCreateEnterpriseResponse,
  ClientCreateInvitationResponse,
  ClientCreateReceipt,
  ClientEnterpriseErrorCode,
  ClientInvitationListResponse,
  ClientMemberRosterResponse,
  PmCreateEnterpriseInput,
  PmCreateInvitationInput,
  PmListInvitationsInput,
  PmListMembersInput,
  PmQueryCreateReceiptInput,
} from '@polo-ai/shared/protocol'
import type { TrustedAggregateScopeToken } from '../handlers/rpc/trusted-product-space-account'
import {
  captureTrustedScopeToken,
  getAccountTransitionEpoch,
  getTrustedAccountGeneration,
  isAccountTransitionInProgress,
  resolveTrustedProductSpaceAccountId,
} from '../handlers/rpc/trusted-product-space-account'
import {
  getRuntimeActiveProductSpace,
  getRuntimeActiveProductSpaceScope,
  getRuntimeFenceGeneration,
  isRuntimeFenceBoundToAccount,
} from '../runtime/product-space-executions'
import {
  ProjectMembersAdminUnavailableError,
  clientEnterpriseErrorCodeOf,
  getProjectMembersAdmin,
  type ProjectMembersAdmin,
} from './admin-client'

/**
 * POO-196 追加轮 project-members service (adjudication D-A/D-B/D-C).
 *
 * Two differently-scoped command families share one module:
 *
 * - CREATE / RECEIPT are ACCOUNT-scoped and deliberately do NOT depend on the
 *   enterprise fence: the caller may still be sitting in their personal space
 *   with no enterprise membership at all. They are gated on the trusted Admin
 *   session plus the account/transition/fence generation, so a response can
 *   never be published into a different account than the one that asked.
 * - ROSTER / INVITATIONS are COMMITTED-SPACE-scoped: they address the space
 *   the runtime fence already committed, re-prove it on every entry, and let
 *   polo-admin decide owner/manager authority — the local role cache never
 *   grants or denies a management read (D-C), a plain member is rejected by
 *   the admin surface with `forbidden`.
 *
 * Every entry re-validates its scope token after EVERY await (cross-await
 * fence) and maps admin outcomes onto the generated contract's stable codes.
 */

/** Stable business-RPC error for an uncommitted runtime fence (pc/kb 同款). */
export const PM_PRODUCT_SPACE_CONTEXT_REQUIRED = 'PRODUCT_SPACE_CONTEXT_REQUIRED'

export function pmError(code: string, message?: string): Error {
  return Object.assign(new Error(message ?? code), { code })
}

export interface ProjectMembersAccountScope {
  accountId: string
  token: TrustedAggregateScopeToken
}

export interface ProjectMembersSpaceScope {
  accountId: string
  productSpaceId: string
  token: TrustedAggregateScopeToken
}

type ActiveProductSpaceReader = (
  accountId: string,
  productSpaceId: string,
) => TrustedProductSpaceSummary | null

const defaultActiveProductSpaceReader: ActiveProductSpaceReader = (accountId, productSpaceId) => {
  const verified = getProductSpaceContextStorage(accountId)?.verifiedContext
  if (!verified || verified.activeProductSpaceId !== productSpaceId) return null
  return verified.list.productSpaces.find(space => space.id === productSpaceId) ?? null
}

let activeProductSpaceReader: ActiveProductSpaceReader = defaultActiveProductSpaceReader

/** Test seam: pin the active-space reader for one file. */
export function setProjectMembersActiveProductSpaceReaderForTests(reader: ActiveProductSpaceReader | null): void {
  activeProductSpaceReader = reader ?? defaultActiveProductSpaceReader
}

export function resetProjectMembersActiveProductSpaceReaderForTests(): void {
  activeProductSpaceReader = defaultActiveProductSpaceReader
}

/** Admin adapter seam for tests. */
let adminAdapter: ProjectMembersAdmin | null = null

export function setProjectMembersAdminForTests(admin: ProjectMembersAdmin | null): void {
  adminAdapter = admin
}

export function resetProjectMembersAdminForTests(): void {
  adminAdapter = null
}

function theAdmin(): ProjectMembersAdmin {
  return adminAdapter ?? getProjectMembersAdmin()
}

/**
 * The legacy spellings the admin client's alias table produces for codes this
 * round's contract also declares. Mapping them back keeps ONE renderer-facing
 * vocabulary (the generated contract's) instead of two spellings per failure.
 */
const LEGACY_CODE_TO_CONTRACT: Partial<Record<AdminError['errorCode'], ClientEnterpriseErrorCode>> = {
  UNAUTHORIZED: 'unauthorized',
  TOKEN_EXPIRED: 'unauthorized',
  TOKEN_REVOKED: 'token_revoked',
  ACCOUNT_DISABLED: 'account_disabled',
  FORBIDDEN: 'forbidden',
  MEMBERSHIP_REMOVED: 'forbidden',
  MEMBERSHIP_SUSPENDED: 'forbidden',
  NOT_FOUND: 'not_found',
  VALIDATION_ERROR: 'validation_error',
}

/** Maps any admin-side failure onto the stable client-enterprise / pm_* codes. */
function mapAdminFailure(error: unknown): Error {
  if (error instanceof ProjectMembersAdminUnavailableError) {
    return pmError(error.code === 'pm_signed_out' ? 'pm_signin_required' : 'pm_service_unavailable')
  }
  const contractCode = clientEnterpriseErrorCodeOf(error)
  if (contractCode) return pmError(contractCode)
  if (error instanceof AdminError) {
    const mapped = LEGACY_CODE_TO_CONTRACT[error.errorCode]
    if (mapped) return pmError(mapped)
  }
  return pmError('pm_service_unavailable', error instanceof Error ? error.message : undefined)
}

/**
 * The account/fence CAS for an await-spanning account-scoped command: the
 * transition epoch, account-binding generation, fence generation and the
 * committed scope must all still be current, or the response is discarded.
 */
function isAccountScopeTokenCurrent(token: TrustedAggregateScopeToken): boolean {
  if (isAccountTransitionInProgress()) return false
  if (getAccountTransitionEpoch() !== token.transitionEpoch) return false
  if (getTrustedAccountGeneration() !== token.accountGeneration) return false
  if (getRuntimeFenceGeneration() !== token.fenceGeneration) return false
  const runtimeScope = getRuntimeActiveProductSpaceScope()
  return Boolean(
    runtimeScope
    && runtimeScope.accountId === token.accountId
    && runtimeScope.productSpaceId === token.productSpaceId,
  )
}

function assertAccountScopeCurrent(scope: ProjectMembersAccountScope): void {
  if (!isAccountScopeTokenCurrent(scope.token)) {
    throw pmError('pm_scope_changed', 'The trusted account changed during the operation')
  }
}

/**
 * Account gate for the create commands. NO committed enterprise space is
 * required — the personal space fence is enough, because creating a project
 * is exactly the move out of it (D-B 1/4).
 */
async function requireAccountScope(input: { accountId: string }): Promise<ProjectMembersAccountScope> {
  const token = captureTrustedScopeToken()
  if (!token) throw pmError('pm_signin_required', 'No trusted caller scope is available')
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  // Post-await CAS: the account/fence state may have moved while the trusted
  // account was being resolved.
  if (!isAccountScopeTokenCurrent(token)) {
    throw pmError('pm_scope_changed', 'The trusted account changed during the operation')
  }
  if (!trustedAccountId) {
    throw pmError('pm_signin_required', 'No trusted Admin session is available')
  }
  if (input.accountId !== trustedAccountId) {
    // The renderer asked for a different account than the session proves —
    // a stale dialog must never create under someone else's identity.
    throw pmError('pm_scope_changed', 'The renderer account is not the trusted account')
  }
  if (!isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw pmError('pm_signin_required', 'The committed space is not bound to this account')
  }
  return { accountId: trustedAccountId, token }
}

/**
 * Committed-space gate for the roster/invitation commands. The requested
 * productSpaceId must BE the committed space (a renderer cannot probe a
 * foreign space id), and it must be an enterprise project. Authority itself
 * is decided by polo-admin, never by the local role cache.
 */
async function requireMemberScope(input: {
  accountId: string
  productSpaceId: string
}): Promise<ProjectMembersSpaceScope> {
  const token = captureTrustedScopeToken()
  if (!token) throw pmError(PM_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No trusted caller scope is available')
  const trustedAccountId = await resolveTrustedProductSpaceAccountId()
  if (!isAccountScopeTokenCurrent(token)) {
    throw pmError('pm_scope_changed', 'The trusted scope changed during the operation')
  }
  if (!trustedAccountId) {
    throw pmError('pm_signin_required', 'No trusted Admin session is available')
  }
  if (input.accountId !== trustedAccountId) {
    throw pmError('pm_scope_changed', 'The renderer account is not the trusted account')
  }
  const activeProductSpaceId = getRuntimeActiveProductSpace()
  if (!activeProductSpaceId || !isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw pmError(PM_PRODUCT_SPACE_CONTEXT_REQUIRED, 'No committed ProductSpace is active for this account')
  }
  if (input.productSpaceId !== activeProductSpaceId) {
    throw pmError('forbidden', 'The requested project is not the active one')
  }
  const space = activeProductSpaceReader(trustedAccountId, activeProductSpaceId)
  if (!space || space.id !== activeProductSpaceId) {
    throw pmError(PM_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The active ProductSpace is not resolvable for this account')
  }
  if (space.kind !== 'enterprise') {
    throw pmError('pm_unavailable_in_personal', 'Project members are only available in an enterprise project')
  }
  return { accountId: trustedAccountId, productSpaceId: space.id, token }
}

function assertSpaceScopeCurrent(scope: ProjectMembersSpaceScope): void {
  if (!isAccountScopeTokenCurrent(scope.token)) {
    throw pmError('pm_scope_changed', 'The trusted scope changed during the operation')
  }
}

/* ------------------------------------------------------------------ */
/* Account-scoped commands (D-B)                                       */
/* ------------------------------------------------------------------ */

export async function pmCreateEnterprise(
  input: PmCreateEnterpriseInput,
): Promise<ClientCreateEnterpriseResponse> {
  const scope = await requireAccountScope(input)
  try {
    const result = await theAdmin().createEnterprise({
      ...input.command,
      idempotencyKey: input.idempotencyKey,
    })
    assertAccountScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pmQueryCreateReceipt(
  input: PmQueryCreateReceiptInput,
): Promise<ClientCreateReceipt> {
  const scope = await requireAccountScope(input)
  try {
    const result = await theAdmin().queryMyCreateReceipt(input.createRequestKey)
    assertAccountScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/* ------------------------------------------------------------------ */
/* Committed-space commands (D-C)                                      */
/* ------------------------------------------------------------------ */

export async function pmListProjectMembers(
  input: PmListMembersInput,
): Promise<ClientMemberRosterResponse> {
  const scope = await requireMemberScope(input)
  try {
    const result = await theAdmin().listProjectMembers(input.productSpaceId, {
      limit: input.limit,
      cursor: input.cursor,
    })
    assertSpaceScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pmListProjectInvitations(
  input: PmListInvitationsInput,
): Promise<ClientInvitationListResponse> {
  const scope = await requireMemberScope(input)
  try {
    const result = await theAdmin().listProjectInvitations(input.productSpaceId, {
      limit: input.limit,
      cursor: input.cursor,
    })
    assertSpaceScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

export async function pmCreateProjectInvitation(
  input: PmCreateInvitationInput,
): Promise<ClientCreateInvitationResponse> {
  const scope = await requireMemberScope(input)
  try {
    const result = await theAdmin().createProjectInvitation(input.productSpaceId, input.command)
    assertSpaceScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}
