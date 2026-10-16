import type { LlmConnection } from './llm-connections'

/** Persistable, non-secret provenance. Never contains a proxy URL/capability. */
export interface DesktopManagedOwner {
  computeSource: 'desktop-managed'
  accountId: string
  productSpaceId: string
  adminOrigin: string
}
export interface DesktopManagedDescriptor {
  version: 1
  leaseId: string
  execution: { threadId: string; configurationScopeId: string; ownerPid: number; ownerBirth: string; ownerLease: string }
  owner: DesktopManagedOwner
  spaceName: string
  spaceKind: 'personal' | 'enterprise'
  model: string
  allowedModels: string[]
  proxyUrl: string
  capability: string
}
export function sameDesktopManagedOwner(a: DesktopManagedOwner, b: DesktopManagedOwner): boolean {
  return a.computeSource === b.computeSource && a.accountId === b.accountId
    && a.productSpaceId === b.productSpaceId && a.adminOrigin === b.adminOrigin
}
/** Only a verified desktop lease can authorize this route in SessionManager. */
export function desktopManagedConnection(d: DesktopManagedDescriptor): LlmConnection {
  const url = new URL(d.proxyUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/v1'
    || url.username || url.password || url.search || url.hash || d.version !== 1
    || !d.allowedModels.includes(d.model) || !d.capability || d.capability.length < 32) throw new Error('POLO_MANAGED_DESCRIPTOR_REJECTED')
  return { slug: `polo-space-${d.owner.productSpaceId}`, name: 'Polo', providerType: 'pi', piAuthProvider: 'openai', authType: 'api_key', managedBy: 'admin', baseUrl: d.proxyUrl,
    customEndpoint: { api: 'openai-completions', supportsImages: false }, models: d.allowedModels, defaultModel: d.model, createdAt: 0 }
}
