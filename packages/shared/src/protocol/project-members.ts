import { z } from 'zod'
import {
  CLIENT_ENTERPRISE_PAGE_MAX_LIMIT,
  clientCreateEnterpriseCommandSchema,
  clientCreateInvitationCommandSchema,
  clientEnterpriseIdempotencyKeySchema,
} from '../admin/client-enterprise-contract'

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
