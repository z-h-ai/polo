import { AdminError } from '@polo-ai/shared/admin'
import { getProductSpaceContextStorage } from '@polo-ai/shared/config'
import type { TrustedProductSpaceSummary } from '@polo-ai/shared/product-spaces'
import type {
  ListOrganizationColleaguesResponse,
  ListProjectMembersResponse,
  ListProjectsResponse,
  PmAddProjectMembersInput,
  PmCreateProjectInput,
  PmListOrganizationColleaguesInput,
  PmListProductSpacesR3Input,
  PmListProjectMembersInput,
  PmListProjectsInput,
  PmProductSpacesListR3Response,
  PmRemoveProjectMemberInput,
  PmUpdateProjectInput,
  PmUpdateProjectMemberInput,
  ProjectMutationResponse,
  RemoveProjectMemberResponse,
  UpdateProjectMemberResponse,
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
  projectErrorCodeOf,
  type ProjectMembersAdmin,
} from './admin-client'

/**
 * POO-205 project-members service (supersedes the POO-196 追加轮 surface).
 *
 * Project lifecycle and membership are COMMITTED-ORGANIZATION-scoped: they
 * address the organization space the runtime fence has committed, re-prove it
 * on EVERY entry, and let polo-admin decide owner/manager authority — the
 * local role cache never grants or denies a management operation. The scope's
 * `organizationEnterpriseId` is a consistency assertion the trusted side
 * re-proves against the committed enterprise space (a stale renderer holding
 * a foreign/renamed organization id is rejected, never forwarded). Project
 * membership ⊆ organization membership is enforced admin-side
 * (`prj_member_not_in_organization`); the local gate adds no role logic.
 *
 * The retained R3 product-space list read stays ACCOUNT-scoped and
 * deliberately does NOT depend on an enterprise fence: the caller may still
 * be sitting in their personal space.
 *
 * Every entry re-validates its scope token after EVERY await (cross-await
 * fence) and maps admin outcomes onto the frozen contract's stable codes
 * (`prj_*` verbatim, legacy uppercase aliases folded back, everything local
 * expressed in the pm_* vocabulary).
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

export interface ProjectMembersOrganizationScope {
  accountId: string
  productSpaceId: string
  /** Re-proved against the committed enterprise space on every entry. */
  organizationEnterpriseId: string
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
 * The legacy spellings the admin client's alias table produces. Mapping them
 * back keeps ONE renderer-facing vocabulary instead of two spellings per
 * failure (session-level 401/403 never carry the contract's prj_* spelling).
 */
const LEGACY_CODE_TO_CONTRACT: Partial<Record<AdminError['errorCode'], string>> = {
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

/** Maps any admin-side failure onto the stable prj_* / client-enterprise /
 * pm_* codes. */
function mapAdminFailure(error: unknown): Error {
  if (error instanceof ProjectMembersAdminUnavailableError) {
    return pmError(error.code === 'pm_signed_out' ? 'pm_signin_required' : 'pm_service_unavailable')
  }
  const prjCode = projectErrorCodeOf(error)
  if (prjCode) return pmError(prjCode)
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
 * Account gate for the R3 list read. NO committed enterprise space is
 * required — the personal-space fence is enough (the collection covers the
 * whole signed-in account, never just the committed space).
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
    // a stale dialog must never act under someone else's identity.
    throw pmError('pm_scope_changed', 'The renderer account is not the trusted account')
  }
  if (!isRuntimeFenceBoundToAccount(trustedAccountId)) {
    throw pmError('pm_signin_required', 'The committed space is not bound to this account')
  }
  return { accountId: trustedAccountId, token }
}

/**
 * Committed-organization gate for every project command. The requested
 * productSpaceId must BE the committed space (a renderer cannot probe a
 * foreign space id), the committed space must be an enterprise space, and the
 * requested organizationEnterpriseId must be THAT space's enterprise — a
 * mismatch means the renderer's organization state is stale, and the command
 * is discarded instead of forwarded. Authority itself is decided by
 * polo-admin, never by the local role cache.
 */
async function requireOrganizationScope(input: {
  accountId: string
  productSpaceId: string
  organizationEnterpriseId: string
}): Promise<ProjectMembersOrganizationScope> {
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
    throw pmError('forbidden', 'The requested space is not the committed one')
  }
  const space = activeProductSpaceReader(trustedAccountId, activeProductSpaceId)
  if (!space || space.id !== activeProductSpaceId) {
    throw pmError(PM_PRODUCT_SPACE_CONTEXT_REQUIRED, 'The active ProductSpace is not resolvable for this account')
  }
  if (space.kind !== 'enterprise') {
    throw pmError('pm_unavailable_in_personal', 'Projects are only available in an organization (enterprise) space')
  }
  if (input.organizationEnterpriseId !== space.enterpriseId) {
    throw pmError('pm_scope_changed', 'The renderer organization is not the committed organization')
  }
  return {
    accountId: trustedAccountId,
    productSpaceId: space.id,
    organizationEnterpriseId: space.enterpriseId,
    token,
  }
}

function assertOrganizationScopeCurrent(scope: ProjectMembersOrganizationScope): void {
  if (!isAccountScopeTokenCurrent(scope.token)) {
    throw pmError('pm_scope_changed', 'The trusted scope changed during the operation')
  }
}

/* ------------------------------------------------------------------ */
/* Project lifecycle commands (POO-205)                                */
/* ------------------------------------------------------------------ */

/** pm:listProjects — the committed organization's projects for this caller. */
export async function pmListProjects(input: PmListProjectsInput): Promise<ListProjectsResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().listProjects(scope.organizationEnterpriseId)
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/** pm:createProject — lightweight create; billing stays on the organization. */
export async function pmCreateProject(input: PmCreateProjectInput): Promise<ProjectMutationResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().createProject(scope.organizationEnterpriseId, input.command)
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/** pm:updateProject — PATCH semantics (absent fields stay unchanged). */
export async function pmUpdateProject(input: PmUpdateProjectInput): Promise<ProjectMutationResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().updateProject(scope.organizationEnterpriseId, input.projectId, input.command)
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/* ------------------------------------------------------------------ */
/* Project member commands (POO-205; roster-picked, no invitations)    */
/* ------------------------------------------------------------------ */

/** pm:listProjectMembers. */
export async function pmListProjectMembers(input: PmListProjectMembersInput): Promise<ListProjectMembersResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().listProjectMembers(scope.organizationEnterpriseId, input.projectId)
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/** pm:addProjectMembers — bulk pick; membership ⊆ organization is admin-enforced. */
export async function pmAddProjectMembers(input: PmAddProjectMembersInput): Promise<ListProjectMembersResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().addProjectMembers(scope.organizationEnterpriseId, input.projectId, input.command)
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/** pm:updateProjectMember — role change (`prj_last_owner` is admin-side). */
export async function pmUpdateProjectMember(input: PmUpdateProjectMemberInput): Promise<UpdateProjectMemberResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().updateProjectMember(
      scope.organizationEnterpriseId,
      input.projectId,
      input.targetAccountId,
      { role: input.role },
    )
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/** pm:removeProjectMember — leaves the project; organization membership
 * untouched. The admin answer IS the fresh roster (A1/C10): the renderer
 * replaces its state from this response instead of re-reading the list. */
export async function pmRemoveProjectMember(input: PmRemoveProjectMemberInput): Promise<RemoveProjectMemberResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().removeProjectMember(scope.organizationEnterpriseId, input.projectId, input.targetAccountId)
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/** pm:listOrganizationColleagues — the ONLY roster a project picks members
 * from; organization membership itself is admin-console-managed. */
export async function pmListOrganizationColleagues(
  input: PmListOrganizationColleaguesInput,
): Promise<ListOrganizationColleaguesResponse> {
  const scope = await requireOrganizationScope(input)
  try {
    const result = await theAdmin().listOrganizationColleagues(scope.organizationEnterpriseId)
    assertOrganizationScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}

/* ------------------------------------------------------------------ */
/* R3 command (POO-196 redesign, adjudication D3–D6 — retained)        */
/* ------------------------------------------------------------------ */

/**
 * pm:listProductSpacesR3 — D6 negotiated list read. ACCOUNT-scoped: the
 * space collection covers the whole signed-in account, never just the
 * committed space. No committed enterprise space is required — the
 * personal-space fence is enough. The v1+R3 composition is validated inside
 * the AdminClient, so a deployment that ignored the negotiation surfaces
 * here as `contract_version_unsupported`.
 */
export async function pmListProductSpacesR3(
  input: PmListProductSpacesR3Input,
): Promise<PmProductSpacesListR3Response> {
  const scope = await requireAccountScope(input)
  try {
    const result = await theAdmin().listProductSpacesR3()
    assertAccountScopeCurrent(scope)
    return result
  } catch (error) {
    throw mapAdminFailure(error)
  }
}
