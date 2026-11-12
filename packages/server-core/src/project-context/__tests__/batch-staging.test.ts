import { describe, it, expect, afterAll } from "bun:test"
import { chmod, mkdtemp, rm, stat, writeFile, readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strToU8, zipSync } from "fflate"
import {
  cleanStagingRoot,
  cleanupStagedBatch,
  stageZipBatch,
} from "../batch-staging"

/**
 * POO-210 staging tests, against REAL disks: included entries land as
 * 0600 files with generated names, excluded entries never hit the disk,
 * the zip-self entry references the ORIGINAL path, and cleanup is
 * containment-proof.
 */

const MAX_ENTRY_BYTES = 1024 * 1024
const tempDirs: string[] = []
const createdBatchIds: string[] = []

afterAll(async () => {
  await Promise.all(tempDirs.map((path) => rm(path, { recursive: true, force: true })))
  await Promise.all(createdBatchIds.map((id) => cleanupStagedBatch(id)))
})

describe("stageZipBatch", () => {
  it("stages included entries as generated-name files and skips excluded ones", async () => {
    const zipPath = join(await mkdtemp(join(tmpdir(), "poo210-stage-src-")), "photos.zip")
    tempDirs.push(join(zipPath, ".."))
    await writeFile(zipPath, zipSync({
      "docs/readme.md": strToU8("# hello"),
      "docs/略过.bin": new Uint8Array([9, 9]),
      "data/config.json": strToU8("{}"),
      "nested.zip": zipSync({ "inner.txt": strToU8("x") }),
    }))

    const result = await stageZipBatch(zipPath, { maxEntryBytes: MAX_ENTRY_BYTES })
    if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`)
    createdBatchIds.push(result.batch.batchId)

    const included = result.batch.entries.filter((entry) => entry.included)
    const excluded = result.batch.entries.filter((entry) => !entry.included)
    // readme.md + config.json + nested.zip (D2: a nested zip is imported as a
    // plain file, never recursively unpacked). The only excluded entry is the
    // archive itself (D3c: listed, unchecked by default).
    expect(included.length).toBe(3)
    expect(excluded.length).toBe(2) // the .bin and the archive itself
    expect(excluded.some((entry) => entry.reason === "binary_format")).toBe(true)

    const self = excluded.find((entry) => entry.sourcePath === zipPath)
    expect(self).toBeDefined()
    expect(self?.stagedPath).toBe(zipPath) // original, never copied
    expect(self?.reason).toBeNull()
    expect(self?.displayName).toBe("photos.zip")

    for (const entry of included) {
      if (entry.sourcePath === zipPath) continue
      expect(entry.stagedPath).toMatch(new RegExp(`^${join(tmpdir(), "polo-pc-upload-staging")}/${result.batch.batchId}/`))
      const info = await stat(entry.stagedPath)
      expect(info.isFile()).toBe(true)
      expect(info.mode & 0o777).toBe(0o600)
      // Generated names never leak zip entry names.
      expect(entry.stagedPath).not.toContain("readme.md")
    }
    for (const entry of excluded) {
      if (entry.sourcePath === zipPath) continue
      expect(entry.stagedPath).toBe("")
    }
  })

  it("refuses corrupt archives without leaving a batch directory", async () => {
    const zipPath = join(await mkdtemp(join(tmpdir(), "poo210-stage-bad-")), "bad.zip")
    tempDirs.push(join(zipPath, ".."))
    await writeFile(zipPath, strToU8("not a zip at all"))
    const result = await stageZipBatch(zipPath, { maxEntryBytes: MAX_ENTRY_BYTES })
    expect(result).toMatchObject({ ok: false, failure: "not_a_zip" })
    const root = join(tmpdir(), "polo-pc-upload-staging")
    const leftovers = await readdir(root).catch(() => [])
    // No staging directory should have been created for the failed batch.
    // (Other tests' live batches are allowed to coexist.)
    expect(leftovers.length).toBeLessThanOrEqual(createdBatchIds.length)
  })

  it("reads a missing source as read_failed", async () => {
    const result = await stageZipBatch(join(tmpdir(), "poo210-missing-zip.zip"), { maxEntryBytes: MAX_ENTRY_BYTES })
    expect(result).toMatchObject({ ok: false, failure: "read_failed" })
  })
})

describe("cleanupStagedBatch", () => {
  it("removes the batch directory and reports it", async () => {
    const zipPath = join(await mkdtemp(join(tmpdir(), "poo210-stage-cln-")), "a.zip")
    tempDirs.push(join(zipPath, ".."))
    await writeFile(zipPath, zipSync({ "keep.md": strToU8("x") }))
    const result = await stageZipBatch(zipPath, { maxEntryBytes: MAX_ENTRY_BYTES })
    if (!result.ok) throw new Error("expected ok")
    const batchDir = join(tmpdir(), "polo-pc-upload-staging", result.batch.batchId)
    expect(await stat(batchDir).then(() => true).catch(() => false)).toBe(true)

    expect(await cleanupStagedBatch(result.batch.batchId)).toBe(true)
    expect(await stat(batchDir).then(() => true).catch(() => false)).toBe(false)
  })

  it("refuses malformed ids and idempotently reports missing ones", async () => {
    expect(await cleanupStagedBatch("../escape")).toBe(false)
    expect(await cleanupStagedBatch("")).toBe(false)
    expect(await cleanupStagedBatch("0".repeat(32))).toBe(true) // gone-or-gone: idempotent true
  })
})

describe("cleanStagingRoot (boot sweep)", () => {
  it("drops debris left by a previous process without throwing", async () => {
    const debris = join(tmpdir(), "polo-pc-upload-staging", "f".repeat(32))
    const { mkdir, writeFile: wf } = await import("node:fs/promises")
    await mkdir(debris, { recursive: true })
    await wf(join(debris, "leftover.txt"), "x")
    await cleanStagingRoot()
    expect(await stat(debris).then(() => true).catch(() => false)).toBe(false)
  })

  it("is safe to call repeatedly", async () => {
    await cleanStagingRoot()
    await cleanStagingRoot()
  })
})
