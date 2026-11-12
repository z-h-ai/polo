import { describe, it, expect, afterAll } from "bun:test"
import { mkdtemp, rm, mkdir, writeFile, symlink, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { strToU8, zipSync } from "fflate"
import {
  applyDisplayNames,
  listZipBatch,
  minimalDisambiguatingName,
  scanFolderBatch,
  zipSelfEntry,
  ZIP_SOURCE_MAX_BYTES,
  SCAN_MAX_ENTRIES,
} from "../batch-source"

/**
 * POO-210 batch-source unit tests: the selection table, the budgets, the
 * name de-confliction, and the traversal guards — all against real fflate
 * archives and a real temp tree (no fs mocks).
 */

const MAX_ENTRY_BYTES = 1024 * 1024

describe("listZipBatch selection rules (D2)", () => {
  it("includes OpenViking-aligned formats and excludes the rest with reasons", async () => {
    const archive = zipSync({
      "readme.md": strToU8("# hi"),
      "data.json": strToU8("{}"),
      "report.pdf": new Uint8Array([0x25, 0x50, 0x44, 0x46]), // %PDF
      "合同.docx": new Uint8Array([1, 2, 3]),
      "photo.png": new Uint8Array([137, 80, 78, 71]),
      "clip.mp4": new Uint8Array([1, 2, 3, 4]),
      "nested.zip": zipSync({ "inner.txt": strToU8("x") }), // D2: imported as a plain file
      "app.ts": strToU8("const x = 1"),
      "blob.bin": new Uint8Array([0, 1, 2, 3]), // binary_format
      "empty.txt": new Uint8Array([]), // empty
      ".hidden.md": strToU8("x"), // hidden
      "__MACOSX/junk": new Uint8Array([1]), // hidden segment
      "node_modules/lib.js": strToU8("x"), // dependency_dir (segment rule, same as folder scan)
      "../escape.txt": strToU8("x"), // traversal → hidden
    })
    const result = await listZipBatch(archive, { maxEntryBytes: MAX_ENTRY_BYTES })
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`)
    const byName = new Map(result.entries.map((entry) => [entry.sourcePath, entry]))

    expect(byName.get("readme.md")?.included).toBe(true)
    expect(byName.get("data.json")?.included).toBe(true)
    expect(byName.get("report.pdf")?.included).toBe(true)
    expect(byName.get("合同.docx")?.included).toBe(true)
    expect(byName.get("photo.png")?.included).toBe(true)
    expect(byName.get("clip.mp4")?.included).toBe(true)
    expect(byName.get("nested.zip")?.included).toBe(true)
    expect(byName.get("app.ts")?.included).toBe(true)

    expect(byName.get("blob.bin")).toMatchObject({ included: false, reason: "binary_format" })
    expect(byName.get("empty.txt")).toMatchObject({ included: false, reason: "empty" })
    expect(byName.get(".hidden.md")).toMatchObject({ included: false, reason: "hidden" })
    expect(byName.get("__MACOSX/junk")).toMatchObject({ included: false, reason: "dependency_dir" })
    expect(byName.get("node_modules/lib.js")).toMatchObject({ included: false, reason: "dependency_dir" })
    expect(byName.get("../escape.txt")).toMatchObject({ included: false, reason: "hidden" })
  })

  it("applies the dependency-dir segment rule to zip entries identically to folder files", async () => {
    const archive = zipSync({ "node_modules/lib.js": strToU8("module.exports=1") })
    const result = await listZipBatch(archive, { maxEntryBytes: MAX_ENTRY_BYTES })
    if (!result.ok) throw new Error("expected ok")
    expect(result.entries[0]).toMatchObject({ included: false, reason: "dependency_dir" })
  })

  it("refuses an oversized archive and a corrupt one", async () => {
    const huge = new Uint8Array(ZIP_SOURCE_MAX_BYTES + 1)
    expect((await listZipBatch(huge, { maxEntryBytes: MAX_ENTRY_BYTES })).ok).toBe(false)
    const corrupt = strToU8("definitely not a zip")
    const corruptResult = await listZipBatch(corrupt, { maxEntryBytes: MAX_ENTRY_BYTES })
    expect(corruptResult).toMatchObject({ ok: false, failure: "not_a_zip" })
  })

  it("refuses the whole archive when the inflated total exceeds the budget (zip bomb)", async () => {
    const archive = zipSync({
      "a.txt": strToU8("x".repeat(1000)),
      "b.txt": strToU8("y".repeat(1000)),
    })
    const result = await listZipBatch(archive, { maxEntryBytes: MAX_ENTRY_BYTES, inflatedLimit: 999 })
    expect(result).toMatchObject({ ok: false, failure: "zip_bomb" })
  })

  it("marks oversized entries too_large and truncates past SCAN_MAX_ENTRIES", async () => {
    const files: Record<string, Uint8Array> = {}
    for (let i = 0; i < SCAN_MAX_ENTRIES + 50; i++) {
      files[`f${i}.txt`] = strToU8("x")
    }
    files["big.pdf"] = new Uint8Array(MAX_ENTRY_BYTES + 1)
    const result = await listZipBatch(zipSync(files), { maxEntryBytes: MAX_ENTRY_BYTES })
    if (!result.ok) throw new Error("expected ok")
    expect(result.truncated).toBe(true)
    expect(result.entries.length).toBe(SCAN_MAX_ENTRIES)
    const big = result.entries.find((entry) => entry.sourcePath === "big.pdf")
    if (big) expect(big).toMatchObject({ included: false, reason: "too_large" })
  })
})

describe("minimalDisambiguatingName / applyDisplayNames (D3a)", () => {
  it("returns the basename when unique", () => {
    expect(minimalDisambiguatingName("docs/readme.md", ["other/x.md"])).toBe("readme.md")
  })

  it("climbs to the smallest unique parent prefix on collision", () => {
    expect(minimalDisambiguatingName("a/v2/readme.md", ["b/v1/readme.md"])).toBe("v2/readme.md")
    expect(minimalDisambiguatingName("a/v2/readme.md", ["b/v2/readme.md"])).toBe("a/v2/readme.md")
    expect(minimalDisambiguatingName("docs/v2/readme.md", ["docs/v1/readme.md"])).toBe("v2/readme.md")
  })

  it("applyDisplayNames prefixes only the colliding group", () => {
    const entries = [
      { sourcePath: "a/README.md", displayName: "", sizeBytes: 1, included: true, reason: null },
      { sourcePath: "b/README.md", displayName: "", sizeBytes: 1, included: true, reason: null },
      { sourcePath: "solo.md", displayName: "", sizeBytes: 1, included: true, reason: null },
    ]
    applyDisplayNames(entries)
    expect(entries[2].displayName).toBe("solo.md")
    expect(entries[0].displayName).toBe("a/README.md")
    expect(entries[1].displayName).toBe("b/README.md")
  })
})

describe("scanFolderBatch", () => {
  let root: string
  const cleanups: string[] = []
  afterAll(async () => {
    await Promise.all(cleanups.map((path) => rm(path, { recursive: true, force: true })))
  })

  async function makeTree(): Promise<string> {
    root = await mkdtemp(join(tmpdir(), "poo210-scan-"))
    cleanups.push(root)
    await mkdir(join(root, "src/nested"), { recursive: true })
    await mkdir(join(root, "node_modules/pkg"), { recursive: true })
    await mkdir(join(root, ".git"), { recursive: true })
    await writeFile(join(root, "top.md"), "# top")
    await writeFile(join(root, "src/app.ts"), "export {}")
    await writeFile(join(root, "src/nested/deep.md"), "deep")
    await writeFile(join(root, "src/empty.txt"), "")
    await writeFile(join(root, "src/blob.exe"), new Uint8Array([1, 2, 3]))
    await writeFile(join(root, ".DS_Store"), new Uint8Array([1]))
    await writeFile(join(root, "node_modules/pkg/index.js"), "x")
    await writeFile(join(root, ".git/config"), "x")
    return root
  }

  it("lists included files, excluded placeholders, and never recurses excluded dirs", async () => {
    await makeTree()
    const result = await scanFolderBatch(root, { maxEntryBytes: MAX_ENTRY_BYTES })
    if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result)}`)
    const bySuffix = new Map(result.entries.map((entry) => [entry.displayName, entry]))

    expect(bySuffix.get("top.md")).toMatchObject({ included: true })
    expect(bySuffix.get("app.ts")).toMatchObject({ included: true })
    expect(bySuffix.get("deep.md")).toMatchObject({ included: true })
    expect(bySuffix.get("empty.txt")).toMatchObject({ included: false, reason: "empty" })
    expect(bySuffix.get("blob.exe")).toMatchObject({ included: false, reason: "binary_format" })
    expect(bySuffix.get(".DS_Store")).toMatchObject({ included: false, reason: "hidden" })
    expect(bySuffix.get("node_modules")).toMatchObject({ included: false, reason: "dependency_dir" })
    expect(bySuffix.get(".git")).toMatchObject({ included: false, reason: "hidden" })
    // The excluded dir contributes exactly ONE placeholder — no children.
    expect(result.entries.filter((entry) => entry.sourcePath.includes("node_modules")).length).toBe(1)
    expect(result.entries.filter((entry) => entry.sourcePath.includes(".git/")).length).toBe(0)
    expect(result.truncated).toBe(false)
  })

  it("excludes symlinks without following them", async () => {
    await makeTree()
    const outside = await mkdtemp(join(tmpdir(), "poo210-outside-"))
    cleanups.push(outside)
    await writeFile(join(outside, "secret.md"), "should not be followed")
    await symlink(join(outside, "secret.md"), join(root, "link.md"))
    await symlink(outside, join(root, "linkdir"))

    const result = await scanFolderBatch(root, { maxEntryBytes: MAX_ENTRY_BYTES })
    if (!result.ok) throw new Error("expected ok")
    const bySuffix = new Map(result.entries.map((entry) => [entry.displayName, entry]))
    expect(bySuffix.get("link.md")).toMatchObject({ included: false, reason: "symlink" })
    expect(bySuffix.get("linkdir")).toMatchObject({ included: false, reason: "symlink" })
    expect(result.entries.some((entry) => entry.sourcePath.includes("secret.md"))).toBe(false)
  })

  it("reports not_a_directory / read_failed without throwing", async () => {
    const base = await mkdtemp(join(tmpdir(), "poo210-nd-"))
    cleanups.push(base)
    const file = join(base, "plain.txt")
    await writeFile(file, "x")
    expect(await scanFolderBatch(file, { maxEntryBytes: MAX_ENTRY_BYTES })).toMatchObject({
      ok: false,
      failure: "not_a_directory",
    })
    // A path through a non-directory reports ENOTDIR, not ENOENT (macOS/Linux).
    expect(await scanFolderBatch(join(file, "missing"), { maxEntryBytes: MAX_ENTRY_BYTES })).toMatchObject({
      ok: false,
      failure: "not_a_directory",
    })
    // An unreadable directory surfaces as read_failed.
    const sealed = join(base, "sealed")
    await mkdir(sealed)
    await writeFile(join(sealed, "inner.md"), "x")
    await chmod(sealed, 0o000)
    try {
      expect(await scanFolderBatch(sealed, { maxEntryBytes: MAX_ENTRY_BYTES })).toMatchObject({
        ok: false,
        failure: "read_failed",
      })
    } finally {
      await chmod(sealed, 0o755)
    }
  })
})

describe("zipSelfEntry (D3c)", () => {
  it("stands for the archive itself, default-unchecked", () => {
    const entry = zipSelfEntry("/tmp/photos.zip", 123)
    expect(entry).toMatchObject({
      displayName: "photos.zip",
      sizeBytes: 123,
      included: false,
      reason: null,
    })
  })
})
