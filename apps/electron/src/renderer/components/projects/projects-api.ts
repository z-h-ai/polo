import type { PmCreateProjectInput, PmOrganizationScopeInput, PmUpdateProjectInput } from '@polo-ai/shared/protocol'
import { readRpcErrorCode } from '../../../shared/rpc-error-bridge'

/**
 * POO-205 shared error presentation for the pm:* project channels
 * (`prj_*` wire codes + the `pm_*` local boundary codes). One mapping so the
 * create dialog, the project settings view and the member management surfaces
 * classify identically — never a raw code on screen.
 */

/** Stable i18n key for a pm project-channel failure. */
export function projectActionErrorKey(code: string | null): string {
  switch (code) {
    case 'prj_forbidden':
    case 'forbidden':
      return 'poo205.projects.error.forbidden'
    case 'prj_not_found':
    case 'not_found':
      return 'projectMembers.error.notFound'
    case 'prj_member_not_in_organization':
      return 'poo205.members.notInOrganization'
    case 'prj_last_owner':
      return 'poo205.members.lastOwner'
    case 'prj_space_mismatch':
    case 'pm_scope_changed':
      return 'projectMembers.error.scopeChanged'
    case 'pm_unavailable_in_personal':
      return 'projectMembers.error.spaceRequired'
    case 'pm_signin_required':
    case 'unauthorized':
    case 'token_revoked':
    case 'account_disabled':
    case 'prj_signin_required':
      return 'projectMembers.error.signinRequired'
    case 'prj_validation_error':
    case 'validation_error':
    case 'pm_service_unavailable':
    case 'prj_service_unavailable':
    default:
      return 'poo205.projects.error.generic'
  }
}

/** Read + classify in one call (the context-bridge marker discipline). */
export function projectActionErrorKeyOf(error: unknown): string {
  return projectActionErrorKey(readRpcErrorCode(error))
}

/** The committed-organization scope envelope every pm project command needs. */
export function organizationScope(accountId: string, productSpaceId: string, organizationEnterpriseId: string): PmOrganizationScopeInput {
  return { accountId, productSpaceId, organizationEnterpriseId }
}

/** pm:createProject — lightweight create inside the committed organization. */
export function createProjectInput(scope: PmOrganizationScopeInput, command: { name: string; purpose?: string }): PmCreateProjectInput {
  return {
    ...scope,
    command: {
      name: command.name,
      ...(command.purpose && command.purpose.length > 0 ? { purpose: command.purpose } : {}),
    },
  }
}

/** pm:updateProject — PATCH semantics on name/purpose/instructions. */
export function updateProjectInput(scope: PmOrganizationScopeInput, projectId: string, command: PmUpdateProjectInput['command']): PmUpdateProjectInput {
  return { ...scope, projectId, command }
}
