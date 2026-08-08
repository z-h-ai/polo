import { createHash } from 'node:crypto'
import { strToU8, unzipSync, zipSync } from 'fflate'
import type { LocalAppRuntimeKind, PoloAppManifest } from '../protocol/local-apps.ts'
import { validatePoloAppManifestContract } from '../protocol/local-app-manifest.ts'
import {
  CREATOR_APP_CANONICAL_ENTRIES,
  CREATOR_APP_PAYLOAD_LIMITS,
} from './creator-app-publishing.constants.ts'

export {
  CREATOR_APP_CANONICAL_ENTRIES,
  CREATOR_APP_PAYLOAD_LIMITS,
  CREATOR_APP_PAYLOAD_MAX_BYTES,
} from './creator-app-publishing.constants.ts'

export type CreatorAppPublishMode = 'website' | 'upload'
export type CreatorAppVisibility = 'all_members'

export interface CreatorAppPayloadEntry {
  path: string
  type?: 'file' | 'directory' | 'symlink'
  /** Decoded text is used for deterministic runtime detection. */
  content?: string
  /** Raw payload bytes are preserved when creating the final ZIP. */
  bytes?: Uint8Array
}

export interface CreatorAppEntryCandidate {
  runtime: LocalAppRuntimeKind
  path: string
}

export type CreatorAppPayloadAnalysis =
  | { status: 'ready'; candidate: CreatorAppEntryCandidate; legacyHint?: CreatorAppEntryCandidate }
  | { status: 'needs_entry_selection'; candidates: CreatorAppEntryCandidate[]; legacyHint?: CreatorAppEntryCandidate }
  | { status: 'invalid'; code: 'missing_runnable_payload' | 'ambiguous_runtime' | 'unsafe_archive' | 'invalid_legacy_permissions'; message: string }

export interface CanonicalCreatorAppBundle {
  entries: Array<NormalizedCreatorAppPayloadEntry>
  manifest: PoloAppManifest
  checksum: string
  sizeBytes: number
  archive: Uint8Array
}

export interface NormalizedCreatorAppPayloadEntry {
  path: string
  type: 'file' | 'directory' | 'symlink'
  content: string
  bytes: Uint8Array
}

const PYTHON_LOCK_FILES = new Set(['uv.lock'])
const JS_LOCK_FILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'])
const NESTED_ARCHIVE = /\.(?:zip|tar|tgz|gz)$/i

function safePath(value: string): string | null {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (
    !normalized
    || normalized.includes('\0')
    || normalized.startsWith('/')
    || /^[A-Za-z]:\//.test(normalized)
    || normalized.split('/').includes('..')
  ) return null
  return normalized
}

function isRootFile(path: string, names: readonly string[]): boolean {
  return !path.includes('/') && names.includes(path.toLowerCase())
}

function hasDynamicRuntimeEvidence(entry: NormalizedCreatorAppPayloadEntry): boolean {
  return [
    'HOST',
    'PORT',
    '/health',
    'POLO_APP_HEALTH_TOKEN',
    'X-Polo-App-Health-Token',
  ].every(marker => entry.content.includes(marker))
}

function legacyCandidate(entries: readonly NormalizedCreatorAppPayloadEntry[]): CreatorAppEntryCandidate | undefined {
  const manifest = entries.find(entry => entry.path === 'polo-app.json')
  if (!manifest?.content) return undefined
  try {
    const raw = JSON.parse(manifest.content) as Record<string, unknown>
    const runtime = raw.runtime
    const entry = raw.entry
    if (
      (runtime === 'static' || runtime === 'python' || runtime === 'js')
      && Array.isArray(entry)
      && typeof entry[0] === 'string'
    ) {
      const path = safePath(entry[0])
      if (path && entries.some(item => item.path === path && item.type === 'file')) {
        return { runtime, path }
      }
    }
  } catch {
    // A legacy manifest is a hint only. Its parse error must not mask a valid payload.
  }
  return undefined
}

function hasInvalidLegacyPermissions(entries: readonly NormalizedCreatorAppPayloadEntry[]): boolean {
  const manifest = entries.find(entry => entry.path === 'polo-app.json')
  if (!manifest?.content) return false
  try {
    const raw = JSON.parse(manifest.content) as Record<string, unknown>
    return raw.permissions !== undefined && (!Array.isArray(raw.permissions) || raw.permissions.length !== 0)
  } catch { return false }
}

/**
 * Server-side ingress contract. It is intentionally pure: callers inspect
 * uploaded bytes but never execute a build command or application code.
 */
export function analyzeCreatorAppPayload(
  input: readonly CreatorAppPayloadEntry[],
): CreatorAppPayloadAnalysis {
  const seen = new Set<string>()
  const entries: NormalizedCreatorAppPayloadEntry[] = []
  for (const entry of input) {
    const path = safePath(entry.path)
    if (!path || entry.type === 'symlink' || NESTED_ARCHIVE.test(path)) {
      return { status: 'invalid', code: 'unsafe_archive', message: 'The upload contains an unsafe archive entry.' }
    }
    const key = path.toLocaleLowerCase('en-US')
    if (seen.has(key)) {
      return { status: 'invalid', code: 'unsafe_archive', message: 'The upload contains duplicate file paths.' }
    }
    seen.add(key)
    const bytes = entry.bytes ?? strToU8(entry.content ?? '')
    entries.push({
      path,
      type: entry.type ?? 'file',
      content: entry.content ?? new TextDecoder().decode(bytes),
      bytes,
    })
  }

  const files = entries.filter(entry => entry.type === 'file')
  if (hasInvalidLegacyPermissions(entries)) {
    return { status: 'invalid', code: 'invalid_legacy_permissions', message: 'This legacy Bundle requests unsupported permissions.' }
  }
  const paths = new Set(files.map(entry => entry.path))
  const legacyHint = legacyCandidate(entries)
  const canonicalCandidates: CreatorAppEntryCandidate[] = []
  const legacyCandidates: CreatorAppEntryCandidate[] = []

  if (paths.has(CREATOR_APP_CANONICAL_ENTRIES.static)) {
    canonicalCandidates.push({ runtime: 'static', path: CREATOR_APP_CANONICAL_ENTRIES.static })
  }

  const hasLock = (names: ReadonlySet<string>) => files.some(entry => {
    if (entry.path.includes('/') || !names.has(entry.path.toLowerCase())) return false
    return entry.bytes.byteLength > 0 && entry.content.trim().length > 0
  })
  const hasPythonLock = hasLock(PYTHON_LOCK_FILES)
  const hasPyproject = files.some(entry => entry.path === 'pyproject.toml' && entry.content.trim().length > 0)
  const hasPackageJson = files.some(entry => entry.path === 'package.json' && entry.content.trim().length > 0)
  const hasJsLock = hasLock(JS_LOCK_FILES)

  const canonicalPython = files.find(entry => entry.path === CREATOR_APP_CANONICAL_ENTRIES.python)
  if (canonicalPython && hasPythonLock && hasPyproject && hasDynamicRuntimeEvidence(canonicalPython)) {
    canonicalCandidates.push({ runtime: 'python', path: CREATOR_APP_CANONICAL_ENTRIES.python })
  }
  const canonicalJavaScript = files.find(entry => entry.path === CREATOR_APP_CANONICAL_ENTRIES.js)
  if (canonicalJavaScript && hasJsLock && hasPackageJson && hasDynamicRuntimeEvidence(canonicalJavaScript)) {
    canonicalCandidates.push({ runtime: 'js', path: CREATOR_APP_CANONICAL_ENTRIES.js })
  }

  for (const entry of files) {
    if (isRootFile(entry.path, ['main.py', 'app.py', 'server.py', 'wsgi.py']) && hasPythonLock && hasPyproject && hasDynamicRuntimeEvidence(entry)) {
      legacyCandidates.push({ runtime: 'python', path: entry.path })
    }
    if (
      ((isRootFile(entry.path, ['server.js', 'server.mjs', 'index.js', 'index.mjs'])
        || entry.path === '.next/standalone/server.js') && hasJsLock && hasPackageJson)
      && hasDynamicRuntimeEvidence(entry)
    ) {
      legacyCandidates.push({ runtime: 'js', path: entry.path })
    }
  }

  const detectedCandidates = canonicalCandidates.length > 0 ? canonicalCandidates : legacyCandidates
  const uniqueCandidates = [...new Map(detectedCandidates.map(candidate => [
    `${candidate.runtime}\0${candidate.path}`,
    candidate,
  ])).values()].sort((left, right) => left.path.localeCompare(right.path))
  if (uniqueCandidates.length === 0 && legacyHint) uniqueCandidates.push(legacyHint)
  if (uniqueCandidates.length === 0) {
    return {
      status: 'invalid',
      code: 'missing_runnable_payload',
      message: 'This upload does not contain a runnable App. Build it locally with POL-65, then upload the generated payload.',
    }
  }
  if (new Set(uniqueCandidates.map(candidate => candidate.runtime)).size > 1) {
    return {
      status: 'invalid',
      code: 'ambiguous_runtime',
      message: 'This upload contains more than one runnable App runtime. Upload one canonical App payload.',
    }
  }
  if (uniqueCandidates.length > 1) {
    return { status: 'needs_entry_selection', candidates: uniqueCandidates, ...(legacyHint ? { legacyHint } : {}) }
  }
  return { status: 'ready', candidate: uniqueCandidates[0]!, ...(legacyHint ? { legacyHint } : {}) }
}

export function createPlatformOwnedManifest(input: {
  appId: string
  version: string
  name: string
  entry: CreatorAppEntryCandidate
}): PoloAppManifest {
  return {
    schemaVersion: 1,
    appId: input.appId,
    version: input.version,
    name: input.name,
    runtime: input.entry.runtime,
    entry: [input.entry.path],
    healthcheck: input.entry.runtime === 'static' ? '/' : '/health',
    webPath: '/',
    permissions: [],
  }
}

/**
 * Replaces any Creator-supplied polo-app.json with the platform-owned one,
 * sorts file paths, and computes the final immutable bundle identity.
 */
export function createCanonicalCreatorAppBundle(input: {
  entries: readonly CreatorAppPayloadEntry[]
  appId: string
  version: string
  name: string
  entry: CreatorAppEntryCandidate
}): CanonicalCreatorAppBundle {
  const analysis = analyzeCreatorAppPayload(input.entries)
  if (analysis.status === 'invalid') throw new Error(analysis.message)
  const candidates = analysis.status === 'ready'
    ? [analysis.candidate]
    : analysis.candidates
  if (!candidates.some(candidate => (
    candidate.runtime === input.entry.runtime && candidate.path === input.entry.path
  ))) {
    throw new Error('The selected App entry is not a safe analyzed candidate.')
  }
  const manifest = createPlatformOwnedManifest(input)
  const entries: NormalizedCreatorAppPayloadEntry[] = input.entries
    .filter(entry => safePath(entry.path) !== 'polo-app.json')
    .map(entry => ({
      path: safePath(entry.path)!,
      type: entry.type ?? 'file' as const,
      content: entry.content ?? new TextDecoder().decode(entry.bytes ?? new Uint8Array()),
      bytes: entry.bytes ?? strToU8(entry.content ?? ''),
    }))
    .concat({
      path: 'polo-app.json',
      type: 'file' as const,
      content: `${JSON.stringify(manifest)}\n`,
      bytes: strToU8(`${JSON.stringify(manifest)}\n`),
    })
    .sort((left, right) => left.path.localeCompare(right.path))
  const archiveEntries: Record<string, Uint8Array> = {}
  for (const entry of entries) {
    if (entry.type !== 'file') continue
    const source = input.entries.find(sourceEntry => safePath(sourceEntry.path) === entry.path)
    archiveEntries[entry.path] = entry.path === 'polo-app.json'
      ? entry.bytes
      : source?.bytes ?? strToU8(source?.content ?? '')
  }
  const archive = zipSync(archiveEntries, { level: 9 })
  validateProductionCreatorAppBundle(archive, manifest)
  return {
    entries,
    manifest,
    checksum: createHash('sha256').update(archive).digest('hex'),
    sizeBytes: archive.byteLength,
    archive,
  }
}

/** Decode a real ZIP at the authenticated ingress boundary.  It never runs it. */
export function decodeCreatorAppPayloadZip(archive: Uint8Array): CreatorAppPayloadEntry[] {
  if (archive.byteLength === 0 || archive.byteLength > CREATOR_APP_PAYLOAD_LIMITS.archiveBytes) {
    throw new Error('The upload ZIP is empty or exceeds the archive size limit.')
  }
  const directories = inspectZipCentralDirectory(archive)
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(archive)
  } catch {
    throw new Error('The upload is not a valid ZIP archive.')
  }
  const entries = Object.entries(files).map(([path, bytes]) => {
    if (!safePath(path)) throw new Error('The upload contains an unsafe archive entry.')
    return { path: path.replace(/\/$/, ''), type: directories.has(path) ? 'directory' as const : 'file' as const, bytes, content: new TextDecoder().decode(bytes) }
  })
  return normalizeCreatorAppPayloadRoot(entries)
}

/** Remove one accidental enclosing project directory, but never merge conflicts. */
export function normalizeCreatorAppPayloadRoot(
  input: readonly CreatorAppPayloadEntry[],
): CreatorAppPayloadEntry[] {
  const safeEntries = input.map(entry => ({ ...entry, path: safePath(entry.path) ?? entry.path }))
  const files = safeEntries.filter(entry => entry.type !== 'directory')
  const roots = new Set(files.map(entry => entry.path.split('/')[0]!))
  const shouldStrip = files.length > 0 && roots.size === 1 && files.every(entry => entry.path.includes('/'))
  const entries = shouldStrip
    ? safeEntries.map(entry => ({ ...entry, path: entry.path.slice(entry.path.indexOf('/') + 1) }))
    : safeEntries
  const seen = new Set<string>()
  for (const entry of entries) {
    if (entry.type === 'directory') continue
    const path = safePath(entry.path)
    const key = path?.toLocaleLowerCase('en-US')
    if (!path || !key || seen.has(key)) throw new Error('The upload contains conflicting file paths.')
    seen.add(key)
  }
  return entries
}

/**
 * fflate returns an object keyed by name, which would hide duplicate central
 * directory entries and Unix symlink metadata. Inspect those bytes first.
 */
function inspectZipCentralDirectory(archive: Uint8Array): Set<string> {
  const names = new Set<string>()
  const decoder = new TextDecoder()
  let count = 0
  let expandedBytes = 0
  const directories = new Set<string>()
  for (let offset = 0; offset + 46 <= archive.length; offset += 1) {
    if (
      archive[offset] !== 0x50 || archive[offset + 1] !== 0x4b
      || archive[offset + 2] !== 0x01 || archive[offset + 3] !== 0x02
    ) continue
    const view = new DataView(archive.buffer, archive.byteOffset + offset, 46)
    const nameLength = view.getUint16(28, true)
    const extraLength = view.getUint16(30, true)
    const commentLength = view.getUint16(32, true)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > archive.length) throw new Error('The upload is not a valid ZIP archive.')
    const path = decoder.decode(archive.subarray(offset + 46, offset + 46 + nameLength))
    const normalized = safePath(path)
    const key = normalized?.toLocaleLowerCase('en-US')
    const externalAttributes = view.getUint32(38, true)
    const unixMode = externalAttributes >>> 16
    const compressedBytes = view.getUint32(20, true)
    const uncompressedBytes = view.getUint32(24, true)
    count += 1
    expandedBytes += uncompressedBytes
    if (
      !normalized || !key || names.has(key) || (unixMode & 0o170000) === 0o120000
      || count > CREATOR_APP_PAYLOAD_LIMITS.entryCount
      || compressedBytes > CREATOR_APP_PAYLOAD_LIMITS.compressedEntryBytes
      || uncompressedBytes > CREATOR_APP_PAYLOAD_LIMITS.expandedEntryBytes
      || expandedBytes > CREATOR_APP_PAYLOAD_LIMITS.expandedTotalBytes
      || compressedBytes === 0 && uncompressedBytes > 0
      || uncompressedBytes / Math.max(1, compressedBytes) > CREATOR_APP_PAYLOAD_LIMITS.compressionRatio
    ) {
      throw new Error('The upload contains an unsafe archive entry.')
    }
    names.add(key)
    if (path.endsWith('/')) directories.add(path)
    offset = end - 1
  }
  return directories
}

/** The same manifest/ZIP contract consumed by the desktop installer. */
export function validateProductionCreatorAppBundle(
  archive: Uint8Array,
  expected?: Pick<PoloAppManifest, 'appId' | 'version' | 'runtime'>,
): PoloAppManifest {
  const entries = decodeCreatorAppPayloadZip(archive)
  const manifestEntry = entries.find(entry => entry.path === 'polo-app.json')
  if (!manifestEntry?.content) throw new Error('The final Bundle is missing polo-app.json.')
  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(manifestEntry.content)
  } catch {
    throw new Error('The final Bundle has an invalid polo-app.json.')
  }
  let manifest: PoloAppManifest
  try {
    manifest = validatePoloAppManifestContract(rawManifest)
  } catch {
    throw new Error('The final Bundle does not satisfy the production Manifest contract.')
  }
  const entry = safePath(manifest.entry[0]!)
  if (!entry || !entries.some(item => item.path === entry && item.type === 'file')) {
    throw new Error('The final Bundle does not satisfy the production Manifest contract.')
  }
  if (expected && (manifest.appId !== expected.appId || manifest.version !== expected.version || manifest.runtime !== expected.runtime)) {
    throw new Error('The final Bundle does not satisfy the production Manifest contract.')
  }
  return manifest
}

export function buildCreatorAppPublishingUrl(
  adminUrl: string,
  input: { organizationId: string; mode: CreatorAppPublishMode },
): string {
  const url = new URL('/organization-apps/publish', adminUrl)
  url.searchParams.set('organizationId', input.organizationId)
  url.searchParams.set('mode', input.mode)
  return url.toString()
}

export function resolveCreatorAppPublishingOrganization(input: {
  requestedOrganizationId: string | null | undefined
  availableOrganizationIds: readonly string[]
  fallbackOrganizationId: string | null
}): { organizationId: string | null; source: 'requested' | 'fallback' | 'none' } {
  if (
    input.requestedOrganizationId
    && input.availableOrganizationIds.includes(input.requestedOrganizationId)
  ) return { organizationId: input.requestedOrganizationId, source: 'requested' }
  if (
    input.fallbackOrganizationId
    && input.availableOrganizationIds.includes(input.fallbackOrganizationId)
  ) return { organizationId: input.fallbackOrganizationId, source: 'fallback' }
  return { organizationId: null, source: 'none' }
}
