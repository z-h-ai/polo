export const CREATOR_APP_CANONICAL_ENTRIES = Object.freeze({
  static: 'index.html',
  python: 'server/main.py',
  js: 'server/index.js',
} as const)

export const CREATOR_APP_PAYLOAD_LIMITS = Object.freeze({
  archiveBytes: 200 * 1024 * 1024,
  entryCount: 10_000,
  compressedEntryBytes: 200 * 1024 * 1024,
  expandedEntryBytes: 512 * 1024 * 1024,
  expandedTotalBytes: 1024 * 1024 * 1024,
  compressionRatio: 100,
})

export const CREATOR_APP_PAYLOAD_MAX_BYTES = CREATOR_APP_PAYLOAD_LIMITS.archiveBytes
