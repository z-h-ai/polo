import { createHash } from 'node:crypto'

export interface DeepLinkLogContext {
  routeType: 'action' | 'auth-callback' | 'join' | 'view' | 'workspace' | 'unknown' | 'invalid'
  fingerprint: string
}

const VIEW_HOSTS = new Set([
  'allSessions',
  'flagged',
  'settings',
  'skills',
  'sources',
  'state',
])

function inferDeepLinkRouteType(url: string): DeepLinkLogContext['routeType'] {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === 'action') return 'action'
    if (parsed.hostname === 'auth-callback') return 'auth-callback'
    if (parsed.hostname === 'join') return 'join'
    if (parsed.hostname === 'workspace') return 'workspace'
    if (VIEW_HOSTS.has(parsed.hostname)) return 'view'
    return 'unknown'
  } catch {
    return 'invalid'
  }
}

/**
 * Produce the only metadata allowed in main-process deep-link logs.
 * Never add the URL, parsed target, route parameters, or bearer token here.
 */
export function describeDeepLinkForLog(url: string): DeepLinkLogContext {
  return {
    routeType: inferDeepLinkRouteType(url),
    fingerprint: createHash('sha256').update(url).digest('hex').slice(0, 12),
  }
}
