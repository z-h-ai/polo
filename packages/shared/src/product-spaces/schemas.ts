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
import type { ArtifactInstanceId, CatalogEntryId, ProductSpaceId } from './ids.ts'
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
  if (value.enterpriseId !== value.payer.enterpriseId) {
    ctx.addIssue({ code: 'custom', path: ['payer', 'enterpriseId'], message: 'Enterprise payer must match the ProductSpace enterprise' })
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
  const enterpriseIds = new Set<string>()
  for (const [index, space] of value.productSpaces.entries()) {
    if (ids.has(space.id)) ctx.addIssue({ code: 'custom', path: ['productSpaces', index, 'id'], message: 'ProductSpace IDs must be unique' })
    ids.add(space.id)
    if (space.kind === 'enterprise') {
      if (enterpriseIds.has(space.enterpriseId)) {
        ctx.addIssue({ code: 'custom', path: ['productSpaces', index, 'enterpriseId'], message: 'Enterprise IDs must be unique within ProductSpaces' })
      }
      enterpriseIds.add(space.enterpriseId)
    }
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
  const catalogEntryIds = new Set<string>()
  const artifactInstanceIds = new Set<string>()
  let builtInAssistantCount = 0
  for (const [index, entry] of value.entries.entries()) {
    if (catalogEntryIds.has(entry.catalogEntryId)) {
      ctx.addIssue({ code: 'custom', path: ['entries', index, 'catalogEntryId'], message: 'Catalog entry IDs must be unique within the ProductSpace' })
    }
    catalogEntryIds.add(entry.catalogEntryId)
    if (entry.kind !== 'built_in_app') {
      if (artifactInstanceIds.has(entry.artifactInstanceId)) {
        ctx.addIssue({ code: 'custom', path: ['entries', index, 'artifactInstanceId'], message: 'Artifact instance IDs must be unique within the ProductSpace' })
      }
      artifactInstanceIds.add(entry.artifactInstanceId)
    } else {
      builtInAssistantCount += 1
    }
  }
  if (builtInAssistantCount !== 1) {
    ctx.addIssue({ code: 'custom', path: ['entries'], message: 'Catalog must contain exactly one Polo assistant entry' })
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

/** Raised when a valid response is replayed for a different route parameter. */
export class ProductSpaceResponsePathError extends Error {
  constructor(
    readonly parameter: 'catalogEntryId' | 'artifactInstanceId',
    readonly expected: string,
    readonly received: string,
  ) {
    super(`ProductSpace response did not match the requested ${parameter}`)
    this.name = 'ProductSpaceResponsePathError'
  }
}

/** Raised when execution data belongs to a different runtime request tuple. */
export class ProductSpaceExecutionScopeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductSpaceExecutionScopeError'
  }
}

/**
 * A space context obtained from ProductSpace list state and already trusted by
 * the client. Network DTOs deliberately remain context-neutral; callers must
 * pass this context at the response boundary before entries become usable.
 */
export type TrustedProductSpaceCatalogContext =
  | z.output<typeof ProductSpaceRefSchema>
  | z.output<typeof ProductSpaceSummarySchema>

export type TrustedProductSpaceSummary = z.output<typeof ProductSpaceSummarySchema>
export type TrustedProductSpaceExecutionScope = z.output<typeof ProductSpaceExecutionScopeSchema>

const trustedProductSpaceCatalogBrand: unique symbol = Symbol('trustedProductSpaceCatalog')

/**
 * A Catalog response that has passed the ProductSpace boundary. The brand is
 * internal provenance: it is not serialized and does not change the frozen
 * network DTO.
 */
export type TrustedProductSpaceCatalog = z.output<typeof ProductSpaceCatalogResponseSchema> & {
  readonly [trustedProductSpaceCatalogBrand]: true
}

export type TrustedProductSpaceCatalogEntry = z.output<typeof ProductSpaceCatalogEntrySchema>

function assertExpectedProductSpace(
  receivedProductSpaceId: ProductSpaceId,
  expectedProductSpaceId: ProductSpaceId,
): void {
  if (receivedProductSpaceId !== expectedProductSpaceId) {
    throw new ProductSpaceResponseScopeError(expectedProductSpaceId, receivedProductSpaceId)
  }
}

function assertCatalogEntrySourcesMatchProductSpace(
  response: z.output<typeof ProductSpaceCatalogResponseSchema>,
  context: TrustedProductSpaceCatalogContext,
): void {
  for (const entry of response.entries) {
    if (entry.kind === 'built_in_app') continue

    const sourceKinds = new Set(entry.sources.map(source => source.kind))
    const hasOnlyPersonalSources = [...sourceKinds].every(
      kind => kind === 'polo' || kind === 'creator_circle',
    )
    const hasOnlyEnterpriseImports = sourceKinds.size === 1 && sourceKinds.has('enterprise_import')
    const hasMixedSources = sourceKinds.size > 1
    if (
      hasMixedSources
      || (context.kind === 'personal' && !hasOnlyPersonalSources)
      || (context.kind === 'enterprise' && !hasOnlyEnterpriseImports)
    ) {
      throw new ProductSpaceResponseScopeError(context.id, response.productSpaceId)
    }
  }
}

function assertLaunchPayerMatchesProductSpace(
  response: z.output<typeof ResolveLaunchResponseSchema>,
  context: TrustedProductSpaceSummary,
): void {
  if (context.kind === 'personal' && response.payer.kind !== 'account') {
    throw new ProductSpaceResponseScopeError(context.id, response.productSpaceId)
  }
  if (
    context.kind === 'enterprise'
    && (response.payer.kind !== 'enterprise' || response.payer.enterpriseId !== context.enterpriseId)
  ) {
    throw new ProductSpaceResponseScopeError(context.id, response.productSpaceId)
  }
}

function assertLaunchIsAllowedByTrustedState(
  context: TrustedProductSpaceSummary,
  entry: TrustedProductSpaceCatalogEntry,
): void {
  if (context.accessMode !== 'active') {
    throw new ProductSpaceResponseScopeError(context.id, context.id)
  }
  if (entry.availability !== 'available') {
    throw new ProductSpaceResponsePathError('catalogEntryId', entry.catalogEntryId, entry.catalogEntryId)
  }
  if (entry.kind === 'skill' && !entry.enabled) {
    throw new ProductSpaceResponsePathError('catalogEntryId', entry.catalogEntryId, entry.catalogEntryId)
  }
}

function assertTrustedCatalogMatchesProductSpace(
  catalog: TrustedProductSpaceCatalog,
  context: TrustedProductSpaceSummary,
): void {
  if (!catalog[trustedProductSpaceCatalogBrand] || catalog.productSpaceId !== context.id) {
    throw new ProductSpaceResponseScopeError(context.id, catalog.productSpaceId)
  }
}

function getCatalogEntry(
  catalog: TrustedProductSpaceCatalog,
  expectedCatalogEntryId: CatalogEntryId,
): TrustedProductSpaceCatalogEntry {
  const entry = catalog.entries.find(candidate => candidate.catalogEntryId === expectedCatalogEntryId)
  if (!entry) {
    throw new ProductSpaceResponsePathError('catalogEntryId', expectedCatalogEntryId, '')
  }
  return entry
}

function getSkillCatalogEntry(
  catalog: TrustedProductSpaceCatalog,
  expectedArtifactInstanceId: ArtifactInstanceId,
): z.output<typeof SkillCatalogEntrySchema> {
  const entry = catalog.entries.find(candidate => (
    candidate.kind !== 'built_in_app' && candidate.artifactInstanceId === expectedArtifactInstanceId
  ))
  if (!entry || entry.kind !== 'skill') {
    throw new ProductSpaceResponsePathError('artifactInstanceId', expectedArtifactInstanceId, '')
  }
  return entry
}

function assertLaunchSubjectMatchesCatalogEntry(
  response: z.output<typeof ResolveLaunchResponseSchema>,
  entry: TrustedProductSpaceCatalogEntry,
): void {
  if (entry.kind === 'built_in_app') {
    if (
      response.subject.kind !== 'built_in_app'
      || response.subject.builtInAppId !== entry.builtInAppId
    ) throw new ProductSpaceResponsePathError('catalogEntryId', entry.catalogEntryId, response.catalogEntryId)
    return
  }
  if (
    response.subject.kind !== 'artifact_instance'
    || response.subject.artifactType !== entry.kind
    || response.subject.artifactInstanceId !== entry.artifactInstanceId
  ) throw new ProductSpaceResponsePathError('catalogEntryId', entry.catalogEntryId, response.catalogEntryId)
}

/** Reusable validation for trusted list-active and stop-all runtime responses. */
export function validateExecutionScopesForProductSpace(
  executions: readonly z.output<typeof ExecutionSummarySchema>[],
  expectedAccountId: z.output<typeof AccountIdSchema>,
  expectedProductSpaceId: ProductSpaceId,
): void {
  const executionIds = new Set<string>()
  for (const execution of executions) {
    if (execution.scope.accountId !== expectedAccountId) {
      throw new ProductSpaceExecutionScopeError('Execution response did not match the requested accountId')
    }
    if (execution.scope.productSpaceId !== expectedProductSpaceId) {
      throw new ProductSpaceExecutionScopeError('Execution response did not match the requested productSpaceId')
    }
    if (executionIds.has(execution.executionId)) {
      throw new ProductSpaceExecutionScopeError('Execution response contains duplicate executionId values')
    }
    executionIds.add(execution.executionId)
  }
}

/**
 * Use this at a client HTTP boundary after parsing the untrusted response.
 * A valid DTO for ProductSpace A must not be accepted for a request to B.
 */
export function parseProductSpaceCatalogResponseForProductSpace(
  input: unknown,
  context: TrustedProductSpaceCatalogContext,
): TrustedProductSpaceCatalog {
  const response = ProductSpaceCatalogResponseSchema.parse(input)
  assertExpectedProductSpace(response.productSpaceId, context.id)
  assertCatalogEntrySourcesMatchProductSpace(response, context)
  Object.defineProperty(response, trustedProductSpaceCatalogBrand, {
    value: true,
    enumerable: false,
  })
  return Object.freeze(response) as TrustedProductSpaceCatalog
}

export function parseResolveLaunchResponseForProductSpace(
  input: unknown,
  context: TrustedProductSpaceSummary,
  catalog: TrustedProductSpaceCatalog,
  expectedCatalogEntryId: CatalogEntryId,
) {
  assertTrustedCatalogMatchesProductSpace(catalog, context)
  const expectedCatalogEntry = getCatalogEntry(catalog, expectedCatalogEntryId)
  const response = ResolveLaunchResponseSchema.parse(input)
  assertExpectedProductSpace(response.productSpaceId, context.id)
  if (response.catalogEntryId !== expectedCatalogEntry.catalogEntryId) {
    throw new ProductSpaceResponsePathError(
      'catalogEntryId', expectedCatalogEntry.catalogEntryId, response.catalogEntryId,
    )
  }
  assertLaunchIsAllowedByTrustedState(context, expectedCatalogEntry)
  assertLaunchPayerMatchesProductSpace(response, context)
  assertLaunchSubjectMatchesCatalogEntry(response, expectedCatalogEntry)
  return response
}

/** Parses a Skill enablement response only for its exact PUT route tuple. */
export function parseUpdateSkillEnablementResponseForProductSpace(
  input: unknown,
  context: TrustedProductSpaceSummary,
  catalog: TrustedProductSpaceCatalog,
  expectedArtifactInstanceId: ArtifactInstanceId,
  expectedEnabled: boolean,
) {
  assertTrustedCatalogMatchesProductSpace(catalog, context)
  const expectedSkillEntry = getSkillCatalogEntry(catalog, expectedArtifactInstanceId)
  const response = UpdateSkillEnablementResponseSchema.parse(input)
  assertExpectedProductSpace(response.productSpaceId, context.id)
  if (response.artifactInstanceId !== expectedSkillEntry.artifactInstanceId) {
    throw new ProductSpaceResponsePathError(
      'artifactInstanceId', expectedSkillEntry.artifactInstanceId, response.artifactInstanceId,
    )
  }
  if (response.enabled !== expectedEnabled) {
    throw new ProductSpaceResponsePathError(
      'artifactInstanceId', expectedSkillEntry.artifactInstanceId, response.artifactInstanceId,
    )
  }
  if (
    expectedEnabled
    && (context.accessMode !== 'active' || expectedSkillEntry.availability !== 'available')
  ) {
    throw new ProductSpaceResponseScopeError(context.id, response.productSpaceId)
  }
  return response
}

/** Parses list-active output only for the requested account/ProductSpace tuple. */
export function parseActiveExecutionsForProductSpace(
  input: unknown,
  expectedAccountId: z.output<typeof AccountIdSchema>,
  expectedProductSpaceId: ProductSpaceId,
) {
  const executions = z.array(ExecutionSummarySchema).parse(input)
  validateExecutionScopesForProductSpace(executions, expectedAccountId, expectedProductSpaceId)
  return executions
}

/** Parses stop-all output only after every requested execution reached a terminal state. */
export function parseStopAllExecutionsResultForProductSpace(
  input: unknown,
  expectedAccountId: z.output<typeof AccountIdSchema>,
  expectedProductSpaceId: ProductSpaceId,
  expectedExecutionScopes: readonly TrustedProductSpaceExecutionScope[],
) {
  const result = StopAllExecutionsResultSchema.parse(input)
  validateExecutionScopesForProductSpace(result.executions, expectedAccountId, expectedProductSpaceId)
  if (expectedExecutionScopes.length === 0) {
    throw new ProductSpaceExecutionScopeError('stop-all requires at least one expected execution')
  }
  const expectedById = new Map<z.output<typeof ExecutionIdSchema>, TrustedProductSpaceExecutionScope>()
  for (const expectedScope of expectedExecutionScopes) {
    if (expectedScope.accountId !== expectedAccountId || expectedScope.productSpaceId !== expectedProductSpaceId) {
      throw new ProductSpaceExecutionScopeError('Expected execution scope did not match the requested tuple')
    }
    if (expectedById.has(expectedScope.executionId)) {
      throw new ProductSpaceExecutionScopeError('Expected execution scopes contain duplicate executionId values')
    }
    expectedById.set(expectedScope.executionId, expectedScope)
  }
  const returnedById = new Map<
    z.output<typeof ExecutionIdSchema>,
    z.output<typeof ExecutionSummarySchema>
  >(result.executions.map(execution => [execution.executionId, execution]))
  for (const [executionId, expectedScope] of expectedById) {
    const returned = returnedById.get(executionId)
    if (!returned) {
      throw new ProductSpaceExecutionScopeError('stop-all response omitted an expected execution')
    }
    if (JSON.stringify(returned.scope) !== JSON.stringify(expectedScope)) {
      throw new ProductSpaceExecutionScopeError('stop-all response changed an expected execution scope')
    }
  }
  if (!result.allStopped || result.executions.some(execution => (
    execution.status !== 'stopped' && execution.status !== 'failed'
  ))) {
    throw new ProductSpaceExecutionScopeError('stop-all response contains non-terminal executions')
  }
  return result
}
