import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { CONFIG_DIR } from '@polo-ai/shared/config/paths'

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

function authorityPath(): string {
  const configDir = process.env.POLO_AI_CONFIG_DIR || CONFIG_DIR
  return join(configDir, 'product-space-catalog-authority.json')
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

const AUTHORITY_AVAILABILITY = new Set(['available', 'unavailable', 'blocked', 'withdrawn'])
const AUTHORITY_UNAVAILABLE_REASONS = new Set([
  'authorization_ended', 'space_restricted', 'version_unavailable', 'version_blocked',
])
const AUTHORITY_SOURCE_KINDS = new Set(['polo', 'creator_circle', 'enterprise_import'])
const MAX_AUTHORITY_ENTRY_SOURCES = 1_000
const MAX_AUTHORITY_ENTRY_PERMISSIONS = 1_000

/**
 * FULL authority DTO validation (mirror of the ProductSpace Catalog entry
 * contract, post-credential-strip): every field's type, enum, discriminant,
 * and array membership is checked — a syntactically-valid JSON entry with a
 * malformed field is never treated as a trusted record.
 */
function isValidAuthorityEntry(entry: unknown): entry is ProductSpaceCatalogAuthorityEntry {
  if (!entry || typeof entry !== 'object') return false
  const candidate = entry as Record<string, unknown>
  if (candidate.kind !== 'app') return false
  if (typeof candidate.catalogEntryId !== 'string' || candidate.catalogEntryId === '') return false
  if (typeof candidate.artifactInstanceId !== 'string' || candidate.artifactInstanceId === '') return false
  if (typeof candidate.versionId !== 'string' || candidate.versionId === '') return false
  if (typeof candidate.version !== 'string' || candidate.version === '') return false
  if (typeof candidate.name !== 'string' || candidate.name === '') return false
  if (typeof candidate.description !== 'string') return false
  if (typeof candidate.availability !== 'string' || !AUTHORITY_AVAILABILITY.has(candidate.availability)) return false
  if (
    candidate.unavailableReason !== undefined
    && (typeof candidate.unavailableReason !== 'string'
      || !AUTHORITY_UNAVAILABLE_REASONS.has(candidate.unavailableReason))
  ) return false
  if (
    candidate.iconUrl !== undefined
    && typeof candidate.iconUrl !== 'string'
  ) return false
  if (!Array.isArray(candidate.sources) || candidate.sources.length > MAX_AUTHORITY_ENTRY_SOURCES) return false
  for (const source of candidate.sources) {
    if (!source || typeof source !== 'object') return false
    const candidateSource = source as Record<string, unknown>
    if (typeof candidateSource.kind !== 'string' || !AUTHORITY_SOURCE_KINDS.has(candidateSource.kind)) return false
    if (typeof candidateSource.name !== 'string' || candidateSource.name === '') return false
    if (
      candidateSource.circleId !== undefined
      && (typeof candidateSource.circleId !== 'string' || candidateSource.circleId === '')
    ) return false
  }
  if (
    !Array.isArray(candidate.permissions)
    || candidate.permissions.length > MAX_AUTHORITY_ENTRY_PERMISSIONS
    || !candidate.permissions.every(permission => typeof permission === 'string')
  ) return false
  if (
    candidate.withdrawnAt !== undefined
    && typeof candidate.withdrawnAt !== 'number'
  ) return false
  return true
}

/**
 * Per-record validation on load: a syntactically-valid but malformed record
 * (missing arrays, malformed entries) is DROPPED — withdrawn management for
 * that scope fails closed, and the next verified Catalog fetch rebuilds the
 * scope from scratch (self-healing) instead of crashing tuple reads or
 * carry-forward.
 */
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
        const sanitized: ProductSpaceCatalogAuthorityFile = {
          schemaVersion: AUTHORITY_SCHEMA_VERSION,
          records: {},
        }
        for (const [key, record] of Object.entries(parsed.records)) {
          const valid = sanitizeAuthorityRecord(record)
          if (valid) sanitized.records[key] = valid
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
    const path = authorityPath()
    mkdirSync(dirname(path), { recursive: true })
    const tempPath = `${path}.${process.pid}.tmp`
    writeFileSync(tempPath, JSON.stringify(file), 'utf8')
    renameSync(tempPath, path)
  } catch {
    // Persistence failure keeps the in-process record: withdrawn management
    // works for this session and is re-derived from the next fresh Catalog.
  }
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
  const previous = file.records[key] ?? null

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
  const record = loadFile().records[productSpaceCatalogAuthorityKey(accountId, productSpaceId)] ?? null
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
  return loadFile().records[productSpaceCatalogAuthorityKey(accountId, productSpaceId)] ?? null
}

export function resetProductSpaceCatalogAuthorityForTests(): void {
  processCache = null
  try {
    if (existsSync(authorityPath())) unlinkSync(authorityPath())
  } catch {
    // Best-effort test cleanup.
  }
}

export const PRODUCT_SPACE_CATALOG_AUTHORITY_SCHEMA_VERSION = AUTHORITY_SCHEMA_VERSION
