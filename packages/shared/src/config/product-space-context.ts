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

/**
 * Device-local session-to-space provenance so assistant history never leaks
 * across a ProductSpace switch. Keys are session IDs, values are the
 * ProductSpace the session was created in.
 */
export type ProductSpaceSessionIndexPreference = Record<string, string>

export interface ProductSpaceContextStorage {
  verifiedContext?: VerifiedProductSpaceContextPreference
  sessionSpaceIndex?: ProductSpaceSessionIndexPreference
}

export interface ProductSpaceContextStoragePatch {
  verifiedContext?: VerifiedProductSpaceContextPreference | null
  sessionSpaceIndex?: ProductSpaceSessionIndexPreference | null
}

export type ProductSpaceContextStorageByAccount = Record<
  string,
  ProductSpaceContextStorage
>
