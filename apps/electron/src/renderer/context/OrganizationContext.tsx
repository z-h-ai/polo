import * as React from 'react'
import { createContext, useContext } from 'react'
import type {
  OrganizationRole,
  OrganizationSummary,
} from '../../shared/types'

export interface OrganizationContextValue {
  accountId: string
  activeOrganizationId: string
  organizationSummaries: OrganizationSummary[]
  organizationMembershipRole: OrganizationRole
  organizationContextKey: string
  contextVersion: number
  onSelectOrganization: (organizationId: string) => void
  onManageOrganization: () => void
  onCreateOrganization: () => void
}

const OrganizationContext = createContext<OrganizationContextValue | null>(null)

export function OrganizationProvider({
  children,
  value,
}: {
  children: React.ReactNode
  value: OrganizationContextValue
}) {
  return (
    <OrganizationContext.Provider value={value}>
      {children}
    </OrganizationContext.Provider>
  )
}

export function useOrganizationContext(): OrganizationContextValue {
  const value = useContext(OrganizationContext)
  if (!value) {
    throw new Error('useOrganizationContext must be used within OrganizationProvider')
  }
  return value
}

export function useOptionalOrganizationContext(): OrganizationContextValue | null {
  return useContext(OrganizationContext)
}
