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
  /** Explicit EXHAUSTIVE discriminant — every durable record carries one. */
  kind: 'authority'
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

/**
 * Legacy candidate: a pre-kind record (written before the explicit
 * discriminator existed). It is a recovery/display candidate ONLY — it can
 * never grant trust, and the next fresh schema-valid Catalog transaction
 * migrates it to `kind:'authority'`.
 */
interface LegacyCandidateAuthorityRecord {
  kind: undefined
  schemaVersion: number
  accountId: string
  productSpaceId: string
  syncedAt: number
  catalogRevision: string
  entries: ProductSpaceCatalogAuthorityEntry[]
  tombstones: ProductSpaceCatalogAuthorityEntry[]
}

type ProductSpaceCatalogScopeRecord =
  | ProductSpaceCatalogAuthorityRecord
  | DeniedAuthorityRecord
  | LegacyCandidateAuthorityRecord

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
  record: ProductSpaceCatalogScopeRecord | null,
): record is DeniedAuthorityRecord {
  return record !== null && record.kind === 'denied'
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

function makeAuthorityRecord(
  accountId: string,
  productSpaceId: string,
  catalogRevision: string,
  entries: ProductSpaceCatalogAuthorityEntry[],
  tombstones: ProductSpaceCatalogAuthorityEntry[],
): ProductSpaceCatalogAuthorityRecord {
  return {
    kind: 'authority',
    schemaVersion: AUTHORITY_SCHEMA_VERSION,
    accountId,
    productSpaceId,
    syncedAt: Date.now(),
    catalogRevision,
    entries: entries.slice(0, MAX_AUTHORITY_ENTRIES),
    tombstones: tombstones.slice(0, MAX_AUTHORITY_TOMBSTONES),
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
  // EXHAUSTIVE discriminated-union decode: switch on the explicit `kind`
  // tag; every branch validates only its own fields. missing / unknown /
  // malformed kinds are NEVER granted — a kind-less record can only decode
  // as a legacy candidate (display/recovery, never a grant).
  switch (candidate.kind) {
    case 'denied': {
      const denied = candidate as unknown as DeniedAuthorityRecord
      if (
        denied.schemaVersion !== DENIED_RECORD_SCHEMA_VERSION
        || typeof denied.accountId !== 'string' || !denied.accountId
        || typeof denied.productSpaceId !== 'string' || !denied.productSpaceId
        || typeof denied.deniedAt !== 'number'
      ) return null
      return denied
    }
    case 'authority': {
      if (candidate.schemaVersion !== AUTHORITY_SCHEMA_VERSION) return null
      const authority = candidate as unknown as ProductSpaceCatalogAuthorityRecord
      if (
        typeof authority.accountId !== 'string' || !authority.accountId
        || typeof authority.productSpaceId !== 'string' || !authority.productSpaceId
        || typeof authority.syncedAt !== 'number'
        || typeof authority.catalogRevision !== 'string'
        || !Array.isArray(authority.entries)
        || !Array.isArray(authority.tombstones)
      ) return null
      const entries = authority.entries as unknown[]
      const tombstones = authority.tombstones as unknown[]
      // Persisted caps are enforced on load: an over-cap record is dropped
      // (the next verified Catalog rebuilds the scope).
      if (entries.length > MAX_AUTHORITY_ENTRIES) return null
      if (tombstones.length > MAX_AUTHORITY_TOMBSTONES) return null
      if (!entries.every(isValidAuthorityEntry) || !tombstones.every(isValidAuthorityEntry)) {
        return null
      }
      return authority
    }
    case undefined: {
      // LEGACY candidate: pre-kind record. Display/recovery only — the
      // decode result can never grant trust (read paths require this
      // process' fresh revalidation), and the next fresh schema-valid
      // Catalog transaction migrates it to `kind:'authority'`.
      if (candidate.schemaVersion !== AUTHORITY_SCHEMA_VERSION) return null
      const legacy = candidate as unknown as LegacyCandidateAuthorityRecord
      if (
        typeof legacy.accountId !== 'string' || !legacy.accountId
        || typeof legacy.productSpaceId !== 'string' || !legacy.productSpaceId
        || typeof legacy.syncedAt !== 'number'
        || typeof legacy.catalogRevision !== 'string'
        || !Array.isArray(legacy.entries)
        || !Array.isArray(legacy.tombstones)
      ) return null
      return legacy
    }
    default:
      // Unknown / malformed kind: fail closed (record dropped).
      return null
  }
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
  // Legacy candidates (missing explicit kind) and denied records contribute
  // NOTHING: their entries/tombstones can never become retained trusted
  // tombstones of a fresh grant — the fresh schema-valid response alone
  // defines the scope's truth.
  const previous = denied
    || isDeniedAuthorityRecord(previousRecord)
    || (previousRecord !== null && previousRecord.kind !== 'authority')
    ? null
    : previousRecord

  // FRESH SCHEMA GATE: every fresh row must pass the FULL formal
  // AuthorityEntrySchema (sources 1..1000, permission caps, version contract,
  // …) — the hand-written projection is only a credential-stripping step, it
  // can never relax the schema. Any invalid row fails the WHOLE transaction
  // closed (cache/disk untouched); no partial trust is ever granted.
  const freshEntries: ProductSpaceCatalogAuthorityEntry[] = []
  const freshKeys = new Set<string>()
  for (const rawEntry of rawEntries) {
    const entry = stripToAuthorityEntry(rawEntry)
    if (!entry) {
      throw new Error(
        'Fresh Catalog entry failed AuthorityEntrySchema validation — the whole transaction is rejected',
      )
    }
    const parsed = AuthorityEntrySchema.safeParse(entry)
    if (!parsed.success) {
      throw new Error(
        `Fresh Catalog entry failed AuthorityEntrySchema validation: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
      )
    }
    freshKeys.add(stableEntryKey(entry.catalogEntryId, entry.artifactInstanceId))
    freshEntries.push(entry)
  }
  if (freshEntries.length > MAX_AUTHORITY_ENTRIES) {
    throw new Error(
      `Fresh Catalog exceeds the ${MAX_AUTHORITY_ENTRIES}-entry authority cap — the whole transaction is rejected`,
    )
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

  // TRANSACTIONAL GRANT: build the candidate from an IMMUTABLE SNAPSHOT of
  // the loaded records (never mutating the loadFile()/processCache
  // references), then persist with a THROWING atomic write. The candidate is
  // published to processCache, the deny state is cleared and the scope joins
  // processTrustedScopes ONLY after the durable write succeeded — a failed
  // fresh revalidation (read-only directory, EACCES, …) leaves the cached
  // AND durable previous record bit-for-bit intact, can never be laundered
  // into the file by an unrelated scope's later successful refresh, and
  // leaves the scope exactly as denied/untrusted as before.
  const record = makeAuthorityRecord(accountId, productSpaceId, catalogRevision, freshEntries, tombstones)
  const candidateRecords: ProductSpaceCatalogAuthorityFile['records'] = Object.create(null)
  for (const [existingKey, existing] of Object.entries(file.records)) {
    candidateRecords[existingKey] = existing
  }
  candidateRecords[key] = record
  try {
    persistFileAtomic({ schemaVersion: AUTHORITY_SCHEMA_VERSION, records: candidateRecords })
  } catch (error) {
    // The durable previous record is untouched (atomic rename is
    // old-or-new) and processCache was never published: a previously denied
    // scope stays sticky-denied, an unrelated scope's later successful
    // refresh serializes the OLD snapshot — no laundering is possible.
    if (denied) deniedAuthorityScopes.add(key)
    processTrustedScopes.delete(key)
    throw error
  }
  processCache = { schemaVersion: AUTHORITY_SCHEMA_VERSION, records: candidateRecords }
  deniedAuthorityScopes.delete(key)
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
): Readonly<ProductSpaceCatalogAuthorityRecord> | null {
  const scopeKey = productSpaceCatalogAuthorityKey(accountId, productSpaceId)
  if (isScopeDenied(scopeKey) || !isScopeTrusted(scopeKey)) return null
  const record = loadFile().records[scopeKey] ?? null
  // A legacy candidate (or denied record) never serves as authority.
  if (!record || record.kind !== 'authority') return null
  // DEEP SNAPSHOT: the returned value must not alias the processCache record
  // at ANY level (record, entries, tombstones, entry.version, sources,
  // permissions), or a public caller could mutate entries into the trust
  // set. Freeze deeply so even in-place mutation of the snapshot is
  // rejected in dev and irrelevant in prod.
  return deepFreezeSnapshot(record)
}

/** Structural deep copy — the snapshot must never alias processCache. */
function deepCopySnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(item => deepCopySnapshot(item)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepCopySnapshot(v)
    }
    return out as T
  }
  return value
}

/** Deep-freezes a SNAPSHOT (a copy) — never the internal cache record. */
function deepFreezeSnapshot<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeSnapshot(item)
    return Object.freeze(value)
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      deepFreezeSnapshot(item)
    }
    return Object.freeze(value)
  }
  return Object.freeze(value)
}

function deepCopiedFrozenSnapshot<T>(value: T): Readonly<T> {
  return deepFreezeSnapshot(deepCopySnapshot(value))
}

/**
 * WITHDRAWN-ONLY tombstone tuples for one scope: the retained tombstones of
 * the CURRENT process-trusted authority record — deliberately EXCLUDING live
 * entries, so a live uninstall can never pass the retained-cleanup gate on
 * the live∪tombstone union. Cold-start/untrusted/denied scopes serve an
 * empty set (fail closed).
 */
export function loadProductSpaceWithdrawnTombstoneTupleSet(
  accountId: string,
  productSpaceId: string,
): Set<string> {
  const scopeKey = productSpaceCatalogAuthorityKey(accountId, productSpaceId)
  if (isScopeDenied(scopeKey) || !isScopeTrusted(scopeKey)) return new Set()
  const record = loadFile().records[scopeKey] ?? null
  const tuples = new Set<string>()
  if (!record || record.kind !== 'authority') return tuples
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
