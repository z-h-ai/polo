import { unzip } from "fflate";
import { basename, join, relative, sep } from "node:path";
import { readdir } from "node:fs/promises";

/**
 * POO-210 batch upload source layer — builds the ENTRY LIST the batch
 * upload dialog shows, from a zip archive or a local folder.
 *
 * This module is the SINGLE place the "what belongs in the library by
 * default" decision lives (task-card decision D2: aligned with OpenViking
 * Context's supported formats and its code-repo import precedents — skip
 * hidden/dependency/binary/empty/oversized). The renderer only consumes the
 * `included`/`reason` annotations; it never re-derives the rules, so the two
 * sides cannot drift.
 *
 * Budgets (D5), all enforced HERE so a pathological source dies before any
 * bytes move:
 * - zip archive itself: ZIP_SOURCE_MAX_BYTES (aligned with OpenViking's 200MB
 *   zip spec);
 * - total inflated bytes: ZIP_INFLATED_MAX_BYTES (zip-bomb guard; the whole
 *   zip is refused, never a partial import);
 * - folder walk / zip entry count: SCAN_MAX_ENTRIES, then the result is
 *   marked `truncated` (never a silent cut);
 * - one entry over the caller's per-file ceiling is listed but excluded
 *   (`too_large`) with the reason visible.
 *
 * Name de-confliction (D3a): entries are listed by basename; when a batch
 * contains the same basename twice, EVERY entry in that collision group is
 * re-displayed with the minimal disambiguating parent prefix.
 *
 * Safety: zip entry names are NEVER used as filesystem paths downstream —
 * staging rewrites them (see batch-staging) — but they are still classified
 * here, and anything carrying `..` segments, absolute forms or a Windows
 * drive prefix is excluded (`hidden`) rather than shown as a normal entry.
 */

/* ------------------------------------------------------------------ */
/* Budgets                                                             */
/* ------------------------------------------------------------------ */

export const ZIP_SOURCE_MAX_BYTES = 200 * 1024 * 1024;
export const ZIP_INFLATED_MAX_BYTES = 1024 * 1024 * 1024;
export const SCAN_MAX_ENTRIES = 5000;
/** A pathological deep tree must not walk forever even under SCAN_MAX_ENTRIES. */
export const FOLDER_MAX_DEPTH = 12;

/* ------------------------------------------------------------------ */
/* Selection rules (D2 — OpenViking-aligned)                           */
/* ------------------------------------------------------------------ */

/** Formats OpenViking Context's local-file import supports (temp_upload list
 * ∪ format spec table): documents, sheets, text/data, code, images, media,
 * and nested zip (imported as a plain file — never recursively unpacked). */
const INCLUDED_EXTENSIONS = new Set([
  // text / data
  ".md", ".markdown", ".txt", ".csv", ".json", ".xml", ".yaml", ".yml",
  ".toml", ".html", ".htm", ".ini", ".cfg", ".conf", ".log",
  // office / documents
  ".pdf", ".doc", ".docx", ".ppt", ".pptx", ".xls", ".xlsx",
  // code
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".kts", ".swift", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".php", ".sh", ".bash", ".zsh", ".sql", ".css", ".scss", ".less",
  ".vue", ".svelte", ".proto", ".graphql",
  // images
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
  // audio / video
  ".mp4", ".mov", ".avi", ".webm", ".mp3", ".wav", ".m4a", ".ogg", ".flac",
  // nested archive — imported as a plain file (D2)
  ".zip",
]);

/** Dependency/build/OS-noise directories: listed as excluded placeholders,
 * never recursed into (mirrors the repo's fs.SEARCH skip list plus POO-210
 * defaults). */
const EXCLUDED_DIR_NAMES = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", "out", "target",
  ".next", ".nuxt", ".cache", "__pycache__", "vendor", ".idea", ".vscode",
  "coverage", ".nyc_output", ".turbo", "__MACOSX",
]);

const EXCLUDED_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

/** Why an entry is not selected by default. The renderer maps these to i18n
 * copy; the values are stable wire-ish vocabulary (never rename). */
export type BatchExclusionReason =
  | "hidden"
  | "dependency_dir"
  | "binary_format"
  | "empty"
  | "too_large"
  | "symlink";

export interface BatchEntryDraft {
  /** Zip-internal path (`/`-separated) or absolute disk path (folder scan). */
  sourcePath: string
  /** What the dialog shows; basename unless de-conflicted (D3a). */
  displayName: string
  sizeBytes: number
  included: boolean
  reason: BatchExclusionReason | null
}

interface Classified {
  included: boolean
  reason: BatchExclusionReason | null
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot).toLowerCase() : ""
}

/** Any `.`-leading segment hides the whole entry (file or dir marker). */
function hasHiddenSegment(pathSegments: readonly string[]): boolean {
  return pathSegments.some((segment) => segment.startsWith("."))
}

/** A zip entry name must stay a RELATIVE posix-ish path: `..` segments,
 * absolute forms and drive prefixes are refused, not "suggested". */
function isUnsafeZipName(name: string): boolean {
  const normalized = name.replaceAll("\\", "/")
  if (normalized.startsWith("/") || normalized.startsWith("//")) return true
  if (/^[A-Za-z]:/.test(normalized)) return true
  return normalized.split("/").some((segment) => segment === "..")
}

function classifyFile(segments: readonly string[], sizeBytes: number, maxEntryBytes: number): Classified {
  const name = segments[segments.length - 1] ?? ""
  if (hasHiddenSegment(segments)) return { included: false, reason: "hidden" }
  if (EXCLUDED_FILE_NAMES.has(name)) return { included: false, reason: "hidden" }
  // Dependency/build directories poison the whole path beneath them — the
  // SAME rule for zip entries and folder files so the two surfaces never
  // disagree about e.g. `node_modules/lib.js`.
  if (segments.some((segment) => EXCLUDED_DIR_NAMES.has(segment))) {
    return { included: false, reason: "dependency_dir" }
  }
  if (sizeBytes === 0) return { included: false, reason: "empty" }
  if (sizeBytes > maxEntryBytes) return { included: false, reason: "too_large" }
  if (!INCLUDED_EXTENSIONS.has(extensionOf(name))) return { included: false, reason: "binary_format" }
  return { included: true, reason: null }
}

function classifyDir(segments: readonly string[]): Classified {
  const name = segments[segments.length - 1] ?? ""
  if (hasHiddenSegment(segments)) return { included: false, reason: "hidden" }
  if (EXCLUDED_DIR_NAMES.has(name)) return { included: false, reason: "dependency_dir" }
  return { included: true, reason: null }
}

/* ------------------------------------------------------------------ */
/* Name de-confliction (D3a)                                           */
/* ------------------------------------------------------------------ */

/** The minimal parent prefix that makes `path` unique WITHIN `siblings`.
 * One level usually settles it (`v2/设计稿.md`); deeper ties climb further. */
export function minimalDisambiguatingName(path: string, siblings: readonly string[]): string {
  const normalize = (value: string): string[] =>
    value.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0)
  const target = normalize(path)
  const base = target[target.length - 1] ?? path
  const others = siblings.filter((sibling) => sibling !== path).map(normalize)
  for (let depth = 1; depth <= target.length; depth++) {
    const candidate = target.slice(-depth).join("/")
    if (others.every((other) => other.slice(-depth).join("/") !== candidate)) {
      return candidate
    }
  }
  return base
}

/** Applies D3a over a draft list in place: groups by basename, and only the
 * colliding groups get prefixed display names. */
export function applyDisplayNames(entries: readonly BatchEntryDraft[]): void {
  const byBase = new Map<string, BatchEntryDraft[]>()
  for (const entry of entries) {
    const base = basename(entry.sourcePath.replaceAll("\\", "/"))
    const group = byBase.get(base) ?? []
    group.push(entry)
    byBase.set(base, group)
  }
  for (const [base, group] of byBase) {
    if (group.length === 1) {
      group[0].displayName = base
      continue
    }
    const paths = group.map((entry) => entry.sourcePath)
    for (const entry of group) {
      entry.displayName = minimalDisambiguatingName(entry.sourcePath, paths) ?? base
    }
  }
}

/* ------------------------------------------------------------------ */
/* Zip listing (filter pass — central directory without inflating)     */
/* ------------------------------------------------------------------ */

export type ZipListFailure =
  | "read_failed"
  | "zip_too_large"
  | "zip_bomb"
  | "not_a_zip"

export type ZipListResult =
  | {
      ok: true
      entries: BatchEntryDraft[]
      /** True when the entry count hit SCAN_MAX_ENTRIES — the rest of the
       * archive is NOT listed (the caller explains, never silently drops). */
      truncated: boolean
    }
  | { ok: false; failure: ZipListFailure }

interface FflateZipEntry {
  name: string
  size: number
  originalSize: number
}

/** Pass 1: the fflate `filter` callback sees every central-directory entry
 * WITHOUT inflating it (`return false` skips the data). We use it purely as
 * a cheap manifest reader — classification and the bomb budget both happen
 * before any content is decompressed. */
export async function listZipBatch(
  zipBytes: Uint8Array,
  options: { maxEntryBytes: number; /** Test seam: shrink the bomb budget so the guard is observable without a 1GB fixture. */ inflatedLimit?: number },
): Promise<ZipListResult> {
  if (zipBytes.byteLength <= 0 || zipBytes.byteLength > ZIP_SOURCE_MAX_BYTES) {
    return { ok: false, failure: "zip_too_large" }
  }
  const inflatedLimit = options.inflatedLimit ?? ZIP_INFLATED_MAX_BYTES
  const manifest: FflateZipEntry[] = []
  let inflatedTotal = 0
  try {
    await new Promise<void>((resolve, reject) => {
      unzip(
        zipBytes,
        {
          filter: (file: FflateZipEntry) => {
            manifest.push({ name: file.name, size: file.size, originalSize: file.originalSize })
            inflatedTotal += file.originalSize
            return false
          },
        },
        (error) => {
          if (error) reject(error)
          else resolve()
        },
      )
    })
  } catch {
    return { ok: false, failure: "not_a_zip" }
  }
  if (inflatedTotal > inflatedLimit) {
    return { ok: false, failure: "zip_bomb" }
  }

  const entries: BatchEntryDraft[] = []
  let truncated = false
  for (const file of manifest) {
    if (file.name.endsWith("/")) continue // bare directory marker — dirs surface via their files
    if (entries.length >= SCAN_MAX_ENTRIES) {
      truncated = true
      break
    }
    const segments = file.name.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0)
    if (segments.length === 0) continue
    const classified = isUnsafeZipName(file.name)
      ? { included: false, reason: "hidden" as const }
      : classifyFile(segments, file.originalSize, options.maxEntryBytes)
    entries.push({
      sourcePath: segments.join("/"),
      displayName: segments[segments.length - 1] ?? file.name,
      sizeBytes: file.originalSize,
      included: classified.included,
      reason: classified.reason,
    })
  }
  applyDisplayNames(entries)
  return { ok: true, entries, truncated }
}

/* ------------------------------------------------------------------ */
/* Folder scan (BFS, excluded dirs are placeholders, never recursed)   */
/* ------------------------------------------------------------------ */

export type FolderScanFailure = "read_failed" | "not_a_directory"

export type FolderScanResult =
  | { ok: true; entries: BatchEntryDraft[]; truncated: boolean }
  | { ok: false; failure: FolderScanFailure }

interface DirentLike {
  name: string
  isFile(): boolean
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export async function scanFolderBatch(
  rootPath: string,
  options: { maxEntryBytes: number },
): Promise<FolderScanResult> {
  let rootEntries: DirentLike[]
  try {
    rootEntries = await readdir(rootPath, { withFileTypes: true }) as unknown as DirentLike[]
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return { ok: false, failure: code === "ENOTDIR" ? "not_a_directory" : "read_failed" }
  }

  const entries: BatchEntryDraft[] = []
  let truncated = false
  // Queue of [absolutePath, segments-relative-to-root]. BFS keeps the listing
  // breadth-first so top-level files read before deep nesting.
  const queue: Array<[string, string[], number]> = [[rootPath, [], 0]]

  while (queue.length > 0) {
    if (entries.length >= SCAN_MAX_ENTRIES) {
      truncated = true
      break
    }
    const [dirPath, segments, depth] = queue.shift() as [string, string[], number]
    let dirents: DirentLike[]
    try {
      dirents = await readdir(dirPath, { withFileTypes: true }) as unknown as DirentLike[]
    } catch {
      continue // unreadable subtree — skip, the rest of the scan continues
    }
    for (const dirent of dirents) {
      if (entries.length >= SCAN_MAX_ENTRIES) {
        truncated = true
        break
      }
      const childSegments = [...segments, dirent.name]
      const relativePath = childSegments.join(sep)
      const absolutePath = join(rootPath, relativePath)

      if (dirent.isSymbolicLink()) {
        // Symlinks are never followed (escape hatch OUT of the picked root);
        // the entry is listed with the reason so the omission is visible.
        entries.push({
          sourcePath: absolutePath,
          displayName: dirent.name,
          sizeBytes: 0,
          included: false,
          reason: "symlink",
        })
        continue
      }
      if (dirent.isDirectory()) {
        const classified = classifyDir(childSegments)
        if (!classified.included && classified.reason !== null) {
          // Excluded dir: visible as a placeholder, never recursed into.
          entries.push({
            sourcePath: absolutePath,
            displayName: dirent.name,
            sizeBytes: 0,
            included: false,
            reason: classified.reason,
          })
          continue
        }
        if (depth + 1 < FOLDER_MAX_DEPTH) {
          queue.push([absolutePath, childSegments, depth + 1])
        }
        continue
      }
      if (!dirent.isFile()) continue

      let sizeBytes = 0
      try {
        const { stat } = await import("node:fs/promises")
        sizeBytes = (await stat(absolutePath)).size
      } catch {
        continue // vanished mid-scan
      }
      const classified = classifyFile(childSegments, sizeBytes, options.maxEntryBytes)
      entries.push({
        sourcePath: absolutePath,
        displayName: dirent.name,
        sizeBytes,
        included: classified.included,
        reason: classified.reason,
      })
    }
  }

  applyDisplayNames(entries)
  return { ok: true, entries, truncated }
}

/** The zip-source entry that stands for the archive itself (D3c: listed,
 * default-unchecked, uploads the ORIGINAL file — no copy is made). */
export function zipSelfEntry(zipPath: string, sizeBytes: number): BatchEntryDraft {
  return {
    sourcePath: zipPath,
    displayName: basename(zipPath),
    sizeBytes,
    included: false,
    reason: null,
  }
}

/** Test/操作 helper: absolute path of `entry` relative to a folder scan root. */
export function folderEntryRelativePath(entry: BatchEntryDraft, rootPath: string): string {
  return relative(rootPath, entry.sourcePath)
}
