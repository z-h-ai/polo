import { z } from 'zod'
import {
  AccountIdSchema,
  ArtifactInstanceIdSchema,
  ArtifactVersionIdSchema,
  CatalogEntryIdSchema,
  CreatorCircleIdSchema,
  EnterpriseIdSchema,
  ExecutionIdSchema,
  ProductSpaceIdSchema,
  WorkspaceIdSchema,
} from './ids.ts'
import type { ProductSpaceId } from './ids.ts'
import { PRODUCT_SPACE_ERROR_CODES } from './errors.ts'
import { PRODUCT_SPACE_CONTRACT_VERSION } from './context-key.ts'

const nonBlankString = (maxLength: number) => z.string()
  .max(maxLength)
  .refine(value => value.trim().length > 0, 'Must be a non-blank string')
const timestamp = z.string().datetime({ offset: true })
const httpUrl = z.string().url().max(16_384).refine(value => {
  const protocol = new URL(value).protocol
  return protocol === 'https:' || protocol === 'http:'
}, 'Must be an HTTP(S) URL')
const checksum = z.string().regex(/^(?:sha256:)?[a-fA-F0-9]{64}$/)
  .transform(value => value.replace(/^sha256:/, '').toLowerCase())
const permissions = z.array(nonBlankString(512)).max(1_000)

export const ProductSpaceKindSchema = z.enum(['personal', 'enterprise'])
export const EnterpriseProductSpaceRoleSchema = z.enum(['owner', 'manager', 'member'])
export const ProductSpaceAccessModeSchema = z.enum(['active', 'read_only'])
export const ProductSpaceRestrictionCodeSchema = z.enum([
  'billing_restricted', 'governance_suspended', 'enterprise_closing',
])
export const CatalogEntryKindSchema = z.enum(['built_in_app', 'app', 'skill'])
export const CatalogEntryAvailabilitySchema = z.enum(['available', 'unavailable', 'blocked'])
export const CatalogEntryUnavailableReasonSchema = z.enum([
  'authorization_ended', 'space_restricted', 'version_unavailable', 'version_blocked',
])
export const ExecutionStatusSchema = z.enum([
  'preparing', 'running', 'waiting_for_network', 'stopping', 'stopped', 'failed',
])

const AccountPayerSchema = z.object({ kind: z.literal('account') }).strict()
const EnterprisePayerSchema = z.object({
  kind: z.literal('enterprise'), enterpriseId: EnterpriseIdSchema,
}).strict()
export const ProductSpacePayerSchema = z.discriminatedUnion('kind', [AccountPayerSchema, EnterprisePayerSchema])

const PersonalProductSpaceRefSchema = z.object({
  id: ProductSpaceIdSchema, kind: z.literal('personal'),
}).strict()
const EnterpriseProductSpaceRefSchema = z.object({
  id: ProductSpaceIdSchema,
  kind: z.literal('enterprise'),
  enterpriseId: EnterpriseIdSchema,
  role: EnterpriseProductSpaceRoleSchema,
}).strict()
export const ProductSpaceRefSchema = z.discriminatedUnion('kind', [
  PersonalProductSpaceRefSchema, EnterpriseProductSpaceRefSchema,
])

export const ProductSpaceContextSchema = z.object({
  contractVersion: z.literal(PRODUCT_SPACE_CONTRACT_VERSION),
  accountId: AccountIdSchema,
  productSpace: ProductSpaceRefSchema,
}).strict()

const PersonalProductSpaceSummarySchema = z.object({
  id: ProductSpaceIdSchema,
  kind: z.literal('personal'),
  name: z.literal('我的空间'),
  accessMode: z.literal('active'),
  payer: AccountPayerSchema,
}).strict()
const EnterpriseProductSpaceSummarySchema = z.object({
  id: ProductSpaceIdSchema,
  kind: z.literal('enterprise'),
  enterpriseId: EnterpriseIdSchema,
  name: nonBlankString(256),
  role: EnterpriseProductSpaceRoleSchema,
  accessMode: ProductSpaceAccessModeSchema,
  restrictionCode: ProductSpaceRestrictionCodeSchema.optional(),
  payer: EnterprisePayerSchema,
}).strict().superRefine((value, ctx) => {
  if (value.accessMode === 'active' && value.restrictionCode !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['restrictionCode'], message: 'Active spaces cannot include a restriction code' })
  }
})
export const ProductSpaceSummarySchema = z.discriminatedUnion('kind', [
  PersonalProductSpaceSummarySchema, EnterpriseProductSpaceSummarySchema,
])

export const ListProductSpacesResponseSchema = z.object({
  contractVersion: z.literal(PRODUCT_SPACE_CONTRACT_VERSION),
  personalProductSpaceId: ProductSpaceIdSchema,
  productSpaces: z.array(ProductSpaceSummarySchema).min(1).max(10_000),
}).strict().superRefine((value, ctx) => {
  const personal = value.productSpaces.filter(space => space.kind === 'personal')
  if (personal.length !== 1 || personal[0]?.id !== value.personalProductSpaceId) {
    ctx.addIssue({ code: 'custom', path: ['personalProductSpaceId'], message: 'Exactly one listed personal ProductSpace must match personalProductSpaceId' })
  }
  const ids = new Set<string>()
  for (const [index, space] of value.productSpaces.entries()) {
    if (ids.has(space.id)) ctx.addIssue({ code: 'custom', path: ['productSpaces', index, 'id'], message: 'ProductSpace IDs must be unique' })
    ids.add(space.id)
  }
})

const CatalogVersionSummarySchema = z.object({
  versionId: ArtifactVersionIdSchema,
  version: nonBlankString(512),
  checksum: checksum.optional(),
}).strict()
const CatalogSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('polo'), name: z.literal('Polo') }).strict(),
  z.object({ kind: z.literal('creator_circle'), circleId: CreatorCircleIdSchema, name: nonBlankString(256) }).strict(),
  z.object({ kind: z.literal('enterprise_import'), name: nonBlankString(256) }).strict(),
])
const CatalogEntryBaseSchema = z.object({
  catalogEntryId: CatalogEntryIdSchema,
  name: nonBlankString(256),
  description: z.string().max(4_096),
  iconUrl: httpUrl.optional(),
  availability: CatalogEntryAvailabilitySchema,
  unavailableReason: CatalogEntryUnavailableReasonSchema.optional(),
}).strict()
const BuiltInAppCatalogEntrySchema = CatalogEntryBaseSchema.extend({
  kind: z.literal('built_in_app'), builtInAppId: z.literal('polo_assistant'),
}).strict()
const AppCatalogEntrySchema = CatalogEntryBaseSchema.extend({
  kind: z.literal('app'),
  artifactInstanceId: ArtifactInstanceIdSchema,
  version: CatalogVersionSummarySchema,
  sources: z.array(CatalogSourceSchema).min(1).max(1_000),
  permissions,
}).strict()
const SkillCatalogEntrySchema = CatalogEntryBaseSchema.extend({
  kind: z.literal('skill'),
  artifactInstanceId: ArtifactInstanceIdSchema,
  version: CatalogVersionSummarySchema,
  sources: z.array(CatalogSourceSchema).min(1).max(1_000),
  enabled: z.boolean(),
  permissions,
}).strict()
export const ProductSpaceCatalogEntrySchema = z.discriminatedUnion('kind', [
  BuiltInAppCatalogEntrySchema, AppCatalogEntrySchema, SkillCatalogEntrySchema,
]).superRefine((value, ctx) => {
  if (value.availability === 'available' && value.unavailableReason !== undefined) {
    ctx.addIssue({ code: 'custom', path: ['unavailableReason'], message: 'Available entries cannot include an unavailable reason' })
  }
})

export const ProductSpaceCatalogResponseSchema = z.object({
  contractVersion: z.literal(PRODUCT_SPACE_CONTRACT_VERSION),
  productSpaceId: ProductSpaceIdSchema,
  catalogRevision: nonBlankString(512),
  entries: z.array(ProductSpaceCatalogEntrySchema).max(10_000),
}).strict().superRefine((value, ctx) => {
  const ids = new Set<string>()
  for (const [index, entry] of value.entries.entries()) {
    if (ids.has(entry.catalogEntryId)) ctx.addIssue({ code: 'custom', path: ['entries', index, 'catalogEntryId'], message: 'Catalog entry IDs must be unique within the ProductSpace' })
    ids.add(entry.catalogEntryId)
  }
})

export const UpdateSkillEnablementRequestSchema = z.object({ enabled: z.boolean() }).strict()
export const UpdateSkillEnablementResponseSchema = z.object({
  contractVersion: z.literal(PRODUCT_SPACE_CONTRACT_VERSION),
  productSpaceId: ProductSpaceIdSchema,
  artifactInstanceId: ArtifactInstanceIdSchema,
  enabled: z.boolean(),
  catalogRevision: nonBlankString(512),
}).strict()

export const ResolveLaunchRequestSchema = z.object({
  platform: z.enum(['darwin', 'win32', 'linux']),
  arch: z.enum(['arm64', 'x64']),
}).strict()
export const ResolvedLaunchSubjectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('built_in_app'), builtInAppId: z.literal('polo_assistant') }).strict(),
  z.object({
    kind: z.literal('artifact_instance'),
    artifactType: z.enum(['app', 'skill']),
    artifactInstanceId: ArtifactInstanceIdSchema,
    versionId: ArtifactVersionIdSchema,
    version: nonBlankString(512),
  }).strict(),
])
export const LaunchDeliverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('built_in') }).strict(),
  z.object({ kind: z.literal('web_url'), url: httpUrl, launchToken: nonBlankString(16_384) }).strict(),
  z.object({
    kind: z.literal('bundle'), downloadUrl: httpUrl, checksum,
    sizeBytes: z.number().int().min(0), runtime: z.enum(['static', 'python', 'js']),
  }).strict(),
])
export const ResolveLaunchResponseSchema = z.object({
  contractVersion: z.literal(PRODUCT_SPACE_CONTRACT_VERSION),
  productSpaceId: ProductSpaceIdSchema,
  catalogEntryId: CatalogEntryIdSchema,
  resolvedAt: timestamp,
  expiresAt: timestamp,
  subject: ResolvedLaunchSubjectSchema,
  payer: ProductSpacePayerSchema,
  delivery: LaunchDeliverySchema,
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expiresAt) <= Date.parse(value.resolvedAt)) {
    ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: 'expiresAt must be after resolvedAt' })
  }
  if (value.subject.kind === 'built_in_app' && value.delivery.kind !== 'built_in') {
    ctx.addIssue({ code: 'custom', path: ['delivery'], message: 'Polo assistant uses built_in delivery only' })
  }
  if (value.subject.kind === 'artifact_instance' && value.delivery.kind === 'built_in') {
    ctx.addIssue({ code: 'custom', path: ['delivery'], message: 'Artifact instances cannot use built_in delivery' })
  }
})

export const ProductSpaceExecutionScopeSchema = z.object({
  contractVersion: z.literal(PRODUCT_SPACE_CONTRACT_VERSION),
  executionId: ExecutionIdSchema,
  accountId: AccountIdSchema,
  productSpaceId: ProductSpaceIdSchema,
  workspaceId: WorkspaceIdSchema,
  subject: ResolvedLaunchSubjectSchema,
}).strict()
export const ExecutionSummarySchema = z.object({
  executionId: ExecutionIdSchema,
  scope: ProductSpaceExecutionScopeSchema,
  name: nonBlankString(256),
  status: ExecutionStatusSchema,
  errorCode: nonBlankString(256).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.executionId !== value.scope.executionId) {
    ctx.addIssue({ code: 'custom', path: ['scope', 'executionId'], message: 'Execution summary and scope IDs must match' })
  }
})
export const StopAllExecutionsResultSchema = z.object({
  allStopped: z.boolean(),
  executions: z.array(ExecutionSummarySchema),
}).strict().superRefine((value, ctx) => {
  const allTerminal = value.executions.every(execution => execution.status === 'stopped' || execution.status === 'failed')
  if (value.allStopped !== allTerminal) {
    ctx.addIssue({ code: 'custom', path: ['allStopped'], message: 'allStopped must reflect every execution reaching a terminal status' })
  }
})

export const ProductSpaceErrorCodeSchema = z.enum(PRODUCT_SPACE_ERROR_CODES)
export const ProductSpaceErrorResponseSchema = z.object({
  error: ProductSpaceErrorCodeSchema,
  message: nonBlankString(4_096),
  requestId: nonBlankString(512),
  retryable: z.boolean(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
}).strict()

/** Raised when a valid response is replayed for the wrong requested space. */
export class ProductSpaceResponseScopeError extends Error {
  constructor(
    readonly expectedProductSpaceId: ProductSpaceId,
    readonly receivedProductSpaceId: ProductSpaceId,
  ) {
    super('ProductSpace response did not match the requested ProductSpace')
    this.name = 'ProductSpaceResponseScopeError'
  }
}

/**
 * Use this at a client HTTP boundary after parsing the untrusted response.
 * A valid DTO for ProductSpace A must not be accepted for a request to B.
 */
export function parseProductSpaceCatalogResponseForProductSpace(
  input: unknown,
  expectedProductSpaceId: ProductSpaceId,
) {
  const response = ProductSpaceCatalogResponseSchema.parse(input)
  if (response.productSpaceId !== expectedProductSpaceId) {
    throw new ProductSpaceResponseScopeError(expectedProductSpaceId, response.productSpaceId)
  }
  return response
}

export function parseResolveLaunchResponseForProductSpace(
  input: unknown,
  expectedProductSpaceId: ProductSpaceId,
) {
  const response = ResolveLaunchResponseSchema.parse(input)
  if (response.productSpaceId !== expectedProductSpaceId) {
    throw new ProductSpaceResponseScopeError(expectedProductSpaceId, response.productSpaceId)
  }
  return response
}
