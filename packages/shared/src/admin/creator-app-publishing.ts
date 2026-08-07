import { createHash } from 'node:crypto'
import type { LocalAppRuntimeKind, PoloAppManifest } from '../protocol/local-apps.ts'

export type CreatorAppPublishMode = 'website' | 'upload'
export type CreatorAppVisibility = 'all_members'

export interface CreatorAppPayloadEntry {
  path: string
  type?: 'file' | 'directory' | 'symlink'
  /** Text is sufficient for the deterministic ingress contract and tests. */
  content?: string
}

export interface CreatorAppEntryCandidate {
  runtime: LocalAppRuntimeKind
  path: string
}

export type CreatorAppPayloadAnalysis =
  | { status: 'ready'; candidate: CreatorAppEntryCandidate; legacyHint?: CreatorAppEntryCandidate }
  | { status: 'needs_entry_selection'; candidates: CreatorAppEntryCandidate[]; legacyHint?: CreatorAppEntryCandidate }
  | { status: 'invalid'; code: 'missing_runnable_payload' | 'unsafe_archive'; message: string }

export interface CanonicalCreatorAppBundle {
  entries: Array<Required<CreatorAppPayloadEntry>>
  manifest: PoloAppManifest
  checksum: string
  sizeBytes: number
}

const PYTHON_LOCK_FILES = new Set(['requirements.txt', 'poetry.lock', 'pipfile.lock', 'uv.lock'])
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

function legacyCandidate(entries: readonly Required<CreatorAppPayloadEntry>[]): CreatorAppEntryCandidate | undefined {
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

/**
 * Server-side ingress contract. It is intentionally pure: callers inspect
 * uploaded bytes but never execute a build command or application code.
 */
export function analyzeCreatorAppPayload(
  input: readonly CreatorAppPayloadEntry[],
): CreatorAppPayloadAnalysis {
  const seen = new Set<string>()
  const entries: Array<Required<CreatorAppPayloadEntry>> = []
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
    entries.push({ path, type: entry.type ?? 'file', content: entry.content ?? '' })
  }

  const files = entries.filter(entry => entry.type === 'file')
  const paths = new Set(files.map(entry => entry.path))
  const rootNames = new Set(files.filter(entry => !entry.path.includes('/')).map(entry => entry.path.toLowerCase()))
  const legacyHint = legacyCandidate(entries)
  const candidates: CreatorAppEntryCandidate[] = []

  if (paths.has('index.html')) candidates.push({ runtime: 'static', path: 'index.html' })

  const hasPythonLock = [...rootNames].some(name => PYTHON_LOCK_FILES.has(name))
  const hasJsLock = [...rootNames].some(name => JS_LOCK_FILES.has(name))
  for (const entry of files) {
    if (isRootFile(entry.path, ['main.py', 'app.py', 'server.py', 'wsgi.py']) && hasPythonLock) {
      candidates.push({ runtime: 'python', path: entry.path })
    }
    if (
      (isRootFile(entry.path, ['server.js', 'server.mjs', 'index.js', 'index.mjs']) && hasJsLock)
      || entry.path === '.next/standalone/server.js'
    ) {
      candidates.push({ runtime: 'js', path: entry.path })
    }
  }

  const uniqueCandidates = [...new Map(candidates.map(candidate => [
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
  const manifest = createPlatformOwnedManifest(input)
  const entries = input.entries
    .filter(entry => safePath(entry.path) !== 'polo-app.json')
    .map(entry => ({
      path: safePath(entry.path)!,
      type: entry.type ?? 'file' as const,
      content: entry.content ?? '',
    }))
    .concat({ path: 'polo-app.json', type: 'file' as const, content: `${JSON.stringify(manifest)}\n` })
    .sort((left, right) => left.path.localeCompare(right.path))
  const encoded = entries.map(entry => `${entry.path}\0${entry.type}\0${entry.content}\0`).join('')
  return {
    entries,
    manifest,
    checksum: createHash('sha256').update(encoded).digest('hex'),
    sizeBytes: Buffer.byteLength(encoded),
  }
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
