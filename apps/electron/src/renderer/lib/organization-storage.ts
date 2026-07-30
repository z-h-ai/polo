import { ListOrganizationsResponseSchema } from '@polo-ai/shared/admin/schemas'
import {
  createOrganizationContextKey as createSharedOrganizationContextKey,
} from '@polo-ai/shared/admin/context-key'
import type { OrganizationSummary } from '@polo-ai/shared/admin'

const ACTIVE_ORGANIZATION_PREFIX = 'polo-active-organization:'
const VERIFIED_ORGANIZATION_CONTEXT_PREFIX = 'polo-verified-organization-context:'
const UNAVAILABLE_ORGANIZATION_PREFIX = 'polo-unavailable-organization:'
const PENDING_JOIN_TOKEN_KEY = 'polo-pending-organization-join-token'
const ORGANIZATION_SCOPED_STORAGE_PREFIX = 'polo-organization:v2:'

function activeOrganizationKey(accountId: string): string {
  return `${ACTIVE_ORGANIZATION_PREFIX}${accountId}`
}

function verifiedOrganizationContextKey(accountId: string): string {
  return `${VERIFIED_ORGANIZATION_CONTEXT_PREFIX}${accountId}`
}

function unavailableOrganizationKey(accountId: string): string {
  return `${UNAVAILABLE_ORGANIZATION_PREFIX}${accountId}`
}

export interface VerifiedOrganizationContext {
  organizationSummaries: OrganizationSummary[]
  activeOrganizationId: string | null
  verifiedAt: number
}

export interface UnavailableOrganizationTombstone {
  organization: OrganizationSummary
  recordedAt: number
}

function isActiveOrganization(organization: OrganizationSummary): boolean {
  return organization.status !== 'suspended'
    && organization.membership.status === 'active'
}

export function getStoredActiveOrganizationId(accountId: string): string | null {
  try {
    return localStorage.getItem(activeOrganizationKey(accountId))
  } catch {
    return null
  }
}

export function setStoredActiveOrganizationId(
  accountId: string,
  organizationId: string,
): void {
  try {
    localStorage.setItem(activeOrganizationKey(accountId), organizationId)
  } catch {
    // The in-memory context still works when storage is unavailable.
  }
}

export function clearStoredActiveOrganizationId(accountId: string): void {
  try {
    localStorage.removeItem(activeOrganizationKey(accountId))
  } catch {
    // Nothing else to clear.
  }
}

export function getVerifiedOrganizationContext(
  accountId: string,
): VerifiedOrganizationContext | null {
  try {
    const raw = localStorage.getItem(verifiedOrganizationContextKey(accountId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<VerifiedOrganizationContext>
    const organizations = ListOrganizationsResponseSchema.safeParse({
      organizations: parsed.organizationSummaries,
    })
    if (
      !organizations.success
      || (parsed.activeOrganizationId !== null
        && typeof parsed.activeOrganizationId !== 'string')
      || typeof parsed.verifiedAt !== 'number'
      || !Number.isInteger(parsed.verifiedAt)
      || parsed.verifiedAt < 0
    ) {
      return null
    }
    const activeOrganizationId = parsed.activeOrganizationId ?? null
    if (
      activeOrganizationId
      && !organizations.data.organizations.some(organization => (
        organization.id === activeOrganizationId
        && isActiveOrganization(organization)
      ))
    ) {
      return null
    }
    return {
      organizationSummaries: organizations.data.organizations,
      activeOrganizationId,
      verifiedAt: parsed.verifiedAt,
    }
  } catch {
    return null
  }
}

export function setVerifiedOrganizationContext(
  accountId: string,
  organizationSummaries: OrganizationSummary[],
  activeOrganizationId: string | null,
): void {
  const verified = ListOrganizationsResponseSchema.safeParse({
    organizations: organizationSummaries,
  })
  if (!verified.success) return
  const verifiedActiveOrganizationId = activeOrganizationId
    && verified.data.organizations.some(organization => (
      organization.id === activeOrganizationId
      && isActiveOrganization(organization)
    ))
    ? activeOrganizationId
    : null
  try {
    localStorage.setItem(
      verifiedOrganizationContextKey(accountId),
      JSON.stringify({
        organizationSummaries: verified.data.organizations,
        activeOrganizationId: verifiedActiveOrganizationId,
        verifiedAt: Date.now(),
      } satisfies VerifiedOrganizationContext),
    )
  } catch {
    // Never leave an older authorized context recoverable after a successful
    // online response established a new authorization truth.
    if (!verifiedActiveOrganizationId) {
      clearVerifiedOrganizationContext(accountId)
    }
  }
  if (!verifiedActiveOrganizationId) clearStoredActiveOrganizationId(accountId)
}

export function clearVerifiedOrganizationContext(accountId: string): void {
  try {
    localStorage.removeItem(verifiedOrganizationContextKey(accountId))
  } catch {
    // Nothing else to clear.
  }
}

export function createUnavailableOrganizationTombstone(
  organization: OrganizationSummary,
): OrganizationSummary {
  return {
    ...organization,
    status: 'suspended',
    membership: {
      ...organization.membership,
      status: organization.membership.status === 'active'
        ? 'removed'
        : organization.membership.status,
    },
  }
}

export function getUnavailableOrganizationTombstone(
  accountId: string,
): UnavailableOrganizationTombstone | null {
  try {
    const raw = localStorage.getItem(unavailableOrganizationKey(accountId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<UnavailableOrganizationTombstone>
    const organization = ListOrganizationsResponseSchema.safeParse({
      organizations: parsed.organization ? [parsed.organization] : [],
    })
    if (
      !organization.success
      || typeof parsed.recordedAt !== 'number'
      || !Number.isInteger(parsed.recordedAt)
      || parsed.recordedAt < 0
    ) {
      return null
    }
    const tombstone = organization.data.organizations[0]
    if (!tombstone || isActiveOrganization(tombstone)) return null
    return {
      organization: tombstone,
      recordedAt: parsed.recordedAt,
    }
  } catch {
    return null
  }
}

export function setUnavailableOrganizationTombstone(
  accountId: string,
  organization: OrganizationSummary,
): void {
  const tombstone = createUnavailableOrganizationTombstone(organization)
  try {
    localStorage.setItem(
      unavailableOrganizationKey(accountId),
      JSON.stringify({
        organization: tombstone,
        recordedAt: Date.now(),
      } satisfies UnavailableOrganizationTombstone),
    )
  } catch {
    // The in-memory read-only organization context remains usable.
  }
}

export function clearUnavailableOrganizationTombstone(accountId: string): void {
  try {
    localStorage.removeItem(unavailableOrganizationKey(accountId))
  } catch {
    // Nothing else to clear.
  }
}

export function getPendingOrganizationJoinToken(): string | null {
  try {
    return sessionStorage.getItem(PENDING_JOIN_TOKEN_KEY)
  } catch {
    return null
  }
}

export function setPendingOrganizationJoinToken(token: string): void {
  try {
    sessionStorage.setItem(PENDING_JOIN_TOKEN_KEY, token)
  } catch {
    // The hook also keeps the token in memory.
  }
}

export function clearPendingOrganizationJoinToken(): void {
  try {
    sessionStorage.removeItem(PENDING_JOIN_TOKEN_KEY)
  } catch {
    // Nothing else to clear.
  }
}

export function createOrganizationContextKey(
  accountId: string,
  organizationId: string,
): string {
  return createSharedOrganizationContextKey(accountId, organizationId)
}

export function createOrganizationScopedStorageKey(
  accountId: string,
  organizationId: string,
  namespace: string,
): string {
  // No v1 key is currently persisted by production callers. Start the
  // collision-free format at v2 so a future reader can identify its encoding.
  return `${ORGANIZATION_SCOPED_STORAGE_PREFIX}${
    createOrganizationContextKey(accountId, organizationId)
  }:${namespace}`
}

export function createOrganizationJoinDeepLink(token: string): string {
  return `poloai://join/${encodeURIComponent(token)}`
}
