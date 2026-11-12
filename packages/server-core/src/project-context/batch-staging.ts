import { randomUUID, randomBytes } from "node:crypto";
import { basename, join } from "node:path";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { unzip } from "fflate";
import {
  listZipBatch,
  zipSelfEntry,
  type BatchEntryDraft,
  type ZipListFailure,
} from "./batch-source";

/**
 * POO-210 zip staging — unpacks the INCLUDED entries of a picked archive
 * into a private per-batch directory so every entry becomes a REAL local
 * file the existing `pcUploadFile` RPC can stream (D3.4: the transfer lives
 * in server-core; the renderer never sees bytes).
 *
 * Security posture (mirrors the repo's attachment discipline):
 * - the staging root and batch directories are 0700, staged files 0600;
 * - staged file names are GENERATED (`<ordinal>-<random>.<ext>` from the
 *   entry's extension) — a zip entry name is never used as a filesystem
 *   path, so traversal (`../`, drive prefixes, absolute forms) cannot reach
 *   the disk even before batch-source's classification excludes them;
 * - `cleanupStagedBatch` only ever deletes INSIDE the staging root, and the
 *   batchId is format-checked first;
 * - the original archive itself is referenced, never copied (the D3c
 *   "zip self" entry uploads the user's own file).
 */

const STAGING_FILE_MODE = 0o600;
const STAGING_DIR_MODE = 0o700;

function stagingRootPath(): string {
  return join(tmpdir(), "polo-pc-upload-staging")
}

export interface StagedBatchEntry extends BatchEntryDraft {
  entryId: string
  /** Absolute path of a REAL local file this entry uploads from. */
  stagedPath: string
}

export interface StagedZipBatch {
  batchId: string
  entries: StagedBatchEntry[]
  truncated: boolean
}

export type StageZipFailure = ZipListFailure | "read_failed" | "stage_failed"

export type StageZipResult =
  | { ok: true; batch: StagedZipBatch }
  | { ok: false; failure: StageZipFailure }

const BATCH_ID_PATTERN = /^[0-9a-f]{32}$/

/** Removes a batch directory. Returns false when the id is malformed or the
 * directory is gone — never throws, never deletes outside the staging root. */
export async function cleanupStagedBatch(batchId: string): Promise<boolean> {
  if (!BATCH_ID_PATTERN.test(batchId)) return false
  try {
    await rm(join(stagingRootPath(), batchId), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/** Boot-time housekeeping: drop batches left by a previous process. Called
 * once when the project-context handlers register — at that point THIS
 * process owns no batches, so everything under the root is debris. */
export async function cleanStagingRoot(): Promise<void> {
  await rm(stagingRootPath(), { recursive: true, force: true }).catch(() => {})
}

function stagedFileExtension(entryName: string): string {
  const base = basename(entryName.replaceAll("\\", "/"))
  const dot = base.lastIndexOf(".")
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : ""
  // A short alnum extension keeps the mime-from-extension path honest; a
  // missing/garbage one degrades to .bin exactly like the mime table would.
  return /^\.[A-Za-z0-9]{1,12}$/.test(ext) ? ext : ".bin"
}

export async function stageZipBatch(
  zipPath: string,
  options: { maxEntryBytes: number },
): Promise<StageZipResult> {
  let bytes: Uint8Array
  try {
    const fileStat = await stat(zipPath)
    if (!fileStat.isFile()) return { ok: false, failure: "read_failed" }
    bytes = await readFile(zipPath)
  } catch {
    return { ok: false, failure: "read_failed" }
  }

  // Pass 1 (inside listZipBatch): central-directory manifest, no inflation.
  const listed = await listZipBatch(bytes, options)
  if (!listed.ok) return listed
  const included = listed.entries.filter((entry) => entry.included)
  const includedNames = new Set(included.map((entry) => entry.sourcePath))

  const batchId = randomBytes(16).toString("hex") // matches BATCH_ID_PATTERN
  const batchDir = join(stagingRootPath(), batchId)
  try {
    await mkdir(batchDir, { recursive: true, mode: STAGING_DIR_MODE })
  } catch {
    return { ok: false, failure: "stage_failed" }
  }

  // Pass 2: inflate ONLY the included entries, then write each one as a
  // generated-name file under the batch dir. Names are canonicalized with
  // the SAME rule batch-source used to build `sourcePath` (`/` separators,
  // empty segments dropped) so the include-set matches even for odd archives.
  const canonical = (name: string): string =>
    name.replaceAll("\\", "/").split("/").filter((segment) => segment.length > 0).join("/")
  const stagedPaths = new Map<string, string>()
  try {
    const inflated = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      unzip(
        bytes,
        { filter: (file) => includedNames.has(canonical(file.name)) },
        (error, data) => {
          if (error) reject(error)
          else resolve(data)
        },
      )
    })
    let ordinal = 0
    for (const [name, content] of Object.entries(inflated)) {
      const key = canonical(name)
      const stagedPath = join(batchDir, `${ordinal}-${randomUUID().slice(0, 8)}${stagedFileExtension(key)}`)
      await writeFile(stagedPath, content, { mode: STAGING_FILE_MODE })
      stagedPaths.set(key, stagedPath)
      ordinal += 1
    }
  } catch {
    // Half-written staging must not leak: the caller reports failure, the
    // batch dir dies here.
    await rm(batchDir, { recursive: true, force: true }).catch(() => {})
    return { ok: false, failure: "stage_failed" }
  }

  const entries: StagedBatchEntry[] = listed.entries.map((entry) => ({
    ...entry,
    entryId: randomUUID(),
    // Included entries point at their staged file; excluded ones keep the
    // zip-internal path only as provenance (never uploaded).
    stagedPath: entry.included
      ? stagedPaths.get(entry.sourcePath) ?? ""
      : "",
  }))

  // D3c: the archive itself, default-unchecked, uploaded from its ORIGINAL
  // path — no copy. It is exempt from the max-entry check (it is the source,
  // already size-gated by listZipBatch's ZIP_SOURCE_MAX_BYTES).
  const selfSize = (await stat(zipPath)).size
  entries.push({
    ...zipSelfEntry(zipPath, selfSize),
    entryId: randomUUID(),
    stagedPath: zipPath,
  })

  return { ok: true, batch: { batchId, entries, truncated: listed.truncated } }
}
