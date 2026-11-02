import { RPC_CHANNELS } from '@polo-ai/shared/protocol'
import {
  PmCreateEnterpriseInputSchema,
  PmCreateInvitationInputSchema,
  PmListInvitationsInputSchema,
  PmListMembersInputSchema,
  PmQueryCreateReceiptInputSchema,
} from '@polo-ai/shared/protocol'
import type { RpcServer } from '@polo-ai/server-core/transport'
import type { RequestContext } from '@polo-ai/server-core/transport'
import {
  pmCreateEnterprise,
  pmCreateProjectInvitation,
  pmError,
  pmListProjectInvitations,
  pmListProjectMembers,
  pmQueryCreateReceipt,
} from '../../project-members/service'

/**
 * POO-196 追加轮 project-members RPC handlers (adjudication D-A/D-B/D-C).
 *
 * Every channel is LOCAL_ONLY and gated in the service layer — the handler
 * bodies are thin: parse the shared protocol schema, delegate. The account
 * commands are gated on the trusted Admin session WITHOUT an enterprise
 * fence; the roster/invitation commands re-prove the committed space fence on
 * EVERY entry. Nothing here is exposed as an agent tool.
 */

/** Manifest of every channel this module registers (registration coverage
 * test consumes this; keep in sync with the server.handle calls below). */
export const PROJECT_MEMBERS_HANDLED_CHANNELS = [
  RPC_CHANNELS.projectMembers.CREATE_ENTERPRISE,
  RPC_CHANNELS.projectMembers.QUERY_CREATE_RECEIPT,
  RPC_CHANNELS.projectMembers.LIST_MEMBERS,
  RPC_CHANNELS.projectMembers.LIST_INVITATIONS,
  RPC_CHANNELS.projectMembers.CREATE_INVITATION,
] as const

function parseOrThrow<T>(schema: { safeParse(input: unknown): { success: boolean; data?: T } }, raw: unknown): T {
  const input = schema.safeParse(raw)
  if (!input.success || input.data === undefined) throw pmError('validation_error')
  return input.data
}

export function registerProjectMembersHandlers(server: RpcServer): void {
  server.handle(RPC_CHANNELS.projectMembers.CREATE_ENTERPRISE, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmCreateEnterprise(parseOrThrow(PmCreateEnterpriseInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.QUERY_CREATE_RECEIPT, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmQueryCreateReceipt(parseOrThrow(PmQueryCreateReceiptInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.LIST_MEMBERS, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmListProjectMembers(parseOrThrow(PmListMembersInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.LIST_INVITATIONS, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmListProjectInvitations(parseOrThrow(PmListInvitationsInputSchema, rawInput))
  })

  server.handle(RPC_CHANNELS.projectMembers.CREATE_INVITATION, async (_ctx: RequestContext, rawInput: unknown) => {
    return pmCreateProjectInvitation(parseOrThrow(PmCreateInvitationInputSchema, rawInput))
  })
}
