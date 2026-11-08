import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import {
  PmAddProjectMembersInputSchema,
  PmCreateProjectInputSchema,
  PmListOrganizationColleaguesInputSchema,
  PmListProductSpacesR3InputSchema,
  PmListProjectMembersInputSchema,
  PmListProjectsInputSchema,
  PmRemoveProjectMemberInputSchema,
  PmUpdateProjectInputSchema,
  PmUpdateProjectMemberInputSchema,
} from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { RequestContext } from '@polo-ai/server-core/transport'
import {
  pmAddProjectMembers,
  pmCreateProject,
  pmError,
  pmListOrganizationColleagues,
  pmListProductSpacesR3,
  pmListProjectMembers,
  pmListProjects,
  pmRemoveProjectMember,
  pmUpdateProject,
  pmUpdateProjectMember,
} from '../../project-members/service'

/**
 * POO-205 project-members RPC handlers (supersedes the POO-196 追加轮
 * surface; the R3 list read per POO-196 redesign D3–D6 is retained).
 *
 * Every channel is LOCAL_ONLY and gated in the service layer — the handler
 * bodies are thin: parse the shared protocol schema, delegate. The project
 * commands re-prove the committed-organization fence on EVERY entry
 * (productSpaceId IS the committed space, the space is an enterprise space,
 * organizationEnterpriseId matches it) and let polo-admin decide the role
 * authority — project membership ⊆ organization membership is enforced
 * admin-side (`prj_member_not_in_organization`). Nothing here is exposed as
 * an agent tool.
 */

/** Manifest of every channel this module registers (registration coverage
 * test consumes this; keep in sync with the server.handle calls below). */
export const PROJECT_MEMBERS_HANDLED_CHANNELS = [
  RPC_CHANNELS.projectMembers.LIST_PROJECTS,
  RPC_CHANNELS.projectMembers.CREATE_PROJECT,
  RPC_CHANNELS.projectMembers.UPDATE_PROJECT,
  RPC_CHANNELS.projectMembers.LIST_PROJECT_MEMBERS,
  RPC_CHANNELS.projectMembers.ADD_PROJECT_MEMBERS,
  RPC_CHANNELS.projectMembers.UPDATE_PROJECT_MEMBER,
  RPC_CHANNELS.projectMembers.REMOVE_PROJECT_MEMBER,
  RPC_CHANNELS.projectMembers.LIST_ORGANIZATION_COLLEAGUES,
  RPC_CHANNELS.projectMembers.LIST_PRODUCT_SPACES_R3,
] as const

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, raw: unknown): T {
  const input = schema.safeParse(raw)
  if (!input.success || input.data === undefined) throw pmError('validation_error')
  return input.data
}

export function registerProjectMembersHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.projectMembers.LIST_PROJECTS, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmListProjects(parseOrThrow(PmListProjectsInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.CREATE_PROJECT, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmCreateProject(parseOrThrow(PmCreateProjectInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.UPDATE_PROJECT, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmUpdateProject(parseOrThrow(PmUpdateProjectInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.LIST_PROJECT_MEMBERS, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmListProjectMembers(parseOrThrow(PmListProjectMembersInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.ADD_PROJECT_MEMBERS, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmAddProjectMembers(parseOrThrow(PmAddProjectMembersInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.UPDATE_PROJECT_MEMBER, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmUpdateProjectMember(parseOrThrow(PmUpdateProjectMemberInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.REMOVE_PROJECT_MEMBER, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmRemoveProjectMember(parseOrThrow(PmRemoveProjectMemberInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.LIST_ORGANIZATION_COLLEAGUES, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmListOrganizationColleagues(parseOrThrow(PmListOrganizationColleaguesInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.LIST_PRODUCT_SPACES_R3, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmListProductSpacesR3(parseOrThrow(PmListProductSpacesR3InputSchema, rawInput))
  })
}
