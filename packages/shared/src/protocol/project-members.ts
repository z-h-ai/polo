import { z } from 'zod'
import {
  CLIENT_ENTERPRISE_LIST_CONTRACT_QUERY_PARAMETER,
  CLIENT_ENTERPRISE_PAGE_MAX_LIMIT,
  clientEnterpriseListR3ResponseSchema,
  clientPageCursorSchema,
} from '../admin/client-enterprise-contract'
import { ListProductSpacesResponseSchema } from '../product-spaces/schemas'
import {
  AddProjectMembersInputSchema,
  CreateProjectInputSchema,
  PROJECT_ROLES,
  UpdateProjectInputSchema,
  type ProjectRole,
} from '../admin/project-contract'

/**
 * Project members & projects (POO-205, supersedes the POO-196 追加轮 surface)
 * wire contracts — the client side.
 *
 * What changed and why (owner adjudications Q3/Q8/Q10, Spec §3):
 * - Creating a project is a LIGHTWEIGHT operation inside an organization.
 *   `pm:createEnterprise` (client-side enterprise creation with payment
 *   responsibility) is RETIRED — organizations come from the admin console,
 *   never from the client.
 * - The targeted invitation flow is RETIRED. Project members are picked from
 *   the organization colleague roster; project membership ⊆ organization
 *   membership is enforced server-side (`prj_member_not_in_organization`).
 * - Projects and their members address the NEW Project entity (admin
 *   `poo205-contract-r1`), not the enterprise aggregate.
 *
 * Membership stays an ADMIN authority; the DTO shapes live in
 * `../admin/project-contract.ts` and are re-exported here untouched. This
 * file adds only what the LOCAL_ONLY RPC boundary needs:
 * - the committed-organization scope envelope (these commands only ever run
 *   while the fence has the organization space committed);
 * - the `pm_*` transport error codes, re-exported for the transport
 *   whitelist in `./types.ts`.
 *
 * Identity is never a free field: the `accountId` in a scope is a consistency
 * assertion the trusted side re-proves against its own session — the server
 * never takes role, enterprise id or membership from the renderer.
 */

// The generated contracts are the single source of truth for DTO shapes,
// page limits and stable error codes.
export * from '../admin/client-enterprise-contract'
export * from '../admin/project-contract'

/**
 * pm_* codes this client raises at its OWN boundary (never returned by the
 * admin wire, so they must not live in the contract error lists):
 *
 * - `pm_unavailable_in_personal` — a project/roster command ran while the
 *   committed space is the personal space;
 * - `pm_service_unavailable` — admin unreachable or an unmapped failure;
 * - `pm_signin_required` — no trusted admin session to act through;
 * - `pm_scope_changed` — the account/fence moved while the command was in
 *   flight, so the response was discarded instead of being published to the
 *   wrong account.
 */
export const PM_LOCAL_ERROR_CODES = [
  'pm_unavailable_in_personal',
  'pm_service_unavailable',
  'pm_signin_required',
  'pm_scope_changed',
] as const
export type PmLocalErrorCode = (typeof PM_LOCAL_ERROR_CODES)[number]

/** Same non-blank bound as the pc_* scope ids. */
const nonBlank = (maxLength: number) => z.string()
  .max(maxLength)
  .refine(value => value.trim().length > 0, 'Must be a non-blank string')

export const PmAccountIdSchema = nonBlank(512)
export const PmProductSpaceIdSchema = nonBlank(512)
export const PmEnterpriseIdSchema = nonBlank(512)
export const PmProjectIdSchema = nonBlank(512)

/**
 * Account-only scope: commands that act on the signed-in account from any
 * space. `accountId` is what the renderer believes is signed in — a mismatch
 * with the trusted session is a stale-renderer race, not an identity.
 */
export const PmAccountScopeSchema = z.object({
  accountId: PmAccountIdSchema,
}).strict()
export type PmAccountScopeInput = z.output<typeof PmAccountScopeSchema>

/**
 * Committed-organization scope: the projects/roster commands address the
 * organization space the runtime fence has committed, and re-prove it on
 * every entry.
 */
export const PmOrganizationScopeSchema = z.object({
  accountId: PmAccountIdSchema,
  productSpaceId: PmProductSpaceIdSchema,
  organizationEnterpriseId: PmEnterpriseIdSchema,
}).strict()
export type PmOrganizationScopeInput = z.output<typeof PmOrganizationScopeSchema>

/** Organization scope narrowed to one project. */
export const PmProjectScopeSchema = PmOrganizationScopeSchema.extend({
  projectId: PmProjectIdSchema,
}).strict()
export type PmProjectScopeInput = z.output<typeof PmProjectScopeSchema>

/* ------------------------------------------------------------------ */
/* Project lifecycle channels (POO-205)                                */
/* ------------------------------------------------------------------ */

/** pm:listProjects — the caller's projects in the committed organization. */
export const PmListProjectsInputSchema = PmOrganizationScopeSchema.strict()
export type PmListProjectsInput = z.output<typeof PmListProjectsInputSchema>

/** pm:createProject — lightweight create (no payer, no payment terms). */
export const PmCreateProjectInputSchema = PmOrganizationScopeSchema.extend({
  command: CreateProjectInputSchema,
}).strict()
export type PmCreateProjectInput = z.output<typeof PmCreateProjectInputSchema>

/** pm:updateProject — name/purpose/instructions (owner/manager on the wire). */
export const PmUpdateProjectInputSchema = PmProjectScopeSchema.extend({
  command: UpdateProjectInputSchema,
}).strict()
export type PmUpdateProjectInput = z.output<typeof PmUpdateProjectInputSchema>

/* ------------------------------------------------------------------ */
/* Project member channels (POO-205; roster-picked, no invitations)    */
/* ------------------------------------------------------------------ */

/** pm:listProjectMembers. */
export const PmListProjectMembersInputSchema = PmProjectScopeSchema.strict()
export type PmListProjectMembersInput = z.output<typeof PmListProjectMembersInputSchema>

/** pm:addProjectMembers — bulk pick from the organization roster. */
export const PmAddProjectMembersInputSchema = PmProjectScopeSchema.extend({
  command: AddProjectMembersInputSchema,
}).strict()
export type PmAddProjectMembersInput = z.output<typeof PmAddProjectMembersInputSchema>

/** pm:updateProjectMember — role change. */
export const PmUpdateProjectMemberInputSchema = PmProjectScopeSchema.extend({
  targetAccountId: PmAccountIdSchema,
  role: z.enum(PROJECT_ROLES),
}).strict()
export type PmUpdateProjectMemberInput = z.output<typeof PmUpdateProjectMemberInputSchema>
export type PmProjectRole = ProjectRole

/** pm:removeProjectMember — leaves the project; organization membership untouched. */
export const PmRemoveProjectMemberInputSchema = PmProjectScopeSchema.extend({
  targetAccountId: PmAccountIdSchema,
}).strict()
export type PmRemoveProjectMemberInput = z.output<typeof PmRemoveProjectMemberInputSchema>

/** pm:listOrganizationColleagues — the roster projects pick members from. */
export const PmListOrganizationColleaguesInputSchema = PmOrganizationScopeSchema.extend({
  q: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(CLIENT_ENTERPRISE_PAGE_MAX_LIMIT).optional(),
  cursor: clientPageCursorSchema.optional(),
}).strict()
export type PmListOrganizationColleaguesInput = z.output<typeof PmListOrganizationColleaguesInputSchema>

/* ------------------------------------------------------------------ */
/* R3 channels (POO-196 redesign, adjudication D3–D6 — list only)      */
/* ------------------------------------------------------------------ */

/** pm:listProductSpacesR3 — D6 negotiated list read (account-scoped: the
 * collection covers the whole account, never just the committed space). The
 * response composes the generated R3 envelope with the client's own strict v1
 * `ListProductSpacesResponseSchema`, so no new schema is declared here.
 * POO-205: after the one-shot migration every enterprise is an organization;
 * the R3 metadata (purpose/activeMemberCount) remains the switcher's source. */
export const PmListProductSpacesR3InputSchema = PmAccountScopeSchema.strict()
export type PmListProductSpacesR3Input = z.output<typeof PmListProductSpacesR3InputSchema>

/** The exact query parameter and version literal the negotiated list request
 * carries; the AdminClient owns the composition (see listProductSpacesR3). */
export const PM_LIST_CONTRACT_QUERY_PARAMETER = CLIENT_ENTERPRISE_LIST_CONTRACT_QUERY_PARAMETER

/**
 * pm:listProductSpacesR3 response (D6): the client-side composition of the
 * generated R3 envelope with this client's OWN strict v1
 * `ListProductSpacesResponse`. The generated envelope deliberately leaves
 * `spaces` unknown (it is self-contained and cannot re-declare the published
 * v1 schema), so the negotiated response is only trusted after BOTH halves
 * parse and the metadata join is exact: one summary per enterprise space,
 * ids matching one-to-one (productSpaceId AND enterpriseId), no duplicates,
 * no metadata for personal or foreign spaces. A default v1 body (no R3
 * envelope) fails THIS schema — that is the version-unsupported face, never a
 * silently degraded success.
 */
export const PmProductSpacesListR3ResponseSchema =
  clientEnterpriseListR3ResponseSchema.extend({
    spaces: ListProductSpacesResponseSchema,
  }).superRefine((value, ctx) => {
    const enterpriseSpaces = new Map(
      value.spaces.productSpaces
        .filter(space => space.kind === 'enterprise')
        .map(space => [space.id as string, space]),
    );
    const seen = new Set<string>();
    for (const [index, summary] of value.enterpriseSummaries.entries()) {
      if (seen.has(summary.productSpaceId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['enterpriseSummaries', index, 'productSpaceId'],
          message: 'Enterprise summaries must be unique per ProductSpace',
        });
        continue;
      }
      seen.add(summary.productSpaceId);
      const space = enterpriseSpaces.get(summary.productSpaceId);
      if (!space || space.kind !== 'enterprise' || space.enterpriseId !== summary.enterpriseId) {
        ctx.addIssue({
          code: 'custom',
          path: ['enterpriseSummaries', index, 'productSpaceId'],
          message: 'Every enterprise summary must match exactly one enterprise ProductSpace in the list',
        });
      }
    }
    if (seen.size !== enterpriseSpaces.size) {
      ctx.addIssue({
        code: 'custom',
        path: ['enterpriseSummaries'],
        message: 'Enterprise summaries must cover every enterprise ProductSpace in the list',
      });
    }
  })
export type PmProductSpacesListR3Response = z.output<typeof PmProductSpacesListR3ResponseSchema>
