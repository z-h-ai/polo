import { z } from 'zod'

declare const opaqueIdBrand: unique symbol

/**
 * An opaque identifier that has crossed its owning validation boundary.
 *
 * Product-space IDs intentionally share no runtime format (UUID prefixes,
 * database keys, and so on are implementation details).  The individual
 * brands make accidentally exchanging identities a TypeScript error.
 */
export type OpaqueId<Name extends string> = string & {
  readonly [opaqueIdBrand]: Name
}

export type AccountId = OpaqueId<'AccountId'>
export type ProductSpaceId = OpaqueId<'ProductSpaceId'>
export type WorkspaceId = OpaqueId<'WorkspaceId'>
export type EnterpriseId = OpaqueId<'EnterpriseId'>
export type CreatorCircleId = OpaqueId<'CreatorCircleId'>
export type ArtifactInstanceId = OpaqueId<'ArtifactInstanceId'>
export type ArtifactVersionId = OpaqueId<'ArtifactVersionId'>
export type CatalogEntryId = OpaqueId<'CatalogEntryId'>
export type ExecutionId = OpaqueId<'ExecutionId'>
export type DeviceId = OpaqueId<'DeviceId'>
export type SessionId = OpaqueId<'SessionId'>

function opaqueIdSchema<Name extends string>(name: Name) {
  return z.string()
    .max(512)
    .refine(value => value.trim().length > 0, `${name} must be a non-blank string`)
    .transform(value => value as OpaqueId<Name>)
}

export const AccountIdSchema = opaqueIdSchema('AccountId')
export const ProductSpaceIdSchema = opaqueIdSchema('ProductSpaceId')
export const WorkspaceIdSchema = opaqueIdSchema('WorkspaceId')
export const EnterpriseIdSchema = opaqueIdSchema('EnterpriseId')
export const CreatorCircleIdSchema = opaqueIdSchema('CreatorCircleId')
export const ArtifactInstanceIdSchema = opaqueIdSchema('ArtifactInstanceId')
export const ArtifactVersionIdSchema = opaqueIdSchema('ArtifactVersionId')
export const CatalogEntryIdSchema = opaqueIdSchema('CatalogEntryId')
export const ExecutionIdSchema = opaqueIdSchema('ExecutionId')
export const DeviceIdSchema = opaqueIdSchema('DeviceId')
export const SessionIdSchema = opaqueIdSchema('SessionId')
