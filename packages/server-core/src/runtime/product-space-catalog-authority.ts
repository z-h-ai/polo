import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { CONFIG_DIR } from '@polo-ai/shared/config/paths'
import {
  CatalogSourceSchema,
  CatalogEntryIdSchema,
  ArtifactInstanceIdSchema,
  ArtifactVersionIdSchema,
} from '@polo-ai/shared/product-spaces'

/**
 * ProductSpace Catalog authority (POO-43).
 *
 * Electron Main owns a persisted, credential-stripped record of every
 * ProductSpace Catalog it ever fetched for the signed-in account: current
 * entries plus withdrawn tombstones. It exists for exactly two purposes:
 *
 * 1. Explain-and-clean: withdrawn tombstones keep the full stable identity
 *    (catalogEntryId + artifactInstanceId + version + sources) so members can
 *    still see and uninstall a retained installation after the entry stopped
 *    being distributed — across renderer restarts.
 * 2. Withdrawn-management authorization: the restricted withdrawn IPC
 *    channels verify renderer-declared identities against this authority, so
 *    a compromised renderer cannot probe or uninstall arbitrary local Apps by
 *    fabricating catalog/version tuples.
 *
 * The authority NEVER authorizes resolve-launch, install, start, or open —
 * those require the fresh server Catalog.
 */

const AUTHORITY_SCHEMA_VERSION = 1
const MAX_AUTHORITY_ENTRIES = 10_000
const MAX_AUTHORITY_TOMBSTONES = 10_000

/**
 * Credential-stripped authority entry schema, composed from the SHARED
 * ProductSpace Catalog contracts (branded IDs, the source discriminated
 * union, the bounded HTTP(S) URL, non-blank lengths): every field the frozen
 * restricted view needs, with checksums and all delivery capability absent.
 * `availability` additionally accepts 'withdrawn' (authority-carried
 * tombstones); `withdrawnAt` marks when the tombstone was recorded.
 */
const AuthorityEntryShapeSchema = z.object({
  kind: z.literal('app'),
  catalogEntryId: CatalogEntryIdSchema,
  artifactInstanceId: ArtifactInstanceIdSchema,
  versionId: ArtifactVersionIdSchema,
  version: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  description: z.string().max(4_096),
  iconUrl: z.string().url().max(16_384).optional(),
  availability: z.enum(['available', 'unavailable', 'blocked', 'withdrawn']),
  unavailableReason: z
    .enum(['authorization_ended', 'space_restricted', 'version_unavailable', 'version_blocked'])
    .optional(),
  sources: CatalogSourceSchema.array().min(1).max(1_000),
  permissions: z.array(z.string().min(1).max(512)).max(1_000),
  withdrawnAt: z.number().int().min(0).optional(),
}).strict()

const AuthorityEntrySchema = AuthorityEntryShapeSchema.refine(
  entry => entry.availability !== 'withdrawn' || entry.withdrawnAt !== undefined,
  { message: 'A withdrawn authority entry must record withdrawnAt' },
)

function isValidAuthorityEntry(entry: unknown): entry is ProductSpaceCatalogAuthorityEntry {
  return AuthorityEntrySchema.safeParse(entry).success
}

export interface ProductSpaceCatalogAuthorityEntry {
  kind: 'app'
  catalogEntryId: string
  artifactInstanceId: string
  versionId: string
  version: string
  name: string
  description: string
  iconUrl?: string
  availability: 'available' | 'unavailable' | 'blocked' | 'withdrawn'
  unavailableReason?: string
  sources: Array<{ kind: string; name: string; circleId?: string }>
  permissions: string[]
  withdrawnAt?: number
}

interface ProductSpaceCatalogAuthorityRecord {
  schemaVersion: number
  accountId: string
  productSpaceId: string
  syncedAt: number
  catalogRevision: string
  entries: ProductSpaceCatalogAuthorityEntry[]
  tombstones: ProductSpaceCatalogAuthorityEntry[]
}

interface ProductSpaceCatalogAuthorityFile {
  schemaVersion: number
  records: Record<string, ProductSpaceCatalogAuthorityRecord>
}

let processCache: ProductSpaceCatalogAuthorityFile | null = null

/**
 * Precise-scope DENY markers from FAILED durable revocations. A revoke whose
 * write/rename failed must fail CLOSED for exactly that (account,
 * ProductSpace) scope — the stale on-disk record can never be trusted again
 * — while other scopes keep their records and a later revoke retries the
 * durable deletion.
 *
 * The markers are DURABLE state in their own file (never a "trusted empty
 * Catalog" record): they survive process restarts and cache reloads, and a
 * fresh verified Catalog clears a marker only AFTER the fresh authority
 * itself is safely persisted. A marker exists exactly when the on-disk
 * authority for that scope must read as denied.
 */
interface DeniedAuthorityMarker {
  accountId: string
  productSpaceId: string
  deniedAt: number
}

interface DeniedAuthorityMarkerFile {
  schemaVersion: number
  denied: Record<string, DeniedAuthorityMarker>
}

const DENIED_MARKER_SCHEMA_VERSION = 1

let deniedMarkerCache: DeniedAuthorityMarkerFile | null = null
/** In-memory view; always kept in sync with the durable marker file. */
const deniedAuthorityScopes = new Set<string>()

function deniedMarkerPath(): string {
  const configDir = process.env.POLO_AI_CONFIG_DIR || CONFIG_DIR
  return join(configDir, 'product-space-catalog-authority-denied.json')
}

function emptyDeniedMarkerFile(): DeniedAuthorityMarkerFile {
  return { schemaVersion: DENIED_MARKER_SCHEMA_VERSION, denied: {} }
}

function sanitizeDeniedMarkerFile(parsed: unknown): DeniedAuthorityMarkerFile | null {
  if (!parsed || typeof parsed !== 'object') return null
  const candidate = parsed as Record<string, unknown>
  if (candidate.schemaVersion !== DENIED_MARKER_SCHEMA_VERSION) return null
  if (!candidate.denied || typeof candidate.denied !== 'object') return null
  const sanitized = emptyDeniedMarkerFile()
  for (const [key, value] of Object.entries(candidate.denied as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const marker = value as Record<string, unknown>
    if (typeof marker.accountId !== 'string' || !marker.accountId) continue
    if (typeof marker.productSpaceId !== 'string' || !marker.productSpaceId) continue
    if (typeof marker.deniedAt !== 'number') continue
    // Key binding: a marker stored under a foreign scope key is dropped.
    if (productSpaceCatalogAuthorityKey(marker.accountId, marker.productSpaceId) !== key) continue
    sanitized.denied[key] = {
      accountId: marker.accountId,
      productSpaceId: marker.productSpaceId,
      deniedAt: marker.deniedAt,
    }
  }
  return sanitized
}

function loadDeniedMarkers(): DeniedAuthorityMarkerFile {
  if (deniedMarkerCache) return deniedMarkerCache
  try {
    if (existsSync(deniedMarkerPath())) {
      const parsed = JSON.parse(readFileSync(deniedMarkerPath(), 'utf8'))
      const sanitized = sanitizeDeniedMarkerFile(parsed)
      if (sanitized) {
        deniedMarkerCache = sanitized
        return deniedMarkerCache
      }
    }
  } catch {
    // A damaged marker file cannot be silently trusted-away: fall through to
    // the empty view (the authority record itself remains the truth for
    // scopes without an in-memory marker from this process lifetime).
  }
  deniedMarkerCache = emptyDeniedMarkerFile()
  return deniedMarkerCache
}

function persistDeniedMarkers(file: DeniedAuthorityMarkerFile): void {
  const path = deniedMarkerPath()
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(file), 'utf8')
  renameSync(tempPath, path)
}

/**
 * Durably records a deny marker for one scope (after a failed authority
 * revoke) and mirrors it into the in-memory set. Throws when the marker
 * itself cannot be persisted — the caller's original failure is then
 * reported with the marker durability problem still outstanding, and the
 * in-memory marker keeps THIS process fail-closed.
 */
function denyScopeDurably(scopeKey: string, marker: DeniedAuthorityMarker): void {
  deniedAuthorityScopes.add(scopeKey)
  const file = loadDeniedMarkers()
  if (file.denied[scopeKey]) return
  const records: DeniedAuthorityMarkerFile['denied'] = {}
  for (const [existingKey, existing] of Object.entries(file.denied)) {
    records[existingKey] = existing
  }
  records[scopeKey] = marker
  const next: DeniedAuthorityMarkerFile = {
    schemaVersion: DENIED_MARKER_SCHEMA_VERSION,
    denied: records,
  }
  persistDeniedMarkers(next)
  deniedMarkerCache = next
}

/**
 * Durably removes one scope's deny marker. Only called AFTER the replacing
 * truth (a successful durable revoke, or a fresh verified authority) is
 * already safely on disk. Throws when the marker removal cannot be
 * persisted — the in-memory marker stays so this process keeps failing
 * closed until a retry lands.
 */
function clearDeniedScopeDurably(scopeKey: string): void {
  const file = loadDeniedMarkers()
  if (!file.denied[scopeKey]) {
    deniedAuthorityScopes.delete(scopeKey)
    return
  }
  const records: DeniedAuthorityMarkerFile['denied'] = {}
  for (const [existingKey, existing] of Object.entries(file.denied)) {
    if (existingKey !== scopeKey) records[existingKey] = existing
  }
  const next: DeniedAuthorityMarkerFile = {
    schemaVersion: DENIED_MARKER_SCHEMA_VERSION,
    denied: records,
  }
  persistDeniedMarkers(next)
  deniedMarkerCache = next
  deniedAuthorityScopes.delete(scopeKey)
}

function authorityPath(): string {
  const configDir = process.env.POLO_AI_CONFIG_DIR || CONFIG_DIR
  return join(configDir, 'product-space-catalog-authority.json')
}

/** True when the scope carries a deny marker (durable or in-process). */
function isScopeDenied(scopeKey: string): boolean {
  if (deniedAuthorityScopes.has(scopeKey)) return true
  return Boolean(loadDeniedMarkers().denied[scopeKey])
}

export function productSpaceCatalogAuthorityKey(
  accountId: string,
  productSpaceId: string,
): string {
  return JSON.stringify(['product-space-catalog', 1, accountId, productSpaceId])
}

function emptyFile(): ProductSpaceCatalogAuthorityFile {
  return { schemaVersion: AUTHORITY_SCHEMA_VERSION, records: {} }
}

function sanitizeAuthorityRecord(
  record: unknown,
): ProductSpaceCatalogAuthorityRecord | null {
  if (!record || typeof record !== 'object') return null
  const candidate = record as Record<string, unknown>
  if (candidate.schemaVersion !== AUTHORITY_SCHEMA_VERSION) return null
  if (
    typeof candidate.accountId !== 'string' || !candidate.accountId
    || typeof candidate.productSpaceId !== 'string' || !candidate.productSpaceId
    || typeof candidate.syncedAt !== 'number'
    || typeof candidate.catalogRevision !== 'string'
    || !Array.isArray(candidate.entries)
    || !Array.isArray(candidate.tombstones)
  ) return null
  const entries = candidate.entries as unknown[]
  const tombstones = candidate.tombstones as unknown[]
  // Persisted caps are enforced on load: an over-cap record is dropped (the
  // next verified Catalog rebuilds the scope).
  if (entries.length > MAX_AUTHORITY_ENTRIES) return null
  if (tombstones.length > MAX_AUTHORITY_TOMBSTONES) return null
  if (!entries.every(isValidAuthorityEntry) || !tombstones.every(isValidAuthorityEntry)) {
    return null
  }
  return candidate as unknown as ProductSpaceCatalogAuthorityRecord
}

function loadFile(): ProductSpaceCatalogAuthorityFile {
  if (processCache) return processCache
  try {
    if (existsSync(authorityPath())) {
      const parsed = JSON.parse(readFileSync(authorityPath(), 'utf8')) as ProductSpaceCatalogAuthorityFile
      if (parsed?.schemaVersion === AUTHORITY_SCHEMA_VERSION && parsed.records) {
        // Records container is prototype-free: file-supplied keys such as
        // `__proto__` can never pollute object internals.
        const sanitized: ProductSpaceCatalogAuthorityFile = {
          schemaVersion: AUTHORITY_SCHEMA_VERSION,
          records: Object.create(null) as ProductSpaceCatalogAuthorityFile['records'],
        }
        for (const [key, record] of Object.entries(parsed.records)) {
          const valid = sanitizeAuthorityRecord(record)
          if (!valid) continue
          // Key-binding check: the OUTER storage key must be derived from
          // the record's OWN account/productSpace identity. A record stored
          // under a foreign key (persisted key/identity mismatch, or a
          // `__proto__`-shaped key) is dropped — a scope's trusted tuples
          // can never be borrowed by another scope.
          if (productSpaceCatalogAuthorityKey(valid.accountId, valid.productSpaceId) !== key) {
            continue
          }
          sanitized.records[key] = valid
        }
        processCache = sanitized
        return processCache
      }
    }
  } catch {
    // A damaged authority file is a loss of convenience, not of security:
    // withdrawn management fails closed until the next successful refresh.
  }
  processCache = emptyFile()
  return processCache
}

function saveFile(file: ProductSpaceCatalogAuthorityFile): void {
  processCache = file
  try {
    persistFileAtomic(file)
  } catch {
    // Persistence failure keeps the in-process record: withdrawn management
    // works for this session and is re-derived from the next fresh Catalog.
  }
}

/**
 * write-temp-then-rename persistence. Throws on ANY persistence failure —
 * callers that need durable-revocation semantics must observe the failure
 * and never treat the in-memory view as authoritative until this returned.
 */
function persistFileAtomic(file: ProductSpaceCatalogAuthorityFile): void {
  const path = authorityPath()
  mkdirSync(dirname(path), { recursive: true })
  const tempPath = `${path}.${process.pid}.tmp`
  writeFileSync(tempPath, JSON.stringify(file), 'utf8')
  renameSync(tempPath, path)
}

function stripToAuthorityEntry(
  rawEntry: Record<string, unknown>,
  overrides: Partial<ProductSpaceCatalogAuthorityEntry> = {},
): ProductSpaceCatalogAuthorityEntry | null {
  const entry = rawEntry as {
    kind?: unknown
    catalogEntryId?: unknown
    artifactInstanceId?: unknown
    version?: { versionId?: unknown; version?: unknown }
    name?: unknown
    description?: unknown
    iconUrl?: unknown
    availability?: unknown
    unavailableReason?: unknown
    sources?: unknown
    permissions?: unknown
  }
  if (
    entry.kind !== 'app'
    || typeof entry.catalogEntryId !== 'string' || !entry.catalogEntryId
    || typeof entry.artifactInstanceId !== 'string' || !entry.artifactInstanceId
    || !entry.version
    || typeof entry.version !== 'object'
    || typeof entry.version.versionId !== 'string' || !entry.version.versionId
    || typeof entry.version.version !== 'string' || !entry.version.version
    || typeof entry.name !== 'string' || !entry.name
  ) return null
  // Credential stripping: the Catalog DTO carries no download data, and the
  // version checksum (delivery-adjacent) is dropped here so the persisted
  // authority can explain and manage but never feed delivery.
  return {
    kind: 'app',
    catalogEntryId: entry.catalogEntryId,
    artifactInstanceId: entry.artifactInstanceId,
    versionId: entry.version.versionId,
    version: entry.version.version,
    name: entry.name,
    description: typeof entry.description === 'string' ? entry.description : '',
    ...(typeof entry.iconUrl === 'string' ? { iconUrl: entry.iconUrl } : {}),
    availability: entry.availability === 'available'
      || entry.availability === 'unavailable'
      || entry.availability === 'blocked'
      || entry.availability === 'withdrawn'
      ? entry.availability
      : 'unavailable',
    ...(typeof entry.unavailableReason === 'string'
      ? { unavailableReason: entry.unavailableReason }
      : {}),
    sources: Array.isArray(entry.sources)
      ? entry.sources.flatMap(source => {
          if (!source || typeof source !== 'object') return []
          const candidate = source as { kind?: unknown; name?: unknown; circleId?: unknown }
          if (typeof candidate.kind !== 'string' || typeof candidate.name !== 'string') return []
          return [{
            kind: candidate.kind,
            name: candidate.name,
            ...(typeof candidate.circleId === 'string' ? { circleId: candidate.circleId } : {}),
          }]
        })
      : [],
    permissions: Array.isArray(entry.permissions)
      ? entry.permissions.filter((permission): permission is string => typeof permission === 'string')
      : [],
    ...overrides,
  }
}

function stableEntryKey(
  catalogEntryId: string,
  artifactInstanceId: string,
): string {
  return JSON.stringify([catalogEntryId, artifactInstanceId])
}

function recordEntries(
  record: ProductSpaceCatalogAuthorityRecord,
  entries: ProductSpaceCatalogAuthorityEntry[],
): void {
  record.entries = entries.slice(0, MAX_AUTHORITY_ENTRIES)
}

/**
 * Records a freshly fetched Catalog into the authority and returns the
 * withdrawn tombstones that must be emitted alongside the live entries:
 * identities verified in the previous record that no longer appear in the
 * fresh Catalog. Existence is decided by the STABLE in-space identity
 * (catalogEntryId + artifactInstanceId) — a version upgrade replaces the
 * live entry and must never synthesize a tombstone. Re-appearing identities
 * clear their tombstone.
 */
export function recordProductSpaceCatalogAuthoritativeEntries(
  accountId: string,
  productSpaceId: string,
  catalogRevision: string,
  rawEntries: ReadonlyArray<Record<string, unknown>>,
): ProductSpaceCatalogAuthorityEntry[] {
  const file = loadFile()
  const key = productSpaceCatalogAuthorityKey(accountId, productSpaceId)
  // A denied scope has NO trustworthy previous authority: the stale record
  // behind the deny marker must never seed withdrawn tombstones — the fresh
  // Catalog alone defines the scope's truth.
  const denied = isScopeDenied(key)
  const previous = denied ? null : file.records[key] ?? null

  const freshEntries: ProductSpaceCatalogAuthorityEntry[] = []
  const freshKeys = new Set<string>()
  for (const rawEntry of rawEntries) {
    const entry = stripToAuthorityEntry(rawEntry)
    if (!entry) continue
    freshKeys.add(stableEntryKey(entry.catalogEntryId, entry.artifactInstanceId))
    freshEntries.push(entry)
  }

  const tombstones: ProductSpaceCatalogAuthorityEntry[] = []
  const tombstoneKeys = new Set<string>()
  if (previous) {
    const carry = (candidate: ProductSpaceCatalogAuthorityEntry): void => {
      if (tombstones.length >= MAX_AUTHORITY_TOMBSTONES) return
      const entryKey = stableEntryKey(candidate.catalogEntryId, candidate.artifactInstanceId)
      if (freshKeys.has(entryKey) || tombstoneKeys.has(entryKey)) return
      tombstoneKeys.add(entryKey)
      tombstones.push({ ...candidate, availability: 'withdrawn', withdrawnAt: Date.now() })
    }
    for (const entry of previous.entries) carry(entry)
    for (const tombstone of previous.tombstones) carry(tombstone)
  }

  const record: ProductSpaceCatalogAuthorityRecord = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    accountId,
    productSpaceId,
    syncedAt: Date.now(),
    catalogRevision,
    entries: [],
    tombstones,
  }
  recordEntries(record, freshEntries)
  file.records[key] = record
  if (denied) {
    // Recovery path: persist the fresh authority FIRST (errors propagate —
    // never swallow), and only clear the deny marker once the fresh record
    // is safely on disk. Until then the scope stays denied everywhere.
    const records: ProductSpaceCatalogAuthorityFile['records'] = Object.create(null)
    for (const [existingKey, existing] of Object.entries(file.records)) {
      records[existingKey] = existing
    }
    try {
      persistFileAtomic({ schemaVersion: AUTHORITY_SCHEMA_VERSION, records })
    } catch (error) {
      deniedAuthorityScopes.add(key)
      throw error
    }
    processCache = { schemaVersion: AUTHORITY_SCHEMA_VERSION, records }
    try {
      clearDeniedScopeDurably(key)
    } catch (error) {
      deniedAuthorityScopes.add(key)
      throw error
    }
    return tombstones
  }
  saveFile(file)
  return tombstones
}

/**
 * Exact identity tuple key: catalogEntryId + artifactInstanceId + versionId
 * + version. Authority checks are ALL-or-nothing on this full tuple — a
 * renderer-declared identity matches only when every field was recorded from
 * a verified Main-side Catalog fetch.
 */
export function productSpaceCatalogAuthorityTupleKey(
  catalogEntryId: string,
  artifactInstanceId: string,
  versionId: string,
  version: string,
): string {
  return JSON.stringify([catalogEntryId, artifactInstanceId, versionId, version])
}

/**
 * One-shot snapshot of the authority's full identity tuples for one account
 * and ProductSpace. Callers validate an entire request batch linearly
 * against this set (O(authority + requests)) instead of re-scanning the
 * record per item.
 */
export function loadProductSpaceCatalogAuthorityTupleSet(
  accountId: string,
  productSpaceId: string,
): Set<string> {
  const scopeKey = productSpaceCatalogAuthorityKey(accountId, productSpaceId)
  // A scope with a pending failed-revocation marker is denied: its tuples
  // fail closed even though the stale record may still sit on disk (or
  // reload from it) — across cache reloads AND process restarts.
  if (isScopeDenied(scopeKey)) return new Set()
  const record = loadFile().records[scopeKey] ?? null
  const tuples = new Set<string>()
  if (!record) return tuples
  for (const entry of record.entries) {
    tuples.add(productSpaceCatalogAuthorityTupleKey(
      entry.catalogEntryId,
      entry.artifactInstanceId,
      entry.versionId,
      entry.version,
    ))
  }
  for (const entry of record.tombstones) {
    tuples.add(productSpaceCatalogAuthorityTupleKey(
      entry.catalogEntryId,
      entry.artifactInstanceId,
      entry.versionId,
      entry.version,
    ))
  }
  return tuples
}

/** Exact full-tuple binding check (single identity). */
export function hasProductSpaceCatalogAuthorityTuple(
  accountId: string,
  productSpaceId: string,
  catalogEntryId: string,
  artifactInstanceId: string,
  versionId: string,
  version: string,
): boolean {
  return loadProductSpaceCatalogAuthorityTupleSet(accountId, productSpaceId)
    .has(productSpaceCatalogAuthorityTupleKey(
      catalogEntryId,
      artifactInstanceId,
      versionId,
      version,
    ))
}

export function getProductSpaceCatalogAuthorityRecord(
  accountId: string,
  productSpaceId: string,
): ProductSpaceCatalogAuthorityRecord | null {
  const scopeKey = productSpaceCatalogAuthorityKey(accountId, productSpaceId)
  if (isScopeDenied(scopeKey)) return null
  return loadFile().records[scopeKey] ?? null
}

/**
 * Revokes ALL recorded authority for one account and ProductSpace (Catalog
 * identities AND tombstones): after a catalog-scope denial the trusted
 * record for that space must not survive — installs/opens/uninstalls and
 * launch resolution all fail closed until a fresh verified Catalog lands.
 * Other accounts and spaces are untouched.
 *
 * DURABLE semantics: the in-memory cache adopts the revoked state ONLY
 * after the write-temp-then-rename persistence SUCCEEDED. On a persistence
 * failure this function throws to the caller AND leaves a precise-scope
 * in-process deny marker, so the denied scope fails closed immediately even
 * though the stale record may still sit on disk — and a later revoke for
 * the same scope RETRIES the durable deletion instead of early-returning.
 */
export function revokeProductSpaceCatalogAuthority(
  accountId: string,
  productSpaceId: string,
): void {
  const key = productSpaceCatalogAuthorityKey(accountId, productSpaceId)
  const file = loadFile()
  if (!(key in file.records)) {
    // Nothing recorded — but a marker from an earlier failed revoke (this
    // process or a previous one) means the durable deletion + marker removal
    // must still be retried.
    if (!isScopeDenied(key)) return
  }
  const records: ProductSpaceCatalogAuthorityFile['records'] = Object.create(null)
  for (const [recordKey, record] of Object.entries(file.records)) {
    if (recordKey !== key) records[recordKey] = record
  }
  const next: ProductSpaceCatalogAuthorityFile = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    records,
  }
  try {
    persistFileAtomic(next)
  } catch (error) {
    // The stale on-disk record survived: fail the scope closed durably and
    // propagate — the caller must never treat this revoke as done.
    try {
      denyScopeDurably(key, { accountId, productSpaceId, deniedAt: Date.now() })
    } catch {
      // The marker could not be persisted either; the in-memory marker set
      // by denyScopeDurably still fails THIS process closed.
    }
    throw error
  }
  // The authority deletion is durable: commit the normal cache, then remove
  // the deny marker durably (the marker-clear failure propagates so the
  // caller knows the scope is not yet clean across restarts).
  processCache = next
  clearDeniedScopeDurably(key)
}

/**
 * Test-only: drops the process cache WITHOUT clearing deny markers,
 * simulating a same-process reload path — a scope with a pending
 * failed-revocation marker must still read as denied even when the stale
 * record reloads from disk.
 */
export function __dropAuthorityProcessCacheForTests(): void {
  processCache = null
}

export function resetProductSpaceCatalogAuthorityForTests(): void {
  processCache = null
  deniedMarkerCache = null
  deniedAuthorityScopes.clear()
  try {
    if (existsSync(authorityPath())) unlinkSync(authorityPath())
  } catch {
    // Best-effort test cleanup.
  }
  try {
    if (existsSync(deniedMarkerPath())) unlinkSync(deniedMarkerPath())
  } catch {
    // Best-effort test cleanup.
  }
}

export const PRODUCT_SPACE_CATALOG_AUTHORITY_SCHEMA_VERSION = AUTHORITY_SCHEMA_VERSION
