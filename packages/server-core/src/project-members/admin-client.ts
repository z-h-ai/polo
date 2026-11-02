import { AdminClient, AdminError } from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import {
  CLIENT_ENTERPRISE_ERROR_CODES,
  type ClientCreateEnterpriseCommand,
  type ClientCreateEnterpriseResponse,
  type ClientCreateInvitationCommand,
  type ClientCreateInvitationResponse,
  type ClientCreateReceipt,
  type ClientEnterpriseErrorCode,
  type ClientInvitationListResponse,
  type ClientMemberRosterResponse,
} from '@polo-ai/shared/admin/client-enterprise-contract'

/**
 * The project-members admin adapter (POO-196 追加轮, adjudication D-A).
 *
 * Same shape as the project-context adapter: the desktop never holds
 * enterprise administration credentials — it rides the signed-in member's
 * admin session through the narrow client Bearer surface admin exposed for
 * this round. Failure shape: admin-unreachable / signed-out resolve per-call
 * and the service turns them into stable pm_* codes; nothing here invents
 * fallbacks.
 */

const PM_REQUEST_TIMEOUT_MS = 15_000

export interface ProjectMembersAdmin {
  createEnterprise(input: ClientCreateEnterpriseCommand & { idempotencyKey: string }): Promise<ClientCreateEnterpriseResponse>
  queryMyCreateReceipt(createRequestKey: string): Promise<ClientCreateReceipt>
  listProjectMembers(productSpaceId: string, query: { limit?: number; cursor?: string }): Promise<ClientMemberRosterResponse>
  listProjectInvitations(productSpaceId: string, query: { limit?: number; cursor?: string }): Promise<ClientInvitationListResponse>
  createProjectInvitation(productSpaceId: string, input: ClientCreateInvitationCommand): Promise<ClientCreateInvitationResponse>
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
  }
}
