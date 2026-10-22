import type { ArtifactInstanceId, CatalogEntryId, ProductSpaceId } from './ids.ts'

export const PRODUCT_SPACE_API_PATHS = {
  list: '/api/me/product-spaces',
  catalog: '/api/product-spaces/{productSpaceId}/catalog',
  skillEnablement: '/api/product-spaces/{productSpaceId}/skills/{artifactInstanceId}/enablement',
  resolveLaunch: '/api/product-spaces/{productSpaceId}/catalog/{catalogEntryId}/resolve-launch',
} as const

function segment(value: string): string {
  return encodeURIComponent(value)
}

export function createProductSpaceCatalogPath(productSpaceId: ProductSpaceId): string {
  return `/api/product-spaces/${segment(productSpaceId)}/catalog`
}

export function createSkillEnablementPath(
  productSpaceId: ProductSpaceId,
  artifactInstanceId: ArtifactInstanceId,
): string {
  return `/api/product-spaces/${segment(productSpaceId)}/skills/${segment(artifactInstanceId)}/enablement`
}

export function createResolveLaunchPath(
  productSpaceId: ProductSpaceId,
  catalogEntryId: CatalogEntryId,
): string {
  return `/api/product-spaces/${segment(productSpaceId)}/catalog/${segment(catalogEntryId)}/resolve-launch`
}
