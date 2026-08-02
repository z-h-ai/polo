import type { OrganizationSummary } from '../admin/types.ts'

export interface VerifiedOrganizationContextPreference {
  organizationSummaries: OrganizationSummary[]
  activeOrganizationId: string | null
  verifiedAt: number
}

export interface UnavailableOrganizationTombstonePreference {
  organization: OrganizationSummary
  recordedAt: number
}

export interface OrganizationContextStorage {
  verifiedContext?: VerifiedOrganizationContextPreference
  unavailableTombstone?: UnavailableOrganizationTombstonePreference
}

export interface OrganizationContextStoragePatch {
  verifiedContext?: VerifiedOrganizationContextPreference | null
  unavailableTombstone?: UnavailableOrganizationTombstonePreference | null
}

export type OrganizationContextStorageByAccount = Record<
  string,
  OrganizationContextStorage
>
