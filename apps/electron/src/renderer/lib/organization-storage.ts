import { ListOrganizationsResponseSchema } from '@z-h-ai/shared/admin/schemas'
import {
  createOrganizationContextKey as createSharedOrganizationContextKey,
} from '@z-h-ai/shared/admin/context-key'
import type { OrganizationSummary } from '@z-h-ai/shared/admin'
import type {
  OrganizationContextStorage,
  OrganizationContextStoragePatch,
  UnavailableOrganizationTombstonePreference,
  VerifiedOrganizationContextPreference,
} from '@z-h-ai/shared/config/organization-context'

const ACTIVE_ORGANIZATION_PREFIX = 'polo-active-organization:'
const VERIFIED_ORGANIZATION_CONTEXT_PREFIX = 'polo-verified-organization-context:'
const UNAVAILABLE_ORGANIZATION_PREFIX = 'polo-unavailable-organization:'
const PENDING_JOIN_TOKEN_KEY = 'polo-pending-organization-join-token'
const ORGANIZATION_SCOPED_STORAGE_PREFIX = 'polo-organization:v2:'
const activeOrganizationIdsByAccount = new Map<string, string>()

export function resetOrganizationStorageMemoryForTests(): void {
  activeOrganizationIdsByAccount.clear()
}

function readLegacyLocalStorage(key: string): string | null {
  // eslint-disable-next-line polo-ai/no-localstorage -- one-time migration only
  return localStorage.getItem(key)
}

function removeLegacyLocalStorage(key: string): void {
  // eslint-disable-next-line polo-ai/no-localstorage -- one-time migration only
  localStorage.removeItem(key)
}

function activeOrganizationKey(accountId: string): string {
  return `${ACTIVE_ORGANIZATION_PREFIX}${accountId}`
}

function verifiedOrganizationContextKey(accountId: string): string {
  return `${VERIFIED_ORGANIZATION_CONTEXT_PREFIX}${accountId}`
}

function unavailableOrganizationKey(accountId: string): string {
  return `${UNAVAILABLE_ORGANIZATION_PREFIX}${accountId}`
}

export type VerifiedOrganizationContext =
  VerifiedOrganizationContextPreference
export type UnavailableOrganizationTombstone =
  UnavailableOrganizationTombstonePreference

function isActiveOrganization(organization: OrganizationSummary): boolean {
  return organization.status !== 'suspended'
    && organization.membership.status === 'active'
}

export function getStoredActiveOrganizationId(accountId: string): string | null {
  const inMemory = activeOrganizationIdsByAccount.get(accountId)
  if (inMemory !== undefined) return inMemory
  try {
    const legacy = readLegacyLocalStorage(activeOrganizationKey(accountId))
    if (legacy) activeOrganizationIdsByAccount.set(accountId, legacy)
    return legacy
  } catch {
    return null
  }
}

export function setStoredActiveOrganizationId(
  accountId: string,
  organizationId: string,
): void {
  activeOrganizationIdsByAccount.set(accountId, organizationId)
}

export function clearStoredActiveOrganizationId(accountId: string): void {
  activeOrganizationIdsByAccount.delete(accountId)
  try {
    removeLegacyLocalStorage(activeOrganizationKey(accountId))
  } catch {
    // Nothing else to clear.
  }
}

function applyVerifiedActiveOrganization(
  accountId: string,
  context: VerifiedOrganizationContext | undefined,
): void {
  if (!context) return
  if (context.activeOrganizationId) {
    setStoredActiveOrganizationId(accountId, context.activeOrganizationId)
    try {
      removeLegacyLocalStorage(activeOrganizationKey(accountId))
    } catch {
      // The durable verified context remains authoritative.
    }
    return
  }
  clearStoredActiveOrganizationId(accountId)
}

function readLegacyVerifiedOrganizationContext(
  accountId: string,
): VerifiedOrganizationContext | null {
  try {
    const raw = readLegacyLocalStorage(
      verifiedOrganizationContextKey(accountId),
    )
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

function parseVerifiedOrganizationContext(
  value: unknown,
): VerifiedOrganizationContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parsed = value as Partial<VerifiedOrganizationContext>
  const verified = ListOrganizationsResponseSchema.safeParse({
    organizations: parsed.organizationSummaries,
  })
  if (
    !verified.success
    || (parsed.activeOrganizationId !== null
      && typeof parsed.activeOrganizationId !== 'string')
    || typeof parsed.verifiedAt !== 'number'
    || !Number.isInteger(parsed.verifiedAt)
    || parsed.verifiedAt < 0
  ) {
    return null
  }
  const activeOrganizationId = parsed.activeOrganizationId ?? null
  const verifiedActiveOrganizationId = activeOrganizationId
    && verified.data.organizations.some(organization => (
      organization.id === activeOrganizationId
      && isActiveOrganization(organization)
    ))
    ? activeOrganizationId
    : null
  if (activeOrganizationId && !verifiedActiveOrganizationId) return null
  return {
    organizationSummaries: verified.data.organizations,
    activeOrganizationId: verifiedActiveOrganizationId,
    verifiedAt: parsed.verifiedAt,
  }
}

function readLegacyUnavailableOrganizationTombstone(
  accountId: string,
): UnavailableOrganizationTombstone | null {
  try {
    const raw = readLegacyLocalStorage(unavailableOrganizationKey(accountId))
    if (!raw) return null
    return parseUnavailableOrganizationTombstone(JSON.parse(raw))
  } catch {
    return null
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

function parseUnavailableOrganizationTombstone(
  value: unknown,
): UnavailableOrganizationTombstone | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parsed = value as Partial<UnavailableOrganizationTombstone>
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
}

function sanitizeOrganizationContextStorage(
  value: OrganizationContextStorage | null,
): OrganizationContextStorage {
  const verifiedContext = parseVerifiedOrganizationContext(
    value?.verifiedContext,
  )
  const unavailableTombstone = parseUnavailableOrganizationTombstone(
    value?.unavailableTombstone,
  )
  return {
    ...(verifiedContext ? { verifiedContext } : {}),
    ...(unavailableTombstone ? { unavailableTombstone } : {}),
  }
}

function removeLegacyOrganizationStorage(
  accountId: string,
  fields: {
    verifiedContext?: boolean
    unavailableTombstone?: boolean
  },
): void {
  try {
    if (fields.verifiedContext) {
      removeLegacyLocalStorage(verifiedOrganizationContextKey(accountId))
    }
    if (fields.unavailableTombstone) {
      removeLegacyLocalStorage(unavailableOrganizationKey(accountId))
    }
  } catch {
    // A successful durable write remains authoritative even if legacy cleanup
    // is unavailable in a hardened renderer.
  }
}

export async function getOrganizationContextStorage(
  accountId: string,
): Promise<OrganizationContextStorage> {
  let persisted: OrganizationContextStorage = {}
  try {
    persisted = sanitizeOrganizationContextStorage(
      await window.electronAPI.getOrganizationContextStorage(accountId),
    )
  } catch {
    // The one-time legacy snapshot remains usable if local preferences cannot
    // currently be reached.
  }

  const legacyVerified = readLegacyVerifiedOrganizationContext(accountId)
  const legacyTombstone = readLegacyUnavailableOrganizationTombstone(accountId)
  const patch: OrganizationContextStoragePatch = {}
  if (!persisted.verifiedContext && legacyVerified) {
    patch.verifiedContext = legacyVerified
  }
  if (!persisted.unavailableTombstone && legacyTombstone) {
    patch.unavailableTombstone = legacyTombstone
  }
  const hasMigration = Object.keys(patch).length > 0
  if (hasMigration) {
    const merged = {
      ...persisted,
      ...(patch.verifiedContext
        ? { verifiedContext: patch.verifiedContext }
        : {}),
      ...(patch.unavailableTombstone
        ? { unavailableTombstone: patch.unavailableTombstone }
        : {}),
    }
    try {
      const saved = sanitizeOrganizationContextStorage(
        await window.electronAPI.updateOrganizationContextStorage(
          accountId,
          patch,
        ),
      )
      if (
        (patch.verifiedContext && !saved.verifiedContext)
        || (patch.unavailableTombstone && !saved.unavailableTombstone)
      ) {
        return merged
      }
      removeLegacyOrganizationStorage(accountId, {
        verifiedContext: Boolean(patch.verifiedContext),
        unavailableTombstone: Boolean(patch.unavailableTombstone),
      })
      applyVerifiedActiveOrganization(accountId, saved.verifiedContext)
      return saved
    } catch {
      return merged
    }
  }

  removeLegacyOrganizationStorage(accountId, {
    verifiedContext: Boolean(
      persisted.verifiedContext && legacyVerified,
    ),
    unavailableTombstone: Boolean(
      persisted.unavailableTombstone && legacyTombstone,
    ),
  })
  applyVerifiedActiveOrganization(accountId, persisted.verifiedContext)
  return persisted
}

export async function getVerifiedOrganizationContext(
  accountId: string,
): Promise<VerifiedOrganizationContext | null> {
  return (await getOrganizationContextStorage(accountId)).verifiedContext ?? null
}

export async function setVerifiedOrganizationContext(
  accountId: string,
  organizationSummaries: OrganizationSummary[],
  activeOrganizationId: string | null,
): Promise<void> {
  const verifiedContext = parseVerifiedOrganizationContext({
    organizationSummaries,
    activeOrganizationId,
    verifiedAt: Date.now(),
  })
  if (!verifiedContext) return
  await window.electronAPI.updateOrganizationContextStorage(accountId, {
    verifiedContext,
    ...(verifiedContext.activeOrganizationId
      ? { unavailableTombstone: null }
      : {}),
  })
  applyVerifiedActiveOrganization(accountId, verifiedContext)
}

export async function clearVerifiedOrganizationContext(
  accountId: string,
): Promise<void> {
  await window.electronAPI.updateOrganizationContextStorage(accountId, {
    verifiedContext: null,
  })
}

export async function getUnavailableOrganizationTombstone(
  accountId: string,
): Promise<UnavailableOrganizationTombstone | null> {
  return (await getOrganizationContextStorage(accountId)).unavailableTombstone
    ?? null
}

export async function setUnavailableOrganizationContext(
  accountId: string,
  organizationSummaries: OrganizationSummary[],
  organization: OrganizationSummary,
): Promise<void> {
  const verifiedContext = parseVerifiedOrganizationContext({
    organizationSummaries,
    activeOrganizationId: null,
    verifiedAt: Date.now(),
  })
  if (!verifiedContext) return
  const tombstone = createUnavailableOrganizationTombstone(organization)
  await window.electronAPI.updateOrganizationContextStorage(accountId, {
    verifiedContext,
    unavailableTombstone: {
      organization: tombstone,
      recordedAt: Date.now(),
    },
  })
  clearStoredActiveOrganizationId(accountId)
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
