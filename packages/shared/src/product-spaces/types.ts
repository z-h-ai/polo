import type { z } from 'zod'
import type {
  CatalogEntryAvailabilitySchema,
  CatalogEntryKindSchema,
  CatalogEntryUnavailableReasonSchema,
  EnterpriseProductSpaceRoleSchema,
  ExecutionStatusSchema,
  ProductSpaceAccessModeSchema,
  ProductSpaceKindSchema,
  ProductSpaceRestrictionCodeSchema,
} from './schemas.ts'
import type {
  ProductSpaceCatalogResponseSchema,
  ProductSpaceSummarySchema,
  ProductSpaceContextSchema,
  ProductSpaceErrorResponseSchema,
  ProductSpaceExecutionScopeSchema,
  ProductSpaceRefSchema,
  ResolveLaunchRequestSchema,
  ResolveLaunchResponseSchema,
  UpdateSkillEnablementRequestSchema,
  UpdateSkillEnablementResponseSchema,
  ListProductSpacesResponseSchema,
  ExecutionSummarySchema,
  StopAllExecutionsResultSchema,
} from './schemas.ts'

export type ProductSpaceKind = z.infer<typeof ProductSpaceKindSchema>
export type EnterpriseProductSpaceRole = z.infer<typeof EnterpriseProductSpaceRoleSchema>
export type ProductSpaceAccessMode = z.infer<typeof ProductSpaceAccessModeSchema>
export type ProductSpaceRestrictionCode = z.infer<typeof ProductSpaceRestrictionCodeSchema>
export type CatalogEntryKind = z.infer<typeof CatalogEntryKindSchema>
export type CatalogEntryAvailability = z.infer<typeof CatalogEntryAvailabilitySchema>
export type CatalogEntryUnavailableReason = z.infer<typeof CatalogEntryUnavailableReasonSchema>
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>

export type ProductSpaceRef = z.infer<typeof ProductSpaceRefSchema>
export type ProductSpaceSummary = z.infer<typeof ProductSpaceSummarySchema>
export type ProductSpaceContext = z.infer<typeof ProductSpaceContextSchema>
export type ListProductSpacesResponse = z.infer<typeof ListProductSpacesResponseSchema>
export type ProductSpaceCatalogResponse = z.infer<typeof ProductSpaceCatalogResponseSchema>
export type UpdateSkillEnablementRequest = z.infer<typeof UpdateSkillEnablementRequestSchema>
export type UpdateSkillEnablementResponse = z.infer<typeof UpdateSkillEnablementResponseSchema>
export type ResolveLaunchRequest = z.infer<typeof ResolveLaunchRequestSchema>
export type ResolveLaunchResponse = z.infer<typeof ResolveLaunchResponseSchema>
export type ProductSpaceExecutionScope = z.infer<typeof ProductSpaceExecutionScopeSchema>
export type ExecutionSummary = z.infer<typeof ExecutionSummarySchema>
export type StopAllExecutionsResult = z.infer<typeof StopAllExecutionsResultSchema>
export type ProductSpaceErrorResponse = z.infer<typeof ProductSpaceErrorResponseSchema>
