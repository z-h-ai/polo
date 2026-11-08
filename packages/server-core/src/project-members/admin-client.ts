import { AdminClient, AdminError } from '@polo-ai/shared/admin'
import { getAdminUrl } from '@polo-ai/shared/config'
import { getCredentialManager } from '@polo-ai/shared/credentials'
import {
  CLIENT_ENTERPRISE_ERROR_CODES,
  type ClientEnterpriseErrorCode,
} from '@polo-ai/shared/admin/client-enterprise-contract'
import type {
  AddProjectMembersInput,
  CreateProjectInput,
  ListOrganizationColleaguesResponse,
  ListProjectMembersResponse,
  ListProjectsResponse,
  PmProductSpacesListR3Response,
  ProjectMutationResponse,
  UpdateProjectInput,
  UpdateProjectMemberInput,
  UpdateProjectMemberResponse,
} from '@polo-ai/shared/protocol'
import { PROJECT_ERROR_CODES, type ProjectErrorCode } from '@polo-ai/shared/protocol'

/**
 * The project-members admin adapter (POO-205; supersedes the POO-196 追加轮
 * surface).
 *
 * Same shape as the project-context adapter: the desktop never holds
 * enterprise administration credentials — it rides the signed-in member's
 * admin session through the narrow client Bearer surface. Failure shape:
 * admin-unreachable / signed-out resolve per-call and the service turns them
 * into stable pm_* codes; nothing here invents fallbacks.
 *
 * POO-205: the control plane is the organization-scoped project/entity
 * (`poo205-contract-r1`). Project lifecycle and membership address the NEW
 * Project entity keyed by (organizationEnterpriseId, projectId) — project
 * members ⊆ organization members is enforced admin-side
 * (`prj_member_not_in_organization`). Enterprise creation, receipts and every
 * invitation flow are RETIRED. The POO-196 R3 negotiated product-space list
 * read remains (still the space switcher's source).
 */

const PM_REQUEST_TIMEOUT_MS = 15_000

export interface ProjectMembersAdmin {
  /** GET /api/client/organizations/{orgId}/projects — the caller's projects. */
  listProjects(organizationEnterpriseId: string): Promise<ListProjectsResponse>
  /** POST /api/client/organizations/{orgId}/projects — lightweight create. */
  createProject(organizationEnterpriseId: string, input: CreateProjectInput): Promise<ProjectMutationResponse>
  /** PATCH /api/client/organizations/{orgId}/projects/{projectId} — name/purpose/instructions. */
  updateProject(organizationEnterpriseId: string, projectId: string, input: UpdateProjectInput): Promise<ProjectMutationResponse>
  /** GET .../projects/{projectId}/members. */
  listProjectMembers(organizationEnterpriseId: string, projectId: string): Promise<ListProjectMembersResponse>
  /** POST .../projects/{projectId}/members — bulk pick from the organization roster. */
  addProjectMembers(organizationEnterpriseId: string, projectId: string, input: AddProjectMembersInput): Promise<ListProjectMembersResponse>
  /** PATCH .../projects/{projectId}/members/{accountId} — role change. */
  updateProjectMember(organizationEnterpriseId: string, projectId: string, accountId: string, input: UpdateProjectMemberInput): Promise<UpdateProjectMemberResponse>
  /** DELETE .../projects/{projectId}/members/{accountId} — leaves the project only. */
  removeProjectMember(organizationEnterpriseId: string, projectId: string, accountId: string): Promise<{ ok: true }>
  /** GET /api/client/organizations/{orgId}/colleagues — the ONLY roster a
   * project may pick members from. */
  listOrganizationColleagues(organizationEnterpriseId: string): Promise<ListOrganizationColleaguesResponse>
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
 * response (still reachable through the retained R3 list read). Codes the
 * admin client's alias table normalized to a legacy uppercase spelling are
 * NOT returned here — the service maps those. */
export function clientEnterpriseErrorCodeOf(error: unknown): ClientEnterpriseErrorCode | null {
  if (error instanceof AdminError) {
    const code = (error as unknown as { errorCode?: unknown }).errorCode
    if (typeof code === 'string' && (CLIENT_ENTERPRISE_ERROR_CODES as readonly string[]).includes(code)) {
      return code as ClientEnterpriseErrorCode
    }
  }
  return null
}

/** The admin error's stable poo205-contract-r1 wire code (`prj_*` /
 * `myapps_*`), when one rode the response. These pass through verbatim so the
 * renderer's recovery copy can branch on the frozen contract vocabulary. */
export function projectErrorCodeOf(error: unknown): ProjectErrorCode | null {
  if (error instanceof AdminError) {
    const code = (error as unknown as { errorCode?: unknown }).errorCode
    if (typeof code === 'string' && (PROJECT_ERROR_CODES as readonly string[]).includes(code)) {
      return code as ProjectErrorCode
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
    listProjects: organizationEnterpriseId =>
      withAdmin((client, token) => client.listProjects(token, organizationEnterpriseId)),
    createProject: (organizationEnterpriseId, input) =>
      withAdmin((client, token) => client.createProject(token, organizationEnterpriseId, input)),
    updateProject: (organizationEnterpriseId, projectId, input) =>
      withAdmin((client, token) => client.updateProject(token, organizationEnterpriseId, projectId, input)),
    listProjectMembers: (organizationEnterpriseId, projectId) =>
      withAdmin((client, token) => client.listProjectMembers(token, organizationEnterpriseId, projectId)),
    addProjectMembers: (organizationEnterpriseId, projectId, input) =>
      withAdmin((client, token) => client.addProjectMembers(token, organizationEnterpriseId, projectId, input)),
    updateProjectMember: (organizationEnterpriseId, projectId, accountId, input) =>
      withAdmin((client, token) => client.updateProjectMember(token, organizationEnterpriseId, projectId, accountId, input)),
    removeProjectMember: (organizationEnterpriseId, projectId, accountId) =>
      withAdmin((client, token) => client.removeProjectMember(token, organizationEnterpriseId, projectId, accountId)),
    listOrganizationColleagues: organizationEnterpriseId =>
      withAdmin((client, token) => client.listOrganizationColleagues(token, organizationEnterpriseId)),
    listProductSpacesR3: () =>
      withAdmin((client, token) => client.listProductSpacesR3(token)),
  }
}
