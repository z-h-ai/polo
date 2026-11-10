import { getProductSpaceContextStorage } from '@polo-ai/shared/config'
import type { ListProjectsResponse, ProjectSummary } from '@polo-ai/shared/protocol'
import type { TrustedAggregateScopeToken } from '../handlers/rpc/trusted-product-space-account'
import {
  captureTrustedScopeToken,
  getAccountTransitionEpoch,
  getTrustedAccountGeneration,
  isAccountTransitionInProgress,
  resolveTrustedProductSpaceAccountId,
} from '../handlers/rpc/trusted-product-space-account'
import {
  getRuntimeActiveProductSpaceScope,
  getRuntimeFenceGeneration,
} from '../runtime/product-space-executions'
import { getProjectMembersAdmin, type ProjectMembersAdmin } from './admin-client'

export type { ProjectMembersAdmin }

/**
 * POO-205 C7a — the server-side project-context resolver (P3-1).
 *
 * The renderer-supplied `projectContext` snapshot is presentation state, never
 * authority: before a project session is CREATED or before a user message is
 * APPENDED to a project session, the session layer re-proves the caller's
 * membership against polo-admin (`listProjects` — the same read the projects
 * panel uses) and takes name/purpose/instructions from THAT response.
 *
 * Three outcomes, all fail-closed:
 * - `member`      — the caller's membership and the authoritative snapshot;
 * - `not_member`  — admin answered but the project is not in the caller's
 *                   list (removed, or never a member) → callers refuse with
 *                   `prj_not_found`;
 * - `unavailable` — admin unreachable / 5xx / timeout / no trusted scope /
 *                   personal space: callers refuse CREATE
 *                   (`PROJECT_CONTEXT_UNAVAILABLE`) and SEND on the session's
 *                   persisted snapshot with a warning.
 *
 * Results are cached per (accountId, organizationEnterpriseId) for
 * CACHE_TTL_MS so a burst of sends doesn't hammer admin, concurrent callers
 * for one key share one in-flight fetch, and every successful pm write
 * (project PATCH, member add/update/remove — see service.ts) invalidates the
 * organization's cache so the next send sees fresh instructions. Identity is
 * never invented here: every call re-derives the trusted account/space scope
 * through the same helpers the pm commands use.
 */

/** Context the resolver vouches for (same shape as the session's persisted
 * `projectContext` field; the role/count bookkeeping stays admin-side). */
export interface ResolvedProjectContext {
  name: string
  purpose?: string
  instructions?: string
}

export type ProjectContextResolution =
  | { status: 'member'; context: ResolvedProjectContext }
  | { status: 'not_member' }
  | { status: 'unavailable' }

export interface ResolveProjectContextInput {
  /** The caller's trusted admin account id. */
  accountId: string
  /** The committed product space the caller is operating in. */
  productSpaceId: string
  /** The project-bound session's project id. */
  projectId: string
}

const CACHE_TTL_MS = 30_000
const LIST_TIMEOUT_MS = 3_000

interface CacheEntry {
  fetchedAt: number
  projects: ProjectSummary[]
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ProjectSummary[]>>()

/** Test seams: admin adapter + clock, so tests never touch the network. */
let adminAdapter: ProjectMembersAdmin | null = null
let clock: () => number = () => Date.now()

export function setProjectContextResolverAdminForTests(admin: ProjectMembersAdmin | null): void {
  adminAdapter = admin
}

export function setProjectContextResolverClockForTests(now: () => number): void {
  clock = now ?? (() => Date.now())
}

export function resetProjectContextResolverForTests(): void {
  adminAdapter = null
  clock = () => Date.now()
  enterpriseSpaceReader = defaultEnterpriseSpaceReader
  cache.clear()
  inflight.clear()
}

/**
 * Called by the pm write commands in service.ts after a successful project
 * PATCH / membership change: the next send must observe the new instructions
 * (or the removal) instead of a ≤30s-stale cache.
 */
export function invalidateProjectContextCache(organizationEnterpriseId?: string): void {
  if (!organizationEnterpriseId) {
    cache.clear()
    return
  }
  for (const key of cache.keys()) {
    if (key.endsWith(`\u0000${organizationEnterpriseId}`)) cache.delete(key)
  }
}

const cacheKey = (accountId: string, organizationEnterpriseId: string): string =>
  `${accountId}\u0000${organizationEnterpriseId}`

/**
 * The await-spanning freshness check for the captured token — the same CAS
 * the pm commands apply (service.ts `isAccountScopeTokenCurrent`), inlined
 * here rather than imported so service.ts can depend on this module's
 * invalidation hook without a cycle.
 */
function isScopeTokenCurrent(token: TrustedAggregateScopeToken): boolean {
  if (isAccountTransitionInProgress()) return false
  if (getAccountTransitionEpoch() !== token.transitionEpoch) return false
  if (getTrustedAccountGeneration() !== token.accountGeneration) return false
  if (getRuntimeFenceGeneration() !== token.fenceGeneration) return false
  const runtimeScope = getRuntimeActiveProductSpaceScope()
  return Boolean(
    runtimeScope
    && runtimeScope.accountId === token.accountId
    && runtimeScope.productSpaceId === token.productSpaceId,
  )
}

/**
 * The committed space reader — same source as service.ts's
 * `defaultActiveProductSpaceReader` (the account's verified product-space
 * list). A test seam so resolver tests never touch the preferences file.
 */
type EnterpriseSpaceReader = (accountId: string, productSpaceId: string) => { kind: string; enterpriseId?: string } | null

const defaultEnterpriseSpaceReader: EnterpriseSpaceReader = (accountId, productSpaceId) => {
  const verified = getProductSpaceContextStorage(accountId)?.verifiedContext
  return verified?.list.productSpaces.find(space => space.id === productSpaceId) ?? null
}

let enterpriseSpaceReader: EnterpriseSpaceReader = defaultEnterpriseSpaceReader

/** Test seam: pin the committed-space reader for one file. */
export function setProjectContextResolverSpaceReaderForTests(reader: EnterpriseSpaceReader | null): void {
  enterpriseSpaceReader = reader ?? defaultEnterpriseSpaceReader
}

/**
 * The committed enterprise space for the caller, re-derived from the same
 * trusted sources as the pm commands — never from renderer state. `null`
 * means the caller is not proving an enterprise space right now (personal
 * space, signed out, or the runtime fence moved) → `unavailable`.
 */
function resolveEnterpriseScope(input: ResolveProjectContextInput): {
  organizationEnterpriseId: string
  token: TrustedAggregateScopeToken
} | null {
  const runtimeScope = getRuntimeActiveProductSpaceScope()
  if (!runtimeScope) return null
  if (runtimeScope.accountId !== input.accountId || runtimeScope.productSpaceId !== input.productSpaceId) {
    return null
  }
  const token = captureTrustedScopeToken()
  if (!token) return null
  if (!isScopeTokenCurrent(token)) return null
  const space = enterpriseSpaceReader(input.accountId, input.productSpaceId)
  if (!space || space.kind !== 'enterprise' || !space.enterpriseId) return null
  return { organizationEnterpriseId: space.enterpriseId, token }
}

async function fetchProjectsWithTimeout(
  admin: ProjectMembersAdmin,
  organizationEnterpriseId: string,
): Promise<ListProjectsResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      admin.listProjects(organizationEnterpriseId),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('project context lookup timed out')), LIST_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchProjectsForScope(
  admin: ProjectMembersAdmin,
  key: string,
  organizationEnterpriseId: string,
): Promise<ProjectSummary[]> {
  const existing = inflight.get(key)
  if (existing) return existing
  const pending = fetchProjectsWithTimeout(admin, organizationEnterpriseId)
    .then(response => {
      const projects = response.projects
      cache.set(key, { fetchedAt: clock(), projects })
      return projects
    })
    .finally(() => {
      if (inflight.get(key) === pending) inflight.delete(key)
    })
  inflight.set(key, pending)
  return pending
}

/**
 * Resolve the authoritative project context for (accountId, productSpaceId,
 * projectId). Never throws: every failure collapses into `unavailable`.
 */
export async function resolveProjectContext(input: ResolveProjectContextInput): Promise<ProjectContextResolution> {
  try {
    const scope = resolveEnterpriseScope(input)
    if (!scope) return { status: 'unavailable' }
    const admin = adminAdapter ?? getProjectMembersAdmin()
    const key = cacheKey(input.accountId, scope.organizationEnterpriseId)
    const cached = cache.get(key)
    let projects: ProjectSummary[]
    if (cached && clock() - cached.fetchedAt < CACHE_TTL_MS) {
      projects = cached.projects
    } else {
      try {
        projects = await fetchProjectsForScope(admin, key, scope.organizationEnterpriseId)
      } catch {
        return { status: 'unavailable' }
      }
    }
    // The scope may have moved while admin answered (account switch, space
    // change, fence generation bump): treat the fetch as if it never happened.
    if (!isScopeTokenCurrent(scope.token)) return { status: 'unavailable' }
    const project = projects.find(candidate => candidate.id === input.projectId)
    if (!project) return { status: 'not_member' }
    const context: ResolvedProjectContext = {
      name: project.name,
      ...(project.purpose === undefined ? {} : { purpose: project.purpose }),
      ...(project.instructions === undefined ? {} : { instructions: project.instructions }),
    }
    return { status: 'member', context }
  } catch {
    return { status: 'unavailable' }
  }
}

/** Test helper: the cached ListProjectsResponse bookkeeping, exposed so tests
 * can assert TTL expiry/in-flight dedupe without touching internals. */
export function __projectContextResolverStateForTests(): {
  cachedKeys: () => string[]
  inflightCount: () => number
} {
  return {
    cachedKeys: () => [...cache.keys()],
    inflightCount: () => inflight.size,
  }
}
