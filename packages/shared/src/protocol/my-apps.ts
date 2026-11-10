import { z } from 'zod'
import {
  CreateMyAppInputSchema,
  DeleteMyAppResponseSchema,
  ListMyAppsResponseSchema,
  MyAppMutationResponseSchema,
  PublishMyAppResponseSchema,
  WithdrawMyAppResponseSchema,
  type CreateMyAppInput,
  type DeleteMyAppResponse,
  type ListMyAppsResponse,
  type MyAppMutationResponse,
  type PublishMyAppResponse,
  type WithdrawMyAppResponse,
} from '../admin/project-contract'

/**
 * Member apps (POO-205, Q7/Q11) LOCAL_ONLY RPC payloads — the client side.
 *
 * Each space has a "我的应用" area: the member's own apps (visibility
 * `member`, never listed to anyone else) plus a publish action that turns one
 * of them into a space-shared catalog entry (enterprise spaces only, into the
 * CURRENT space — there is no target picker) and a withdraw action that
 * reverts it, leaving member-side tombstones for anyone who had it pinned.
 *
 * DTO shapes come from the client-held `poo205-contract-r1`; this file adds
 * the LOCAL_ONLY envelope (scope + command) and the transport error codes.
 */

export * from '../admin/project-contract'

/**
 * myapps_* codes this client raises at its OWN boundary (never returned by
 * the admin wire):
 * - `myapps_unavailable_in_personal_publish` — reserved for renderer-side
 *   entry hiding; the wire already carries `myapps_publish_unavailable_in_personal`.
 * - `myapps_service_unavailable` / `myapps_signin_required` /
 *   `myapps_scope_changed` — same semantics as the pc_/pm_ families.
 */
export const MYAPPS_LOCAL_ERROR_CODES = [
  'myapps_service_unavailable',
  'myapps_signin_required',
  'myapps_scope_changed',
] as const
export type MyAppsLocalErrorCode = (typeof MYAPPS_LOCAL_ERROR_CODES)[number]

const nonBlank = (maxLength: number) => z.string()
  .max(maxLength)
  .refine(value => value.trim().length > 0, 'Must be a non-blank string')

export const MyAppsAccountIdSchema = nonBlank(512)
export const MyAppsWorkspaceIdSchema = nonBlank(512)
export const MyAppsProductSpaceIdSchema = nonBlank(512)
export const MyAppsAppIdSchema = nonBlank(512)

/**
 * Committed-space scope: the my-apps commands address the space the runtime
 * fence has committed, and re-prove it on every entry.
 */
export const MyAppsSpaceScopeSchema = z.object({
  accountId: MyAppsAccountIdSchema,
  workspaceId: MyAppsWorkspaceIdSchema,
  productSpaceId: MyAppsProductSpaceIdSchema,
}).strict()
export type MyAppsSpaceScopeInput = z.output<typeof MyAppsSpaceScopeSchema>

/** myapps:list */
export const MyAppsListInputSchema = MyAppsSpaceScopeSchema.strict()
export type MyAppsListInput = z.output<typeof MyAppsListInputSchema>

/** myapps:create — trusted side packages the upload (name/description ride
 * the wire; the bundle payload never does: the renderer hands a filePath and
 * the trusted main side reads, zips and uploads it, mirroring the pc_upload
 * discipline where bytes never transit the renderer). */
export const MyAppsCreateFromFileInputSchema = MyAppsSpaceScopeSchema.extend({
  /** Local directory or single-file path of the static bundle. The trusted
   * side validates the layout (index.html at root) before upload. */
  sourcePath: z.string().min(1).max(4_096),
  name: z.string().trim().min(1).max(256),
  description: z.string().max(2_000).optional(),
  /** POO-205 X8 (§5): the A3b idempotency key — the same session+canvas
   * re-saves as a NEW VERSION of one row (admin answers 200) instead of a
   * duplicate row (201). The GenUiAppPublishBridge always sends it; without
   * this field the strict envelope rejected every save with VALIDATION_ERROR
   * (masked by X7's packaging failure until that was fixed). */
  sourceKey: z.string().min(1).max(256).optional(),
}).strict()
export type MyAppsCreateFromFileInput = z.output<typeof MyAppsCreateFromFileInputSchema>

/** myapps:publish — member → space. Enterprise spaces only. */
export const MyAppsPublishInputSchema = MyAppsSpaceScopeSchema.extend({
  appId: MyAppsAppIdSchema,
}).strict()
export type MyAppsPublishInput = z.output<typeof MyAppsPublishInputSchema>

/** myapps:withdraw — space → member. */
export const MyAppsWithdrawInputSchema = MyAppsSpaceScopeSchema.extend({
  appId: MyAppsAppIdSchema,
}).strict()
export type MyAppsWithdrawInput = z.output<typeof MyAppsWithdrawInputSchema>

/** myapps:delete — remove the member app row entirely (POO-205 C12). A
 * published app is withdrawn in the same admin-side transaction, so the
 * space catalog loses the shared entry too. */
export const MyAppsDeleteInputSchema = MyAppsSpaceScopeSchema.extend({
  appId: MyAppsAppIdSchema,
}).strict()
export type MyAppsDeleteInput = z.output<typeof MyAppsDeleteInputSchema>

/** Response re-exports kept concrete for the preload type surface. */
export type MyAppsListResponse = ListMyAppsResponse
export type MyAppsMutationResponse = MyAppMutationResponse
/** The create answer carries the A3b idempotency verdict beside the mutation
 * body: 201 = a NEW app row, 200 = a NEW VERSION of the sourceKey-addressed
 * row. Transport metadata from the trusted side — never an admin wire field. */
export type MyAppsCreateFromFileResponse = MyAppMutationResponse & { status: number }
export type MyAppsPublishResponse = PublishMyAppResponse
export type MyAppsWithdrawResponse = WithdrawMyAppResponse
export type MyAppsDeleteResponse = DeleteMyAppResponse
export type MyAppsCreateCommand = CreateMyAppInput
