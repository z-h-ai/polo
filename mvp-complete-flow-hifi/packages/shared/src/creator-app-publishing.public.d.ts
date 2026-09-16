export type CreatorAppRuntime = 'static' | 'python' | 'js'
export type CreatorAppPublishMode = 'website' | 'upload'
export type CreatorAppVisibility = 'all_members'

export interface CreatorAppPayloadEntry {
  path: string
  type?: 'file' | 'directory' | 'symlink'
  content?: string
  bytes?: Uint8Array
}

export interface CreatorAppEntryCandidate {
  runtime: CreatorAppRuntime
  path: string
}

export type CreatorAppPayloadAnalysis =
  | { status: 'ready'; candidate: CreatorAppEntryCandidate; legacyHint?: CreatorAppEntryCandidate }
  | { status: 'needs_entry_selection'; candidates: CreatorAppEntryCandidate[]; legacyHint?: CreatorAppEntryCandidate }
  | {
      status: 'invalid'
      code: 'missing_runnable_payload' | 'ambiguous_runtime' | 'unsafe_archive' | 'invalid_legacy_permissions'
      message: string
    }

export interface CreatorAppManifest {
  schemaVersion: 1
  appId: string
  version: string
  name?: string
  runtime: CreatorAppRuntime
  entry: string[]
  healthcheck: string
  webPath: string
  permissions: string[]
  platforms?: Array<'darwin' | 'win32' | 'linux'>
  architectures?: Array<'arm64' | 'x64'>
  startTimeoutMs?: number
}

export interface NormalizedCreatorAppPayloadEntry {
  path: string
  type: 'file' | 'directory' | 'symlink'
  content: string
  bytes: Uint8Array
}

export interface CanonicalCreatorAppBundle {
  entries: NormalizedCreatorAppPayloadEntry[]
  manifest: CreatorAppManifest
  checksum: string
  sizeBytes: number
  archive: Uint8Array
}

export declare const CREATOR_APP_CANONICAL_ENTRIES: Readonly<{
  static: 'index.html'
  python: 'server/main.py'
  js: 'server/index.js'
}>

export declare const CREATOR_APP_PAYLOAD_LIMITS: Readonly<{
  archiveBytes: number
  entryCount: number
  compressedEntryBytes: number
  expandedEntryBytes: number
  expandedTotalBytes: number
  compressionRatio: number
}>

export declare const CREATOR_APP_PAYLOAD_MAX_BYTES: number

export declare function analyzeCreatorAppPayload(
  input: readonly CreatorAppPayloadEntry[],
): CreatorAppPayloadAnalysis

export declare function createPlatformOwnedManifest(input: {
  appId: string
  version: string
  name: string
  entry: CreatorAppEntryCandidate
}): CreatorAppManifest

export declare function createCanonicalCreatorAppBundle(input: {
  entries: readonly CreatorAppPayloadEntry[]
  appId: string
  version: string
  name: string
  entry: CreatorAppEntryCandidate
}): CanonicalCreatorAppBundle

export declare function decodeCreatorAppPayloadZip(
  archive: Uint8Array,
): CreatorAppPayloadEntry[]

export declare function normalizeCreatorAppPayloadRoot(
  input: readonly CreatorAppPayloadEntry[],
): CreatorAppPayloadEntry[]

export declare function validateProductionCreatorAppBundle(
  archive: Uint8Array,
  expected?: Pick<CreatorAppManifest, 'appId' | 'version' | 'runtime'>,
): CreatorAppManifest

export declare function buildCreatorAppPublishingUrl(
  adminUrl: string,
  input: { organizationId: string; mode: CreatorAppPublishMode },
): string

export declare function resolveCreatorAppPublishingOrganization(input: {
  requestedOrganizationId: string | null | undefined
  availableOrganizationIds: readonly string[]
  fallbackOrganizationId: string | null
}): { organizationId: string | null; source: 'requested' | 'fallback' | 'none' }
