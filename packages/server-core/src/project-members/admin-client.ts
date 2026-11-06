import { AdminClient, AdminError } from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import {
  CLIENT_ENTERPRISE_ERROR_CODES,
  type ClientColleagueInvitationReceipt,
  type ClientColleagueOptionsResponse,
  type ClientCollaborationRosterResponse,
  type ClientCreateColleagueInvitationCommand,
  type ClientCreateColleagueInvitationResponse,
  type ClientCreateEnterpriseCommand,
  type ClientCreateEnterpriseResponse,
  type ClientCreateInvitationCommand,
  type ClientCreateInvitationResponse,
  type ClientCreateReceipt,
  type ClientEnterpriseErrorCode,
  type ClientInvitationListResponse,
  type ClientMemberRosterResponse,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import type { PmProductSpacesListR3Response } from '@polo-ai/shared/protocol'

/**
 * The project-members admin adapter (POO-196 追加轮, adjudication D-A).
 *
 * Same shape as the project-context adapter: the desktop never holds
 * enterprise administration credentials — it rides the signed-in member's
 * admin session through the narrow client Bearer surface admin exposed for
 * this round. Failure shape: admin-unreachable / signed-out resolve per-call
 * and the service turns them into stable pm_* codes; nothing here invents
 * fallbacks.
 *
 * POO-196 R3 (D3–D6): the colleague directory / collaboration roster reads,
 * the per-object colleague invitation bridge with its recovery query, and the
 * negotiated R3 product-space list read ride the same adapter.
 */

const PM_REQUEST_TIMEOUT_MS = 15_000

export interface ProjectMembersAdmin {
  createEnterprise(input: ClientCreateEnterpriseCommand & { idempotencyKey: string }): Promise<ClientCreateEnterpriseResponse>
  queryMyCreateReceipt(createRequestKey: string): Promise<ClientCreateReceipt>
  listProjectMembers(productSpaceId: string, query: { limit?: number; cursor?: string }): Promise<ClientMemberRosterResponse>
  listProjectInvitations(productSpaceId: string, query: { limit?: number; cursor?: string }): Promise<ClientInvitationListResponse>
  createProjectInvitation(productSpaceId: string, input: ClientCreateInvitationCommand): Promise<ClientCreateInvitationResponse>
  /** R3 (D3): the caller's own organization projected into the target project. */
  listColleagueOptions(productSpaceId: string, query: { q?: string; limit?: number; cursor?: string }): Promise<ClientColleagueOptionsResponse>
  /** R3 (D4): the all-role minimal roster of the target project. */
  listCollaborationRoster(productSpaceId: string, query: { q?: string; limit?: number; cursor?: string }): Promise<ClientCollaborationRosterResponse>
  /** R3 (D5): one selected colleague per call, resolved server-side. */
  createColleagueInvitation(productSpaceId: string, input: ClientCreateColleagueInvitationCommand): Promise<ClientCreateColleagueInvitationResponse>
  /** R3 (D5): recovery query for the caller's own createRequestKey. */
  queryColleagueInvitation(productSpaceId: string, createRequestKey: string): Promise<ClientColleagueInvitationReceipt>
  /** R3 (D6): negotiated R3 product-space list for the signed-in account. */
  listProductSpacesR3(): Promise<PmProductSpacesListR3Response>
}

export class ProjectMembersAdminUnavailableError extends Error {
  readonly code: 'pm_admin_unreachable' | 'pm_signed_out'
  constructor(code: 'pm_admin_unreachable' | 'pm_signed_out', message: string) {
    super(message)
    this.name = 'ProjectMembersAdminUnavailableError'
    this.code = code
  }
}

/** The admin error's stable client-enterprise wire code, when one rode the
 * response. Codes the admin client's alias table normalized to a legacy
 * uppercase spelling are NOT returned here — the service maps those. */
export function clientEnterpriseErrorCodeOf(error: unknown): ClientEnterpriseErrorCode | null {
  if (error instanceof AdminError) {
    const code = (error as unknown as { errorCode?: unknown }).errorCode
    if (typeof code === 'string' && (CLIENT_ENTERPRISE_ERROR_CODES as readonly string[]).includes(code)) {
      return code as ClientEnterpriseErrorCode
    }
  }
  return null
}

async function withAdmin<T>(run: (client: AdminClient, accessToken: string) => Promise<T>): Promise<T> {
  const adminUrl = getAdminUrl()
  if (!adminUrl) {
    throw new ProjectMembersAdminUnavailableError('pm_admin_unreachable', 'No admin server is configured')
  }
  let accessToken: string | null = null
  try {
    const tokens = await getCredentialManager().getAdminTokens()
    accessToken = tokens?.accessToken ?? null
  } catch {
    accessToken = null
  }
  if (!accessToken) {
    throw new ProjectMembersAdminUnavailableError('pm_signed_out', 'No signed-in admin session is available')
  }
  return run(new AdminClient(adminUrl, { requestTimeoutMs: PM_REQUEST_TIMEOUT_MS }), accessToken)
}

/** The live adapter used by the RPC handlers. */
export function getProjectMembersAdmin(): ProjectMembersAdmin {
  return {
    createEnterprise: input =>
      withAdmin((client, token) => client.createEnterprise(token, input)),
    queryMyCreateReceipt: createRequestKey =>
      withAdmin((client, token) => client.queryMyCreateReceipt(token, createRequestKey)),
    listProjectMembers: (productSpaceId, query) =>
      withAdmin((client, token) => client.listProjectMembers(token, productSpaceId, query)),
    listProjectInvitations: (productSpaceId, query) =>
      withAdmin((client, token) => client.listProjectInvitations(token, productSpaceId, query)),
    createProjectInvitation: (productSpaceId, input) =>
      withAdmin((client, token) => client.createProjectInvitation(token, productSpaceId, input)),
    listColleagueOptions: (productSpaceId, query) =>
      withAdmin((client, token) => client.listColleagueOptions(token, productSpaceId, query)),
    listCollaborationRoster: (productSpaceId, query) =>
      withAdmin((client, token) => client.listCollaborationRoster(token, productSpaceId, query)),
    createColleagueInvitation: (productSpaceId, input) =>
      withAdmin((client, token) => client.createColleagueInvitation(token, productSpaceId, input)),
    queryColleagueInvitation: (productSpaceId, createRequestKey) =>
      withAdmin((client, token) => client.queryColleagueInvitation(token, productSpaceId, createRequestKey)),
    listProductSpacesR3: () =>
      withAdmin((client, token) => client.listProductSpacesR3(token)),
  }
}
