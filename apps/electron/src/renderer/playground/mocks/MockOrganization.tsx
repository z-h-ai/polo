import * as React from 'react'
import { OrganizationProvider, type OrganizationContextValue } from '@/context/OrganizationContext'
import type {
  OrganizationMembership,
  OrganizationRole,
  OrganizationSummary,
  OrganizationType,
} from '../../../shared/types'

export interface MakeOrganizationSummaryOverrides
  extends Partial<Omit<OrganizationSummary, 'id' | 'membership'>> {
  id?: string
  /** Shallow-merged over the active-owner default. */
  membership?: Partial<Pick<OrganizationMembership, 'id' | 'role' | 'status'>>
}

/**
 * Factory for demo `OrganizationSummary` values. Defaults describe a
 * personal creator space owned by the demo account; pass overrides (e.g.
 * `status: 'suspended'` + `membership: { status: 'removed' }`) to build
 * revoked / suspended variants quickly.
 */
export function makeOrganizationSummary(
  overrides: MakeOrganizationSummaryOverrides = {},
): OrganizationSummary {
  const id = overrides.id ?? 'org-demo'
  const { membership, ...rest } = overrides
  return {
    id,
    type: 'creator_space',
    name: id,
    purpose: '',
    memberCount: 1,
    ...rest,
    membership: {
      id: `membership-${id}`,
      role: 'owner',
      status: 'active',
      ...membership,
    },
  }
}

export interface MockOrganizationProviderProps {
  /** Space list surfaced through the context. */
  organizations: OrganizationSummary[]
  /** Active space id; defaults to the first organization. */
  activeId?: string
  /** Defaults to 'account-demo'. */
  accountId?: string
  /** Defaults to 1. */
  contextVersion?: number
  children: React.ReactNode
}

const NO_OP = () => {}

/**
 * MockOrganizationProvider — fills the real organization context with static
 * demo data (all callbacks no-op). The value shape is aligned with
 * `OrganizationContextValue` and derives `organizationMembershipRole` /
 * `organizationContextKey` from the active organization.
 */
export function MockOrganizationProvider({
  organizations,
  activeId,
  accountId = 'account-demo',
  contextVersion = 1,
  children,
}: MockOrganizationProviderProps) {
  const value = React.useMemo<OrganizationContextValue>(() => {
    const active = organizations.find((org) => org.id === activeId) ?? organizations[0]
    const role: OrganizationRole = active?.membership.role ?? 'owner'
    return {
      accountId,
      activeOrganizationId: active?.id ?? '',
      organizationSummaries: organizations,
      organizationMembershipRole: role,
      organizationContextKey: `${accountId}:${active?.id ?? 'none'}`,
      contextVersion,
      onSelectOrganization: NO_OP,
      onManageOrganization: NO_OP,
      onCreateOrganization: NO_OP,
    }
  }, [organizations, activeId, accountId, contextVersion])

  return <OrganizationProvider value={value}>{children}</OrganizationProvider>
}
