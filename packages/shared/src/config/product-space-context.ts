import type { ListProductSpacesResponse } from '../product-spaces/types.ts'

/**
 * Device-local ProductSpace state that was verified against the server
 * ProductSpace contract. It records the last trusted list response plus the
 * device's active selection; the server never stores "current space".
 */
export interface VerifiedProductSpaceContextPreference {
  list: ListProductSpacesResponse
  activeProductSpaceId: string | null
  verifiedAt: number
}

export interface ProductSpaceContextStorage {
  verifiedContext?: VerifiedProductSpaceContextPreference
}

export interface ProductSpaceContextStoragePatch {
  verifiedContext?: VerifiedProductSpaceContextPreference | null
}

export type ProductSpaceContextStorageByAccount = Record<
  string,
  ProductSpaceContextStorage
>
