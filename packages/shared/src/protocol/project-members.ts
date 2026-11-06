import { z } from 'zod'
import {
  CLIENT_ENTERPRISE_LIST_CONTRACT_QUERY_PARAMETER,
  CLIENT_ENTERPRISE_PAGE_MAX_LIMIT,
  clientCreateColleagueInvitationCommandSchema,
  clientCreateEnterpriseCommandSchema,
  clientCreateInvitationCommandSchema,
  clientEnterpriseIdempotencyKeySchema,
  clientEnterpriseListR3ResponseSchema,
  clientPageCursorSchema,
} from '../admin/client-enterprise-contract'
import { ListProductSpacesResponseSchema } from '../product-spaces/schemas'

/**
 * Enterprise project members (POO-196 追加轮, adjudication D-A/D-C) wire
 * contracts — the client side.
 *
 * Membership stays an ADMIN authority: EnterpriseMembership is the only
 * source of truth, so every HTTP DTO the AdminClient exchanges is GENERATED
 * in `../admin/client-enterprise-contract.ts` and re-exported here untouched.
 * This file adds only what the LOCAL_ONLY RPC boundary needs on top:
 *
 * - the account-scoped envelope for the two create commands (creating a
 *   project must NOT require a committed enterprise space — the caller may
 *   still be sitting in their personal space);
 * - the committed-space envelope for the roster/invitation commands (these
 *   only ever address the space the fence already committed);
 * - the `pm_*` transport error codes, re-exported for the transport
 *   whitelist in `./types.ts` (same mechanism as PC_LOCAL_ERROR_CODES).
 *
 * Identity is never a free field: the `accountId` in a scope is a consistency
 * assertion the trusted side re-proves against its own session — the server
 * never takes role, enterprise id or membership from the renderer.
 */

// The generated contract is the single source of truth for DTO shapes, page
// limits and stable error codes.
export * from '../admin/client-enterprise-contract'

/**
 * pm_* codes this client raises at its OWN boundary (never returned by the
 * admin wire, so they must not live in the generated
 * CLIENT_ENTERPRISE_ERROR_CODES):
 *
 * - `pm_unavailable_in_personal` — a roster/invitation command ran while the
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

/**
 * Account-only scope: the create commands act on the signed-in account and
 * must stay reachable from the personal space (D-B 1/4). `accountId` is what
 * the renderer believes is signed in — a mismatch with the trusted session is
 * a stale-renderer race, not an identity.
 */
export const PmAccountScopeSchema = z.object({
  accountId: PmAccountIdSchema,
}).strict()
export type PmAccountScopeInput = z.output<typeof PmAccountScopeSchema>

/**
 * Committed-space scope: the roster/invitation commands address the space the
 * runtime fence already committed, and re-prove it on every entry (D-C).
 */
export const PmSpaceScopeSchema = z.object({
  accountId: PmAccountIdSchema,
  productSpaceId: PmProductSpaceIdSchema,
}).strict()
export type PmSpaceScopeInput = z.output<typeof PmSpaceScopeSchema>

const PmPageQuerySchema = z.object({
  limit: z.number().int().min(1).max(CLIENT_ENTERPRISE_PAGE_MAX_LIMIT).optional(),
  cursor: z.string().max(256).optional(),
}).strict()

/* ------------------------------------------------------------------ */
/* Channel input schemas (LOCAL_ONLY RPC payloads)                     */
/* ------------------------------------------------------------------ */

/** pm:createEnterprise — explicit submit; the key is generated at submit time. */
export const PmCreateEnterpriseInputSchema = PmAccountScopeSchema.extend({
  command: clientCreateEnterpriseCommandSchema,
  idempotencyKey: clientEnterpriseIdempotencyKeySchema,
}).strict()
export type PmCreateEnterpriseInput = z.output<typeof PmCreateEnterpriseInputSchema>

/** pm:queryCreateReceipt — the recovery path for a lost create response. */
export const PmQueryCreateReceiptInputSchema = PmAccountScopeSchema.extend({
  createRequestKey: clientEnterpriseIdempotencyKeySchema,
}).strict()
export type PmQueryCreateReceiptInput = z.output<typeof PmQueryCreateReceiptInputSchema>

export const PmListMembersInputSchema = PmSpaceScopeSchema.extend(PmPageQuerySchema.shape).strict()
export type PmListMembersInput = z.output<typeof PmListMembersInputSchema>

export const PmListInvitationsInputSchema = PmSpaceScopeSchema.extend(PmPageQuerySchema.shape).strict()
export type PmListInvitationsInput = z.output<typeof PmListInvitationsInputSchema>

/** pm:createInvitation — one target per call; the key rides the command. */
export const PmCreateInvitationInputSchema = PmSpaceScopeSchema.extend({
  command: clientCreateInvitationCommandSchema,
}).strict()
export type PmCreateInvitationInput = z.output<typeof PmCreateInvitationInputSchema>

/* ------------------------------------------------------------------ */
/* R3 channels (POO-196 redesign, adjudication D3–D6)                  */
/* ------------------------------------------------------------------ */

/** D3: name search is resolved server-side over the FULL source directory
 * before pagination, so `q` is only a bound-checked parameter here (the admin
 * route trims and re-validates; a cross-query cursor is a server 400). */
const PmR3QuerySchema = z.object({
  q: z.string().max(128).optional(),
  limit: z.number().int().min(1).max(CLIENT_ENTERPRISE_PAGE_MAX_LIMIT).optional(),
  cursor: clientPageCursorSchema.optional(),
}).strict()

/** pm:listColleagueOptions — the restricted colleague directory of the
 * caller's own source organization, projected into the committed project.
 * The source enterprise is derived server-side and is NEVER a wire field. */
export const PmListColleagueOptionsInputSchema = PmSpaceScopeSchema.extend(
  PmR3QuerySchema.shape,
).strict()
export type PmListColleagueOptionsInput = z.output<typeof PmListColleagueOptionsInputSchema>

/** pm:listCollaborationRoster — the all-role minimal roster of the committed
 * space (D4); `q` filters the page server-side, the total count never does. */
export const PmListCollaborationRosterInputSchema = PmSpaceScopeSchema.extend(
  PmR3QuerySchema.shape,
).strict()
export type PmListCollaborationRosterInput = z.output<typeof PmListCollaborationRosterInputSchema>

/** pm:createColleagueInvitation — D5 bridge: one selected colleague per call,
 * resolved server-side onto the existing targeted invitation. The ids are
 * resource references awaiting authorization, not caller identity. */
export const PmCreateColleagueInvitationInputSchema = PmSpaceScopeSchema.extend({
  command: clientCreateColleagueInvitationCommandSchema,
}).strict()
export type PmCreateColleagueInvitationInput = z.output<typeof PmCreateColleagueInvitationInputSchema>

/** pm:queryColleagueInvitation — D5 recovery: the caller's own
 * `createRequestKey`; `unknown` (202) is a success state, not a failure. */
export const PmQueryColleagueInvitationInputSchema = PmSpaceScopeSchema.extend({
  createRequestKey: clientEnterpriseIdempotencyKeySchema,
}).strict()
export type PmQueryColleagueInvitationInput = z.output<typeof PmQueryColleagueInvitationInputSchema>

/** pm:listProductSpacesR3 — D6 negotiated list read (account-scoped: the
 * collection covers the whole account, never just the committed space). The
 * response composes the generated R3 envelope with the client's own strict v1
 * `ListProductSpacesResponseSchema`, so no new schema is declared here. */
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
