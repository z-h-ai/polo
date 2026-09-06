import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

/**
 * A durable per-scope DENY record (failed revocation). It lives in the
 * authority file itself — the revocation is ONE atomic write — and is never
 * a trusted authority: reads for the scope fail closed and a fresh verified
 * Catalog replaces it.
 */
interface DeniedAuthorityRecord {
  schemaVersion: number
  kind: 'denied'
  accountId: string
  productSpaceId: string
  deniedAt: number
}

type ProductSpaceCatalogScopeRecord =
  | ProductSpaceCatalogAuthorityRecord
  | DeniedAuthorityRecord

interface ProductSpaceCatalogAuthorityFile {
  schemaVersion: number
  records: Record<string, ProductSpaceCatalogScopeRecord>
}

let processCache: ProductSpaceCatalogAuthorityFile | null = null

/**
 * DURABLE TRUST MODEL (cold-start default-distrust).
 *
 * The persisted authority file is a RECOVERY CANDIDATE / display cache — it
 * can NEVER grant authority to a new process. A scope enters THIS process'
 * trusted state only through a fresh server revalidation
 * (`recordProductSpaceCatalogAuthoritativeEntries`, called exclusively from
 * the verified-Catalog commit zone) in the SAME process:
 *
 * - `processTrustedScopes` holds the scopes revalidated in this process;
 * - `deniedAuthorityScopes` holds scopes whose revocation failed (or whose
 *   durable record on disk is a `denied` record) — sticky until a fresh
 *   revalidation replaces them.
 *
 * Consequences that make restart fail-closed PROVABLE even under a total
 * write failure domain (read-only directory: temp write AND unlink both
 * fail, old file stays readable):
 *
 * - a FAILED revocation mutates only this process' denial state and
 *   propagates its error — the on-disk file may remain untouched, but any
 *   NEW process starts with an EMPTY trusted set and therefore denies every
 *   scope until it revalidates; the stale record is a candidate, never a
 *   grant;
 * - unrelated scopes are never deleted or revoked by another scope's
 *   failure (no unlink fallback exists);
 * - a durable `kind:'denied'` record (written when the directory IS
 *   writable) additionally sticks the denial across restarts until a fresh
 *   revalidation replaces it;
 * - offline/withdrawn behavior follows the same rule: before the fresh
 *   revalidation the scope reads as empty (installs/opens/uninstalls and
 *   withdrawn management fail closed); after it, the freshly recorded
 *   entries and withdrawn tombstones serve again.
 *
 * A damaged authority file (unreadable / malformed / invalid schema /
 * unknown record kind) remains a GLOBAL fail-closed: the file cannot be
 * decoded into any trust.
 */
/** In-process sticky denial (failed revocation or durable denied record). */
const deniedAuthorityScopes = new Set<string>()
/** Scopes freshly revalidated in THIS process (the only grants). */
const processTrustedScopes = new Set<string>()

const DENIED_RECORD_SCHEMA_VERSION = 1

function isDeniedAuthorityRecord(
  record: ProductSpaceCatalogAuthorityRecord | DeniedAuthorityRecord | null,
): record is DeniedAuthorityRecord {
  return record !== null && (record as { kind?: unknown }).kind === 'denied'
}

function makeDeniedRecord(
  accountId: string,
  productSpaceId: string,
): DeniedAuthorityRecord {
  return {
    schemaVersion: DENIED_RECORD_SCHEMA_VERSION,
    kind: 'denied',
    accountId,
    productSpaceId,
    deniedAt: Date.now(),
  }
}

function authorityPath(): string {
  const configDir = process.env.POLO_AI_CONFIG_DIR || CONFIG_DIR
  return join(configDir, 'product-space-catalog-authority.json')
}

/** True when the scope carries a deny marker (durable or in-process). */
function isScopeDenied(scopeKey: string): boolean {
  if (deniedAuthorityScopes.has(scopeKey)) return true
  return isDeniedAuthorityRecord(loadFile().records[scopeKey] ?? null)
}

/**
 * Cold-start rule: ONLY a scope freshly revalidated in THIS process may
 * serve authority. The persisted file is a recovery candidate, never a
 * grant.
 */
function isScopeTrusted(scopeKey: string): boolean {
  return processTrustedScopes.has(scopeKey) && !isScopeDenied(scopeKey)
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
): ProductSpaceCatalogScopeRecord | null {
  if (!record || typeof record !== 'object') return null
  const candidate = record as Record<string, unknown>
  // TRUE discriminated union: `kind` is decoded FIRST and each branch
  // validates only its own fields — a denied record does NOT require the
  // authority-only fields (syncedAt/catalogRevision/entries/tombstones) and
  // an authority record must not be mistaken for a denial.
  if (candidate.kind === 'denied') {
    const denied = candidate as unknown as DeniedAuthorityRecord
    if (
      denied.schemaVersion !== DENIED_RECORD_SCHEMA_VERSION
      || typeof denied.accountId !== 'string' || !denied.accountId
      || typeof denied.productSpaceId !== 'string' || !denied.productSpaceId
      || typeof denied.deniedAt !== 'number'
    ) return null
    return denied
  }
  if (candidate.kind !== undefined) return null
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
  try {
    writeFileSync(tempPath, JSON.stringify(file), 'utf8')
    renameSync(tempPath, path)
  } catch (error) {
    // Never leak the temp file: a leftover would make an unrelated later
    // write fail with EEXIST (its own failure domain must stay clean).
    try {
      unlinkSync(tempPath)
    } catch {}
    throw error
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
  // A denied scope has NO trustworthy previous authority: the stale record
  // behind the deny marker must never seed withdrawn tombstones — the fresh
  // Catalog alone defines the scope's truth.
  const denied = isScopeDenied(key)
  const previousRecord = file.records[key] ?? null
  const previous = denied || isDeniedAuthorityRecord(previousRecord)
    ? null
    : previousRecord

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
    // Denied-recovery path: the fresh verified Catalog replaces the denied
    // record with a THROWING atomic persist. A read-only directory (or any
    // persistence failure) propagates and the scope stays denied/untrusted
    // in this process — the denial is only cleared AFTER the fresh record
    // is durably on disk.
    const records: ProductSpaceCatalogAuthorityFile['records'] = Object.create(null)
    for (const [existingKey, existing] of Object.entries(file.records)) {
      records[existingKey] = existing
    }
    try {
      persistFileAtomic({ schemaVersion: AUTHORITY_SCHEMA_VERSION, records })
    } catch (error) {
      deniedAuthorityScopes.add(key)
      processTrustedScopes.delete(key)
      throw error
    }
    processCache = { schemaVersion: AUTHORITY_SCHEMA_VERSION, records }
    deniedAuthorityScopes.delete(key)
    processTrustedScopes.add(key)
    return tombstones
  }
  saveFile(file)
  // Fresh server revalidation in THIS process is the only grant.
  processTrustedScopes.add(key)
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
  // Denied scopes fail closed; every other scope fails closed too until
  // THIS process revalidated it (the persisted file is a candidate, never a
  // grant — cold-start default-distrust).
  if (isScopeDenied(scopeKey) || !isScopeTrusted(scopeKey)) return new Set()
  const record = loadFile().records[scopeKey] ?? null
  const tuples = new Set<string>()
  if (!record || isDeniedAuthorityRecord(record)) return tuples
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
  if (isScopeDenied(scopeKey) || !isScopeTrusted(scopeKey)) return null
  const record = loadFile().records[scopeKey] ?? null
  return record && !isDeniedAuthorityRecord(record) ? record : null
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
  const existing = file.records[key] ?? null
  if (existing === null || isDeniedAuthorityRecord(existing)) {
    // Nothing recorded — but a marker from an earlier failed revoke (this
    // process or a previous one) means the durable denial write must still
    // be retried.
    if (!deniedAuthorityScopes.has(key)) return
  }
  // The revocation is ONE atomic write: the scope's record is replaced by a
  // `denied` record (the durable denial marker lives in the SAME file as the
  // authority it denies — no second write can fail independently).
  const records: ProductSpaceCatalogAuthorityFile['records'] = Object.create(null)
  for (const [recordKey, record] of Object.entries(file.records)) {
    records[recordKey] = record
  }
  records[key] = makeDeniedRecord(accountId, productSpaceId)
  const next: ProductSpaceCatalogAuthorityFile = {
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    records,
  }
  try {
    persistFileAtomic(next)
  } catch (error) {
    // The denial could not be made durable and the on-disk state is
    // unchanged (atomic rename is old-or-new). That is acceptable under the
    // cold-start model: EVERY new process starts with an empty trusted set,
    // so the stale record is a candidate that can never become a grant
    // without a fresh server revalidation. This process is failed closed
    // via the sticky in-process marker; the error propagates. Unrelated
    // scopes are never touched (no unlink fallback exists).
    deniedAuthorityScopes.add(key)
    processTrustedScopes.delete(key)
    throw error
  }
  processCache = next
  deniedAuthorityScopes.add(key)
  processTrustedScopes.delete(key)
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
  deniedAuthorityScopes.clear()
  processTrustedScopes.clear()
  try {
    if (existsSync(authorityPath())) rmSync(authorityPath(), { recursive: true, force: true })
  } catch {
    // Best-effort test cleanup.
  }
}

export const PRODUCT_SPACE_CATALOG_AUTHORITY_SCHEMA_VERSION = AUTHORITY_SCHEMA_VERSION
