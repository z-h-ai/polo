// POO-205 project & my-apps HTTP contract — SINGLE SOURCE OF TRUTH.
// Contract: poo205-contract-r1 (frozen 2026-11-08, owner AGREE on
// docs/plans/poo-205-space-interaction/contract-draft.md).
//
// polo-admin implements the server side against this file; the client's
// AdminClient consumes it. Unlike POO-196 (admin-generated), this contract is
// client-held this round: both repos review THIS file, then admin implements.
// Rules mirrored from project-context-contract.ts:
// - self-contained: `zod` is the ONLY import;
// - every object schema is `.strict()`;
// - error codes are stable: never rename, only append.
import { z } from 'zod'

export const PROJECT_CONTRACT_VERSION = 'poo205-contract-r1'

/**
 * Error codes this surface may put on the wire. The client's i18n and
 * recovery UI branch on these; anything outside the list maps to a neutral
 * generic failure. Never rename, only append.
 */
export const PROJECT_ERROR_CODES = [
  'prj_forbidden',
  'prj_not_found',
  'prj_validation_error',
  'prj_space_mismatch',
  'prj_member_not_in_organization',
  'prj_last_owner',
  'prj_service_unavailable',
  'prj_signin_required',
  'myapps_forbidden',
  'myapps_not_found',
  'myapps_validation_error',
  'myapps_publish_unavailable_in_personal',
  'myapps_quota_exceeded',
  'myapps_payload_invalid',
  'myapps_payload_too_large',
  'myapps_service_unavailable',
  'myapps_signin_required',
  // POO-205 A3b: the space write gate (governance suspension, closing,
  // billing overdue) refuses saves AND publishes with this 409 code.
  'myapps_space_restricted',
] as const
export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number]

/* ------------------------------------------------------------------ */
/* Shared vocabulary                                                   */
/* ------------------------------------------------------------------ */

export const PROJECT_ROLES = ['owner', 'manager', 'member'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

/** Visibility of a catalog app entry (POO-205): `space` = published and
 * visible to every space member; `member` = "my apps", private to its owner. */
export const CATALOG_APP_VISIBILITY = ['space', 'member'] as const
export type CatalogAppVisibility = (typeof CATALOG_APP_VISIBILITY)[number]

/** Wire limits. `instructions` cap aligns with the PC summary budget
 * (16 KB per-send context envelope; instructions must fit well inside). */
export const PROJECT_NAME_MAX_CHARS = 256
export const PROJECT_PURPOSE_MAX_CHARS = 2_000
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 8_192
export const PROJECT_LIST_LIMIT_MAX = 500
export const MYAPPS_NAME_MAX_CHARS = 256
export const MYAPPS_DESCRIPTION_MAX_CHARS = 2_000
/** Bundle payload ceiling (base64 in, bytes out): 20 MB. */
export const MYAPPS_PAYLOAD_MAX_BYTES = 20 * 1024 * 1024
/** Beta: no enforced quota yet; server may return myapps_quota_exceeded
 * once a real limit lands. Validation seat only. */
export const MYAPPS_COUNT_SOFT_LIMIT = 200

const nonBlank = (max: number) => z.string().trim().min(1).max(max)
const isoTimestamp = z.string().datetime({ offset: true })
const checksum64 = z.string().regex(/^[0-9a-f]{64}$/)

/* ------------------------------------------------------------------ */
/* Project entity                                                      */
/* ------------------------------------------------------------------ */

export const ProjectSchema = z.object({
  id: z.string().min(1),
  /** Organization (enterprise space) this project belongs to. */
  organizationEnterpriseId: z.string().min(1),
  /** ProductSpace id of the organization; redundant so the client can run
   * its space-boundary checks without an extra lookup. */
  organizationProductSpaceId: z.string().min(1),
  name: nonBlank(PROJECT_NAME_MAX_CHARS),
  purpose: z.string().max(PROJECT_PURPOSE_MAX_CHARS).optional(),
  /** Project instructions injected into every project session's system
   * prompt (Q12). Absent = no custom instructions. */
  instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX_CHARS).optional(),
  createdByAccountId: z.string().min(1),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}).strict()
export type Project = z.output<typeof ProjectSchema>

export const ProjectSummarySchema = ProjectSchema.extend({
  /** Caller's role in this project. */
  myRole: z.enum(PROJECT_ROLES),
  memberCount: z.number().int().min(1),
}).strict()
export type ProjectSummary = z.output<typeof ProjectSummarySchema>

export const ListProjectsResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  organizationEnterpriseId: z.string().min(1),
  projects: z.array(ProjectSummarySchema).max(PROJECT_LIST_LIMIT_MAX),
}).strict()
export type ListProjectsResponse = z.output<typeof ListProjectsResponseSchema>

export const CreateProjectInputSchema = z.object({
  name: nonBlank(PROJECT_NAME_MAX_CHARS),
  purpose: z.string().max(PROJECT_PURPOSE_MAX_CHARS).optional(),
  instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX_CHARS).optional(),
}).strict()
export type CreateProjectInput = z.output<typeof CreateProjectInputSchema>

/** PATCH semantics: absent fields stay unchanged; a present `undefined`
 * cannot be expressed on the wire — clearing purpose/instructions sends
 * empty string and the server normalizes it to absent. */
export const UpdateProjectInputSchema = z.object({
  name: nonBlank(PROJECT_NAME_MAX_CHARS).optional(),
  purpose: z.string().max(PROJECT_PURPOSE_MAX_CHARS).optional(),
  instructions: z.string().max(PROJECT_INSTRUCTIONS_MAX_CHARS).optional(),
}).strict()
export type UpdateProjectInput = z.output<typeof UpdateProjectInputSchema>

export const ProjectMutationResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  project: ProjectSummarySchema,
}).strict()
export type ProjectMutationResponse = z.output<typeof ProjectMutationResponseSchema>

/* ------------------------------------------------------------------ */
/* Project members (Q10: project members ⊆ organization members)       */
/* ------------------------------------------------------------------ */

export const ProjectMemberSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string().min(1).max(256).nullable(),
  role: z.enum(PROJECT_ROLES),
  createdAt: isoTimestamp,
}).strict()
export type ProjectMember = z.output<typeof ProjectMemberSchema>

export const ListProjectMembersResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  projectId: z.string().min(1),
  members: z.array(ProjectMemberSchema).max(PROJECT_LIST_LIMIT_MAX),
}).strict()
export type ListProjectMembersResponse = z.output<typeof ListProjectMembersResponseSchema>

export const AddProjectMembersInputSchema = z.object({
  accountIds: z.array(z.string().min(1)).min(1).max(100),
  role: z.enum(PROJECT_ROLES),
}).strict()
export type AddProjectMembersInput = z.output<typeof AddProjectMembersInputSchema>

export const UpdateProjectMemberInputSchema = z.object({
  role: z.enum(PROJECT_ROLES),
}).strict()
export type UpdateProjectMemberInput = z.output<typeof UpdateProjectMemberInputSchema>

export const UpdateProjectMemberResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  member: ProjectMemberSchema,
}).strict()
export type UpdateProjectMemberResponse = z.output<typeof UpdateProjectMemberResponseSchema>

/** DELETE .../members/{accountId} answers the FRESH roster (same shape as the
 * list response) so the renderer can replace its state from the mutation's
 * own answer — no second pm:listProjectMembers round-trip (POO-205 A1/C10). */
export const RemoveProjectMemberResponseSchema = ListProjectMembersResponseSchema
export type RemoveProjectMemberResponse = z.output<typeof RemoveProjectMemberResponseSchema>

/** Organization colleague roster: the ONLY source a project can pick members
 * from (Q10). Organization membership itself is admin-console-managed; the
 * client never invites outside the organization. */
export const OrganizationColleagueSchema = z.object({
  accountId: z.string().min(1),
  displayName: z.string().min(1).max(256).nullable(),
  organizationRole: z.enum(PROJECT_ROLES),
}).strict()
export type OrganizationColleague = z.output<typeof OrganizationColleagueSchema>

export const ListOrganizationColleaguesResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  organizationEnterpriseId: z.string().min(1),
  colleagues: z.array(OrganizationColleagueSchema).max(PROJECT_LIST_LIMIT_MAX),
}).strict()
export type ListOrganizationColleaguesResponse = z.output<typeof ListOrganizationColleaguesResponseSchema>

/* ------------------------------------------------------------------ */
/* Migration mapping (Q9 one-shot upgrade, beta hard cut)              */
/* ------------------------------------------------------------------ */

export const ProjectMigrationMappingSchema = z.object({
  /** Old enterprise ProductSpace id whose enterpriseKind was 'project'. */
  oldProjectSpaceId: z.string().min(1),
  /** Upgraded organization ProductSpace id (same enterprise, re-kind'd). */
  organizationSpaceId: z.string().min(1),
  /** New Project id created inside the organization. */
  projectId: z.string().min(1),
}).strict()
export type ProjectMigrationMapping = z.output<typeof ProjectMigrationMappingSchema>

export const ProjectMigrationMappingResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  mappings: z.array(ProjectMigrationMappingSchema).max(10_000),
}).strict()
export type ProjectMigrationMappingResponse = z.output<typeof ProjectMigrationMappingResponseSchema>

/* ------------------------------------------------------------------ */
/* My apps (Q7/Q11): per-space "我的应用", publish/withdraw             */
/* ------------------------------------------------------------------ */

/** One member-owned app in a space's "my apps" area. Mirrors the catalog
 * app shape minus space-level catalog identity: it becomes a catalog entry
 * (visibility `space`) only after publish. */
export const MyAppSummarySchema = z.object({
  appId: z.string().min(1),
  name: nonBlank(MYAPPS_NAME_MAX_CHARS),
  description: z.string().max(MYAPPS_DESCRIPTION_MAX_CHARS),
  ownerAccountId: z.string().min(1),
  /** static-only for member uploads this round (creator pipeline may grow
   * python/js later; the wire already carries runtime). */
  runtime: z.enum(['static']),
  /** Present once published: the space catalog entry it powers. */
  publishedEntryId: z.string().min(1).nullable(),
  publishedAt: isoTimestamp.nullable(),
  version: nonBlank(512),
  sizeBytes: z.number().int().min(0),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
}).strict()
export type MyAppSummary = z.output<typeof MyAppSummarySchema>

export const ListMyAppsResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  productSpaceId: z.string().min(1),
  apps: z.array(MyAppSummarySchema).max(MYAPPS_COUNT_SOFT_LIMIT),
}).strict()
export type ListMyAppsResponse = z.output<typeof ListMyAppsResponseSchema>

export const CreateMyAppInputSchema = z.object({
  name: nonBlank(MYAPPS_NAME_MAX_CHARS),
  description: z.string().max(MYAPPS_DESCRIPTION_MAX_CHARS).optional(),
  /** ZIP payload, base64. Static single-page bundle (index.html at root),
   * validated server-side through the same analyzer as creator apps. */
  payloadBase64: z.string().min(1),
  /** sha256 of the decoded bytes; server verifies before storing. */
  checksumSha256: checksum64,
  /** POO-205 A3b save idempotency: a stable canvas identity (session +
   * canvas, ≤256 chars). The SAME key saves a NEW VERSION of the existing
   * row (answers 200 instead of 201) instead of duplicating it. */
  sourceKey: z.string().trim().min(1).max(256).optional(),
}).strict()
export type CreateMyAppInput = z.output<typeof CreateMyAppInputSchema>

export const MyAppMutationResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  app: MyAppSummarySchema,
}).strict()
export type MyAppMutationResponse = z.output<typeof MyAppMutationResponseSchema>

/** DELETE .../my-apps/{appId} (POO-205 A3b): deleting a published app
 * withdraws the shared entry in the same transaction; the answer is a bare
 * confirmation — the row is gone, not returned. */
export const DeleteMyAppResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  appId: z.string().min(1),
  deleted: z.literal(true),
}).strict()
export type DeleteMyAppResponse = z.output<typeof DeleteMyAppResponseSchema>

/** POO-205 A3b: what AdminClient.createMyApp answers — the parsed mutation
 * body PLUS the raw HTTP status (201 = a NEW app row, 200 = a NEW VERSION of
 * the row addressed by the request's `sourceKey`). Client-side only; the
 * status is transport metadata, never part of the admin wire body. */
export interface MyAppCreateOutcome {
  status: number
  response: MyAppMutationResponse
}

export const PublishMyAppResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  app: MyAppSummarySchema,
  /** The space-catalog entry created for the published app. */
  catalogEntryId: z.string().min(1),
}).strict()
export type PublishMyAppResponse = z.output<typeof PublishMyAppResponseSchema>

export const WithdrawMyAppResponseSchema = z.object({
  contractVersion: z.literal(PROJECT_CONTRACT_VERSION),
  app: MyAppSummarySchema,
}).strict()
export type WithdrawMyAppResponse = z.output<typeof WithdrawMyAppResponseSchema>

/* ------------------------------------------------------------------ */
/* Error envelope                                                      */
/* ------------------------------------------------------------------ */

export const ProjectErrorEnvelopeSchema = z.object({
  error: z.enum(PROJECT_ERROR_CODES),
  message: z.string().max(512),
  requestId: z.string().optional(),
}).strict()
export type ProjectErrorEnvelope = z.output<typeof ProjectErrorEnvelopeSchema>
