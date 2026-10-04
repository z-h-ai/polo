import type { AppCatalogCacheEntry, CatalogApp } from '@polo-ai/shared/admin'
import {
  dedupeCatalogAppsByIdentity,
  getCatalogAppIdentityKey,
} from '@polo-ai/shared/admin/catalog-view'

/**
 * POO-70 H1 home app directory projection (P70-CATALOG-01/02/03).
 *
 * Pure, React-free selection over the authoritative ProductSpace Catalog
 * cache entry. Consumers (HomePage today, MemberCatalog consumers after the
 * H2/H3 extraction) pass the CURRENT space's catalog plus the context they
 * render for; the projection:
 *
 * - returns the COMPLETE authorized directory of the space (no frequently-
 *   used cap), deduplicated by the stable Catalog identity tuple — never by
 *   display name or version id;
 * - keeps ALL recorded authorization sources per row and marks their
 *   validity separately from availability: one circle authorization lost
 *   keeps the work usable, only the LAST valid source failing blocks it;
 * - refuses (fail closed) cross-space receipts and rows whose authorization
 *   cannot be proven from authoritative sources;
 * - separates loading / vacuum / error / denied / offline as distinct
 *   phases; a failure never fills the view with another space's cache and a
 *   cached row never grants launch authority (launch stays with the existing
 *   `useAppCatalog().resolveLaunch` online grant).
 */

export type HomeAppSourceKind = 'polo' | 'creator_circle' | 'enterprise_import'

export type HomeAppSourceRefusal =
  | 'circle_authorization_lost'
  | 'unprovable'
  | 'foreign_space_kind'

export interface HomeAppDirectorySource {
  kind: HomeAppSourceKind
  /** creator_circle sources only; null for polo / enterprise_import. */
  circleId: string | null
  name: string | null
  /**
   * Whether this source still proves authorization. Recorded sources are
   * valid unless the authoritative member-circle contract reports the circle
   * lost, or the record itself cannot prove which authority granted it.
   */
  valid: boolean
  /** Why an invalid source was refused; null for valid sources. */
  refusal: HomeAppSourceRefusal | null
}

export type HomeAppDirectoryAvailability = 'available' | 'withdrawn' | 'unavailable'

export type HomeAppDirectoryRawAvailability =
  | 'available'
  | 'unavailable'
  | 'blocked'
  | 'withdrawn'

export interface HomeAppDirectoryEntry {
  /**
   * Collision-free STABLE identity key
   * (account + productSpace + catalogEntry + artifactInstance). NEVER the
   * display name: two works may share a name and one work keeps its identity
   * across a version change.
   */
  identityKey: string
  catalogEntryId: string
  artifactInstanceId: string | null
  /**
   * The authoritative projected row. Launch authority never comes from the
   * directory: consumers launch through the existing resolve-launch grant.
   */
  app: CatalogApp
  /**
   * All authorization sources recorded by the Catalog for this work, each
   * with its current validity — stable identity, valid sources and
   * availability are recorded separately.
   */
  sources: HomeAppDirectorySource[]
  /** Authoritative availability of the winning row (UI projection). */
  availability: HomeAppDirectoryAvailability
  /** RAW sealed availability of the authoritative entry ('blocked' intact). */
  rawAvailability: HomeAppDirectoryRawAvailability | null
  /**
   * True when the work must not launch: authoritative availability is not
   * 'available', or NO valid source remains (last source failing blocks).
   * A single lost circle source keeps the work usable.
   *
   * Scope: this flag covers ONLY per-row facts (availability + valid
   * sources). It does NOT fold in accessMode — an offline/denied directory
   * blocks every row through the `phase`/`accessMode` input, which consumers
   * must combine with this flag; the actual enforcement stays in
   * `useAppCatalog().resolveLaunch` (fresh online grant).
   */
  launchBlocked: boolean
}

export type HomeAppDirectoryRejectionReason =
  | 'foreign_space_scope'
  | 'unprovable_sources'
  | 'space_kind_source_mismatch'

export interface HomeAppDirectoryRejection {
  reason: HomeAppDirectoryRejectionReason
  catalogEntryId: string | null
  /** Display name for audit only — never used as an identity. */
  name: string | null
}

/**
 * Distinct renderer phases for P70-CATALOG-03: loading, vacuum (empty),
 * error, denied and offline are separate states. A phase never synthesizes
 * data: entries accompany the phase only when the projection is authoritative
 * for the CURRENT space.
 */
export type HomeAppDirectoryPhase =
  | 'no-space'
  | 'loading'
  | 'empty'
  | 'error'
  | 'denied'
  | 'offline'
  | 'ready'

export interface HomeAppDirectoryContext {
  /** Active account the directory is rendered for; null when signed out. */
  accountId: string | null
  /** Active ProductSpace the directory is rendered for; null when none. */
  productSpaceId: string | null
  spaceKind: 'personal' | 'enterprise' | null
  /** Authoritative loader essentials for phase separation. */
  loading?: boolean
  errorCode?: string | null
  accessMode?: 'online' | 'offline' | 'denied' | null
  /**
   * UPSTREAM-EXPECTED (POO-81 member-circle contract, not landed at the H1
   * pin): circleIds whose authorization the member-circle authority reports
   * as lost. Absent or empty means every recorded circle source stays valid —
   * the projection NEVER guesses a loss from names, versions or staleness.
   * Until that contract lands this input stays empty in production consumers
   * and is exercised by fixture tests only.
   */
  lostCircleIds?: ReadonlySet<string> | null
}

export interface HomeAppDirectory {
  phase: HomeAppDirectoryPhase
  /**
   * Deduplicated full directory in authoritative Catalog entry order. Empty
   * unless the projection is authoritative for the CURRENT space context.
   */
  entries: HomeAppDirectoryEntry[]
  /** Consumer-side refusals, recorded for audit and tests. */
  rejections: HomeAppDirectoryRejection[]
  stats: {
    /** Raw rows seen (live + withdrawn tombstones). */
    catalogRows: number
    /** Identity collisions collapsed (live row wins over withdrawn). */
    duplicatesDropped: number
    /** Rows refused consumer-side (see rejections). */
    rejectedRows: number
  }
}

function isHomeAppSourceKind(kind: string): kind is HomeAppSourceKind {
  return kind === 'polo' || kind === 'creator_circle' || kind === 'enterprise_import'
}

/**
 * Consumer-side source-kind guard: a personal space is granted by Polo and
 * creator circles only, an enterprise space by enterprise imports only. The
 * trusted Catalog boundary already enforces this server-side; a violation
 * here means a foreign/corrupt projection, which must not inherit sources
 * across space kinds (P70-CATALOG-02: no personal-circle inheritance into
 * enterprise directories).
 */
function spaceKindAllowsSource(
  spaceKind: 'personal' | 'enterprise' | null,
  kind: HomeAppSourceKind,
): boolean {
  if (spaceKind === 'personal') return kind === 'polo' || kind === 'creator_circle'
  if (spaceKind === 'enterprise') return kind === 'enterprise_import'
  return true
}

function projectSource(
  source: { kind: string; name?: string; circleId?: string },
  context: HomeAppDirectoryContext,
): HomeAppDirectorySource {
  const name = typeof source.name === 'string' && source.name.trim()
    ? source.name.trim()
    : null
  const circleId = typeof source.circleId === 'string' && source.circleId
    ? source.circleId
    : null
  if (!isHomeAppSourceKind(source.kind)) {
    // Unknown source kinds cannot prove which authority granted the work.
    return { kind: source.kind as HomeAppSourceKind, circleId, name, valid: false, refusal: 'unprovable' }
  }
  if (!spaceKindAllowsSource(context.spaceKind, source.kind)) {
    // A source kind that cannot exist in this space kind is a foreign
    // receipt (e.g. a creator circle leaking into an enterprise directory).
    return { kind: source.kind, circleId, name, valid: false, refusal: 'foreign_space_kind' }
  }
  if (source.kind === 'creator_circle') {
    // Multi-circle authorization is keyed by sources.circleId. A creator
    // circle source without a circleId cannot prove WHICH circle granted the
    // work, and falling back to the display name would use a display name as
    // an identity — refused instead.
    if (!circleId) {
      return { kind: source.kind, circleId: null, name, valid: false, refusal: 'unprovable' }
    }
    if (context.lostCircleIds?.has(circleId)) {
      return {
        kind: source.kind,
        circleId,
        name,
        valid: false,
        refusal: 'circle_authorization_lost',
      }
    }
  }
  return { kind: source.kind, circleId, name, valid: true, refusal: null }
}

function selectDirectoryPhase(
  catalog: AppCatalogCacheEntry | null,
  context: HomeAppDirectoryContext,
  entryCount: number,
): HomeAppDirectoryPhase {
  if (!context.productSpaceId || !context.accountId) return 'no-space'
  // ONE precedence for BOTH branches: an authoritative access decision
  // (denied, then offline) outranks a transport failure, which outranks the
  // remaining states. A first-sync denial arrives with catalog:null +
  // errorCode + accessMode:'denied' (the denied tombstone is only retained
  // when one was returned), so the denied check MUST come before the error
  // check here or the phase would misread it as a plain load error.
  if (context.accessMode === 'denied') return 'denied'
  if (context.accessMode === 'offline') return 'offline'
  if (!catalog) {
    if (context.loading) return 'loading'
    if (context.errorCode) return 'error'
    // An authoritative gap (e.g. a superseded context transition) is never
    // presented as a vacuum — the view keeps waiting for authority.
    return 'loading'
  }
  if (context.errorCode) return 'error'
  if (entryCount === 0) return 'empty'
  return 'ready'
}

/**
 * Projects the CURRENT space's Catalog into the home app directory.
 * `catalog` must be the active space's authoritative cache entry (as held by
 * the single `useAppCatalog` instance); `context` describes the space the
 * consumer renders for. Passing a catalog of ANOTHER space is refused: the
 * returned directory is empty and the refusal recorded — a failure must never
 * be filled with another space's cache.
 */
export function selectHomeAppDirectory(
  catalog: AppCatalogCacheEntry | null,
  context: HomeAppDirectoryContext,
): HomeAppDirectory {
  const rejections: HomeAppDirectoryRejection[] = []
  const stats = { catalogRows: 0, duplicatesDropped: 0, rejectedRows: 0 }

  if (!catalog || !context.accountId || !context.productSpaceId) {
    if (catalog) {
      // The caller holds a catalog but renders without an active space
      // context: the receipt is refused wholesale (fail closed).
      rejections.push({
        reason: 'foreign_space_scope',
        catalogEntryId: null,
        name: null,
      })
      stats.rejectedRows += 1
    }
    return {
      phase: selectDirectoryPhase(null, context, 0),
      entries: [],
      rejections,
      stats,
    }
  }

  if (
    catalog.accountId !== context.accountId
    || catalog.organizationId !== context.productSpaceId
  ) {
    // Cross-space stale receipt: never fill the current view with it.
    rejections.push({ reason: 'foreign_space_scope', catalogEntryId: null, name: null })
    stats.rejectedRows += 1
    return {
      phase: selectDirectoryPhase(null, context, 0),
      entries: [],
      rejections,
      stats,
    }
  }

  const deduped = dedupeCatalogAppsByIdentity(catalog)
  stats.catalogRows = catalog.apps.length + (catalog.withdrawnApps?.length ?? 0)
  stats.duplicatesDropped = deduped.duplicatesDropped

  const entries: HomeAppDirectoryEntry[] = []
  for (const app of deduped.apps) {
    if (app.organizationId !== catalog.organizationId) {
      rejections.push({
        reason: 'foreign_space_scope',
        catalogEntryId: app.catalogEntryId ?? null,
        name: app.name,
      })
      stats.rejectedRows += 1
      continue
    }
    const sources = (app.catalogSources ?? []).map(source => projectSource(source, context))
    if (!sources.some(source => source.valid)) {
      const onlyLost = sources.length > 0
        && sources.every(source => source.refusal === 'circle_authorization_lost')
      if (onlyLost) {
        // Every recorded circle authorization was authoritatively lost — the
        // last source failing blocks the work, but the row stays visible for
        // explanation (never hidden, never launchable).
      } else {
        rejections.push({
          reason: sources.some(source => source.refusal === 'foreign_space_kind')
            ? 'space_kind_source_mismatch'
            : 'unprovable_sources',
          catalogEntryId: app.catalogEntryId ?? null,
          name: app.name,
        })
        stats.rejectedRows += 1
        continue
      }
    }
    const availability: HomeAppDirectoryAvailability = app.availability ?? 'unavailable'
    entries.push({
      identityKey: getCatalogAppIdentityKey(catalog, app),
      catalogEntryId: app.catalogEntryId ?? app.id,
      artifactInstanceId: app.artifactInstanceId ?? null,
      app,
      sources,
      availability,
      rawAvailability: app.rawAvailability ?? null,
      // Cache never grants launch: blocked/unavailable/withdrawn rows and
      // rows without a remaining valid source are not launchable.
      launchBlocked: availability !== 'available' || !sources.some(source => source.valid),
    })
  }

  return {
    // Phase reflects the CURRENT space's authoritative state; it is computed
    // from the validated projection, never from a foreign catalog.
    phase: selectDirectoryPhase(catalog, context, entries.length),
    entries,
    rejections,
    stats,
  }
}
