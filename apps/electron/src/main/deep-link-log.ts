import { createHash } from 'node:crypto'

export interface DeepLinkLogContext {
  routeType: 'action' | 'auth-callback' | 'join' | 'view' | 'workspace' | 'unknown' | 'invalid'
  fingerprint: string
}

export type UrlLogContext = DeepLinkLogContext | { url: string }

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

export function isPoloAiDeepLinkUrl(url: string): boolean {
  const supportedSchemes = new Set([
    'poloai',
    process.env.POLO_AI_DEEPLINK_SCHEME?.toLowerCase(),
  ].filter((scheme): scheme is string => Boolean(scheme)))

  try {
    return supportedSchemes.has(new URL(url).protocol.replace(/:$/, '').toLowerCase())
  } catch {
    const scheme = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
    return scheme ? supportedSchemes.has(scheme) : false
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

/**
 * Classify a URL before logging. Internal deep links are always reduced to
 * their safe route/fingerprint pair; only non-deep-link URLs may be retained.
 */
export function describeUrlForLog(url: string): UrlLogContext {
  return isPoloAiDeepLinkUrl(url)
    ? describeDeepLinkForLog(url)
    : { url }
}
