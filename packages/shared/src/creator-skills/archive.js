// packages/shared/src/creator-skills/archive.ts
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  realpath,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";
import yauzl from "yauzl";

// packages/shared/src/creator-skills/types.ts
var DEFAULT_SKILL_ARCHIVE_POLICY = {
  version: "1",
  maxArchiveBytes: 20 * 1024 * 1024,
  maxFileCount: 200,
  maxFileBytes: 5 * 1024 * 1024,
  maxExpandedBytes: 50 * 1024 * 1024
};
var HARD_SKILL_ARCHIVE_POLICY = {
  version: "hard-1",
  maxArchiveBytes: 100 * 1024 * 1024,
  maxFileCount: 1e3,
  maxFileBytes: 25 * 1024 * 1024,
  maxExpandedBytes: 250 * 1024 * 1024
};

// packages/shared/src/creator-skills/skill-content.ts
import matter from "gray-matter";
import { z } from "zod";
var PortableSkillMetadataSchema = z.object({
  name: z.string().trim().min(
    1,
    "Add a 'name' field with a human-readable title (e.g., 'Git Commit Helper')"
  ),
  description: z.string().trim().min(
    1,
    "Add a 'description' field explaining what this skill does and when to use it (1-2 sentences)"
  ),
  globs: z.array(z.string()).optional(),
  alwaysAllow: z.array(z.string()).optional(),
  icon: z.string().trim().min(1).optional(),
  requiredSources: z.array(z.string()).optional()
}).passthrough();
function isValidSkillSlug(slug) {
  return /^[a-z0-9-]+$/.test(slug);
}
function isValidCreatorSkillSlug(slug) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug);
}
function suggestSkillSlug(slug) {
  return slug.normalize("NFC").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-") || "valid-slug-name";
}
function zodIssues(error, file) {
  return error.issues.map((issue2) => ({
    file,
    path: issue2.path.join(".") || "frontmatter",
    message: issue2.message,
    severity: "error"
  }));
}
function validatePortableSkillContent(markdownContent, slug) {
  const file = `skills/${slug}/SKILL.md`;
  const errors = [];
  if (!isValidSkillSlug(slug)) {
    errors.push({
      file: `skills/${slug}`,
      path: "slug",
      message: "Slug must be lowercase alphanumeric with hyphens",
      severity: "error",
      suggestion: `Rename folder to '${suggestSkillSlug(slug)}'`
    });
  }
  let parsed;
  try {
    parsed = matter(markdownContent);
  } catch (error) {
    return {
      valid: false,
      errors: [{
        file,
        path: "frontmatter",
        message: `Invalid YAML frontmatter: ${error instanceof Error ? error.message : "Unknown error"}`,
        severity: "error",
        suggestion: "See ~/.polo-ai/docs/skills.md for SKILL.md format reference"
      }],
      warnings: []
    };
  }
  const metadata = PortableSkillMetadataSchema.safeParse(parsed.data);
  if (!metadata.success) {
    errors.push(...zodIssues(metadata.error, file));
  }
  if (!parsed.content || parsed.content.trim().length === 0) {
    errors.push({
      file,
      path: "content",
      message: "Skill content is empty (nothing after frontmatter)",
      severity: "error",
      suggestion: "Add instructions after the frontmatter describing what the skill should do"
    });
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings: []
  };
}
function validateCreatorSkillContent(markdownContent, slug) {
  const validation = validatePortableSkillContent(markdownContent, slug);
  if (isValidCreatorSkillSlug(slug)) return validation;
  return {
    valid: false,
    errors: [
      ...validation.errors.filter((error) => error.path !== "slug"),
      {
        file: `skills/${slug}`,
        path: "slug",
        message: "Creator Skill slug must use strict kebab-case",
        severity: "error",
        suggestion: `Rename folder to '${suggestSkillSlug(slug)}'`
      }
    ],
    warnings: validation.warnings
  };
}
function readValidatedSkillMetadata(markdownContent, slug) {
  const validation = validatePortableSkillContent(markdownContent, slug);
  if (!validation.valid) return null;
  const parsed = matter(markdownContent);
  const metadata = PortableSkillMetadataSchema.parse(parsed.data);
  return {
    metadata: {
      name: metadata.name,
      description: metadata.description,
      ...metadata.globs ? { globs: metadata.globs } : {},
      ...metadata.alwaysAllow ? { alwaysAllow: metadata.alwaysAllow } : {},
      ...metadata.icon ? { icon: metadata.icon } : {},
      ...metadata.requiredSources ? { requiredSources: metadata.requiredSources } : {}
    },
    body: parsed.content
  };
}

// packages/shared/src/creator-skills/archive.ts
var WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
var PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
var MAX_ICON_DIMENSION = 4096;
var MAX_ICON_PIXELS = 16777216;
var MAX_ICON_DECODED_BYTES = 64 * 1024 * 1024;
var MAX_PNG_CHUNKS = 1024;
var PNG_CHANNELS = /* @__PURE__ */ new Map([
  [0, 1],
  [2, 3],
  [3, 1],
  [4, 2],
  [6, 4]
]);
var PNG_ALLOWED_BIT_DEPTHS = /* @__PURE__ */ new Map([
  [0, /* @__PURE__ */ new Set([1, 2, 4, 8, 16])],
  [2, /* @__PURE__ */ new Set([8, 16])],
  [3, /* @__PURE__ */ new Set([1, 2, 4, 8])],
  [4, /* @__PURE__ */ new Set([8, 16])],
  [6, /* @__PURE__ */ new Set([8, 16])]
]);
var CRC32_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 3988292384 ^ crc >>> 1 : crc >>> 1;
  }
  return crc >>> 0;
});
var EXECUTABLE_MAGICS = [
  Buffer.from([127, 69, 76, 70]),
  // ELF
  Buffer.from([77, 90]),
  // PE / DOS
  Buffer.from([254, 237, 250, 206]),
  Buffer.from([206, 250, 237, 254]),
  Buffer.from([254, 237, 250, 207]),
  Buffer.from([207, 250, 237, 254]),
  Buffer.from([202, 254, 186, 190]),
  Buffer.from([190, 186, 254, 202])
];
var NESTED_ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tgz", ".tar.gz"];
var HARD_MAX_ARCHIVE_ENTRIES = HARD_SKILL_ARCHIVE_POLICY.maxFileCount;
var CreatorSkillArchiveError = class extends Error {
  code;
  issues;
  constructor(code, message, issues = []) {
    super(message);
    this.name = "CreatorSkillArchiveError";
    this.code = code;
    this.issues = issues;
  }
};
function issue(code, path, message, field, suggestion, severity = "error") {
  return {
    code,
    severity,
    path,
    ...field ? { field } : {},
    message,
    ...suggestion ? { suggestion } : {}
  };
}
async function prepareSafeExtractionPath(destination, outputPath, archivePath) {
  const destinationStat = await lstat(destination).catch(() => void 0);
  if (!destinationStat?.isDirectory() || destinationStat.isSymbolicLink()) {
    throw new CreatorSkillArchiveError(
      "invalid_skill_archive",
      "Archive extraction staging directory is unsafe",
      [issue("unsafe_extraction_target", archivePath, "Extraction staging directory must be a real directory")]
    );
  }
  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true, mode: 493 });
  const canonicalDestination = await realpath(destination);
  const canonicalParent = await realpath(parent);
  const outsideDestination = relative(canonicalDestination, canonicalParent);
  if (outsideDestination === ".." || outsideDestination.startsWith(`..${sep}`) || resolve(canonicalDestination, outsideDestination) !== canonicalParent) {
    throw new CreatorSkillArchiveError(
      "invalid_skill_archive",
      "Archive extraction escaped the staging directory",
      [issue("path_traversal", archivePath, "Unsafe extraction target")]
    );
  }
  const relativeParent = relative(destination, parent);
  let current = destination;
  for (const segment of relativeParent.split(sep).filter(Boolean)) {
    current = join(current, segment);
    const currentStat = await lstat(current).catch(() => void 0);
    if (!currentStat?.isDirectory() || currentStat.isSymbolicLink()) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "Archive extraction encountered a link or non-directory ancestor",
        [issue("unsafe_extraction_target", archivePath, "Extraction target contains an unsafe ancestor")]
      );
    }
  }
}
function effectivePolicy(policy) {
  const candidate = policy ?? DEFAULT_SKILL_ARCHIVE_POLICY;
  const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback;
  return {
    version: candidate.version || DEFAULT_SKILL_ARCHIVE_POLICY.version,
    maxArchiveBytes: Math.min(
      positive(candidate.maxArchiveBytes, DEFAULT_SKILL_ARCHIVE_POLICY.maxArchiveBytes),
      HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes
    ),
    maxFileCount: Math.min(
      positive(candidate.maxFileCount, DEFAULT_SKILL_ARCHIVE_POLICY.maxFileCount),
      HARD_SKILL_ARCHIVE_POLICY.maxFileCount
    ),
    maxFileBytes: Math.min(
      positive(candidate.maxFileBytes, DEFAULT_SKILL_ARCHIVE_POLICY.maxFileBytes),
      HARD_SKILL_ARCHIVE_POLICY.maxFileBytes
    ),
    maxExpandedBytes: Math.min(
      positive(candidate.maxExpandedBytes, DEFAULT_SKILL_ARCHIVE_POLICY.maxExpandedBytes),
      HARD_SKILL_ARCHIVE_POLICY.maxExpandedBytes
    )
  };
}
function isPackagingNoise(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "__MACOSX") return true;
  const name = parts.at(-1) ?? "";
  return name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");
}
function normalizeArchivePath(rawPath) {
  if (!rawPath || rawPath.includes("\0")) {
    throw new CreatorSkillArchiveError(
      "invalid_skill_archive",
      "Archive contains an empty or NUL path",
      [issue("invalid_path", "", "Archive path is empty or contains a NUL byte")]
    );
  }
  const separated = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  if (separated.startsWith("/") || separated.startsWith("//") || /^[a-zA-Z]:/.test(separated)) {
    throw new CreatorSkillArchiveError(
      "invalid_skill_archive",
      "Archive contains an absolute path",
      [issue("absolute_path", rawPath, "Absolute archive paths are not allowed")]
    );
  }
  const trailingSlash = separated.endsWith("/");
  const parts = separated.split("/").filter((part, index, all) => !(part === "" && index === all.length - 1));
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "Archive contains path traversal",
        [issue("path_traversal", rawPath, "Archive paths cannot contain '.' or '..' segments")]
      );
    }
    if (part.endsWith(" ") || part.endsWith(".")) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "Archive contains an ambiguous path",
        [issue("ambiguous_path", rawPath, "Path segments cannot end with a space or dot")]
      );
    }
    if (/[<>:"|?*\u0001-\u001F]/u.test(part)) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "Archive contains a path that is invalid on Windows",
        [issue("invalid_windows_path", rawPath, "Path segments cannot contain Windows-invalid characters")]
      );
    }
    if (WINDOWS_RESERVED_NAME.test(part)) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "Archive contains a Windows reserved path",
        [issue("windows_reserved_name", rawPath, `'${part}' is a Windows reserved name`)]
      );
    }
  }
  const normalized = parts.map((part) => part.normalize("NFC")).join("/");
  return trailingSlash ? `${normalized}/` : normalized;
}
function entryKind(entry) {
  const mode = entry.externalFileAttributes >>> 16 & 65535;
  const unixType = mode & 61440;
  if (unixType === 40960) return "link";
  if (unixType !== 0 && unixType !== 32768 && unixType !== 16384) {
    return "special";
  }
  if (entry.fileName.endsWith("/") || unixType === 16384 || (entry.externalFileAttributes & 16) === 16) {
    return "directory";
  }
  return "file";
}
function inspectArchiveDirectory(rawEntries, policy, slug) {
  let fileCount = 0;
  let declaredExpandedBytes = 0;
  const warnings = [];
  const normalizedEntries = [];
  const exactPaths = /* @__PURE__ */ new Map();
  const portablePaths = /* @__PURE__ */ new Map();
  const pathKinds = /* @__PURE__ */ new Map();
  for (const entry of rawEntries) {
    const normalizedPath = normalizeArchivePath(entry.fileName);
    const kind = entryKind(entry);
    if (kind === "link" || kind === "special") {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "Archive contains a link or special file",
        [issue("unsupported_entry_type", normalizedPath, "Only regular files and directories are allowed")]
      );
    }
    const directory = kind === "directory";
    const ignored = isPackagingNoise(normalizedPath);
    if (ignored) {
      warnings.push(issue(
        "packaging_noise_removed",
        normalizedPath.replace(/\/$/, ""),
        "Known packaging noise was ignored",
        void 0,
        void 0,
        "warning"
      ));
      normalizedEntries.push({ entry, normalizedPath, directory, ignored });
      continue;
    }
    if (!directory) {
      fileCount += 1;
      declaredExpandedBytes += entry.uncompressedSize;
      if (fileCount > policy.maxFileCount) {
        throw new CreatorSkillArchiveError(
          "archive_policy_exceeded",
          "ZIP contains too many files",
          [issue("max_file_count_exceeded", normalizedPath, `Archive must contain at most ${policy.maxFileCount} files`)]
        );
      }
      if (entry.uncompressedSize > policy.maxFileBytes) {
        throw new CreatorSkillArchiveError(
          "archive_policy_exceeded",
          "ZIP contains a file over the size limit",
          [issue("max_file_bytes_exceeded", normalizedPath, `File must be at most ${policy.maxFileBytes} bytes`)]
        );
      }
      if (declaredExpandedBytes > policy.maxExpandedBytes) {
        throw new CreatorSkillArchiveError(
          "archive_policy_exceeded",
          "ZIP expands beyond the size policy",
          [issue("max_expanded_bytes_exceeded", normalizedPath, `Expanded archive must be at most ${policy.maxExpandedBytes} bytes`)]
        );
      }
    }
    const comparable = normalizedPath.replace(/\/$/, "");
    const exactPrevious = exactPaths.get(comparable);
    if (exactPrevious) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "ZIP contains duplicate normalized paths",
        [issue("duplicate_path", comparable, `Conflicts with '${exactPrevious}'`)]
      );
    }
    exactPaths.set(comparable, entry.fileName);
    pathKinds.set(comparable, directory ? "directory" : "file");
    const portable = comparable.toLocaleLowerCase("en-US");
    const portablePrevious = portablePaths.get(portable);
    if (portablePrevious) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "ZIP contains case or Unicode normalization conflicts",
        [issue("portable_path_conflict", comparable, `Conflicts with '${portablePrevious}'`)]
      );
    }
    portablePaths.set(portable, comparable);
    normalizedEntries.push({ entry, normalizedPath, directory, ignored });
  }
  for (const [normalizedPath] of pathKinds) {
    const parts = normalizedPath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join("/");
      if (pathKinds.get(parent) === "file") {
        throw new CreatorSkillArchiveError(
          "invalid_skill_archive",
          "ZIP contains a file and directory type conflict",
          [issue(
            "path_type_conflict",
            normalizedPath,
            `'${parent}' is a file but is also used as a directory`
          )]
        );
      }
    }
  }
  const businessEntries = normalizedEntries.filter((entry) => !entry.ignored);
  const roots = new Set(
    businessEntries.map((entry) => entry.normalizedPath.replace(/\/$/, "").split("/")[0]).filter(Boolean)
  );
  if (roots.size !== 1 || !roots.has(slug)) {
    throw new CreatorSkillArchiveError(
      "invalid_skill_archive",
      "ZIP must contain exactly one root directory matching the Skill slug",
      [issue("root_directory_mismatch", "", `Expected the only root directory to be '${slug}'`)]
    );
  }
  const fileEntries = businessEntries.filter((entry) => !entry.directory);
  const skillFiles = fileEntries.filter((entry) => basename(entry.normalizedPath).normalize("NFC").toLocaleLowerCase("en-US") === "skill.md");
  if (skillFiles.length !== 1 || skillFiles[0]?.normalizedPath !== `${slug}/SKILL.md`) {
    throw new CreatorSkillArchiveError(
      "invalid_skill_archive",
      "ZIP must contain exactly one canonical root SKILL.md",
      [issue(
        "skill_file_count",
        `${slug}/SKILL.md`,
        "Exactly one SKILL.md basename is allowed and it must be at the package root"
      )]
    );
  }
  for (const archiveEntry of businessEntries) {
    const relative2 = archiveEntry.normalizedPath.replace(/\/$/, "").slice(slug.length + 1);
    if (!relative2) continue;
    const allowed = relative2 === "SKILL.md" || relative2 === "icon.png" || relative2 === "references" || relative2.startsWith("references/");
    if (!allowed) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "ZIP contains a file outside the allowed Skill structure",
        [issue("unexpected_skill_path", archiveEntry.normalizedPath, "Only SKILL.md, icon.png, and references/ are allowed")]
      );
    }
    if (relative2 === "icon.png" && archiveEntry.directory || relative2 === "references" && !archiveEntry.directory) {
      throw new CreatorSkillArchiveError(
        "invalid_skill_archive",
        "ZIP contains a file or directory with the wrong type",
        [issue(
          "skill_structure_type_mismatch",
          archiveEntry.normalizedPath,
          relative2 === "icon.png" ? "icon.png must be a regular file" : "references must be a directory"
        )]
      );
    }
  }
  return { normalizedEntries, warnings };
}
function openZip(archivePath) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(archivePath, {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      strictFileNames: false,
      validateEntrySizes: true
    }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(new CreatorSkillArchiveError(
          "invalid_skill_archive",
          "Archive is not a valid ZIP",
          [issue("invalid_zip", "", error?.message ?? "Unable to open ZIP archive")]
        ));
      } else {
        resolvePromise(zipFile);
      }
    });
  });
}
function readEntries(zipFile, maxEntries = HARD_MAX_ARCHIVE_ENTRIES) {
  return new Promise((resolvePromise, reject) => {
    const entries = [];
    let settled = false;
    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const fail = (error) => {
      const traversalRejected = /invalid relative path|absolute path|\.\./i.test(error.message);
      rejectOnce(new CreatorSkillArchiveError(
        "invalid_skill_archive",
        traversalRejected ? "Archive contains path traversal" : "Unable to read ZIP directory",
        [issue(
          traversalRejected ? "path_traversal" : "invalid_zip",
          "",
          traversalRejected ? "Archive paths cannot contain '.' or '..' segments" : error.message
        )]
      ));
    };
    zipFile.once("error", fail);
    zipFile.on("entry", (entry) => {
      if (settled) return;
      if (entries.length >= maxEntries) {
        zipFile.removeListener("error", fail);
        rejectOnce(new CreatorSkillArchiveError(
          "archive_policy_exceeded",
          "ZIP contains too many central-directory entries",
          [issue(
            "max_entry_count_exceeded",
            entry.fileName,
            `Archive must contain at most ${maxEntries} total files and directories`
          )]
        ));
        return;
      }
      entries.push(entry);
      zipFile.readEntry();
    });
    zipFile.once("end", () => {
      if (settled) return;
      settled = true;
      zipFile.removeListener("error", fail);
      resolvePromise(entries);
    });
    if (zipFile.entryCount > maxEntries) {
      rejectOnce(new CreatorSkillArchiveError(
        "archive_policy_exceeded",
        "ZIP contains too many central-directory entries",
        [issue(
          "max_entry_count_exceeded",
          "",
          `Archive must contain at most ${maxEntries} total files and directories`
        )]
      ));
      return;
    }
    zipFile.readEntry();
  });
}
function readEntry(zipFile, entry, maxBytes) {
  return new Promise((resolvePromise, reject) => {
    zipFile.openReadStream(entry, (openError, stream) => {
      if (openError || !stream) {
        reject(new CreatorSkillArchiveError(
          "invalid_skill_archive",
          "Unable to decompress archive entry",
          [issue("entry_read_failed", entry.fileName, openError?.message ?? "No entry stream")]
        ));
        return;
      }
      const chunks = [];
      let size = 0;
      stream.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          stream.destroy(new CreatorSkillArchiveError(
            "archive_policy_exceeded",
            "Archive entry exceeds the size policy",
            [issue("max_file_bytes_exceeded", entry.fileName, "File exceeds the configured size limit")]
          ));
          return;
        }
        chunks.push(chunk);
      });
      stream.once("error", reject);
      stream.once("end", () => resolvePromise(Buffer.concat(chunks, size)));
    });
  });
}
function startsWith(buffer, prefix) {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}
function isNestedArchive(path, data) {
  const lower = path.toLowerCase();
  if (NESTED_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  if (startsWith(data, Buffer.from([80, 75, 3, 4])) || startsWith(data, Buffer.from([80, 75, 5, 6])) || startsWith(data, Buffer.from([80, 75, 7, 8]))) {
    return true;
  }
  return data.length >= 262 && data.subarray(257, 262).toString("ascii") === "ustar";
}
function isExecutableBinary(data) {
  return EXECUTABLE_MAGICS.some((magic) => startsWith(data, magic));
}
function pngCrc32(type, data) {
  let crc = 4294967295;
  for (const part of [type, data]) {
    for (const byte of part) {
      crc = CRC32_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
    }
  }
  return (crc ^ 4294967295) >>> 0;
}
function invalidPngIcon(path, message) {
  return new CreatorSkillArchiveError(
    "invalid_skill_archive",
    "icon.png is not a valid PNG image",
    [issue("invalid_icon_format", path, message)]
  );
}
function pngPasses(width, height, interlace) {
  if (interlace === 0) return [{ width, height }];
  const adam7Passes = [
    [0, 0, 8, 8],
    [4, 0, 8, 8],
    [0, 4, 4, 8],
    [2, 0, 4, 4],
    [0, 2, 2, 4],
    [1, 0, 2, 2],
    [0, 1, 1, 2]
  ];
  return adam7Passes.map(([startX, startY, stepX, stepY]) => ({
    width: width <= startX ? 0 : Math.ceil((width - startX) / stepX),
    height: height <= startY ? 0 : Math.ceil((height - startY) / stepY)
  })).filter((pass) => pass.width > 0 && pass.height > 0);
}
function validatePngIcon(data, path) {
  if (!startsWith(data, PNG_SIGNATURE)) {
    throw invalidPngIcon(path, "The package icon must be a PNG file");
  }
  let offset = PNG_SIGNATURE.length;
  let chunkCount = 0;
  let seenHeader = false;
  let seenPalette = false;
  let seenImageData = false;
  let imageDataEnded = false;
  let seenEnd = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let paletteEntries = 0;
  const imageData = [];
  while (offset < data.length) {
    chunkCount += 1;
    if (chunkCount > MAX_PNG_CHUNKS) {
      throw invalidPngIcon(path, `PNG must contain at most ${MAX_PNG_CHUNKS} chunks`);
    }
    if (seenEnd || data.length - offset < 12) {
      throw invalidPngIcon(path, "PNG contains trailing or truncated chunk data");
    }
    const length = data.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > data.length) {
      throw invalidPngIcon(path, "PNG contains a truncated chunk");
    }
    const type = data.subarray(offset + 4, offset + 8);
    const typeName = type.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(typeName)) {
      throw invalidPngIcon(path, "PNG contains an invalid chunk type");
    }
    const chunkData = data.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = data.readUInt32BE(offset + 8 + length);
    if (pngCrc32(type, chunkData) !== expectedCrc) {
      throw invalidPngIcon(path, `PNG chunk ${typeName} failed its CRC check`);
    }
    if (!seenHeader && typeName !== "IHDR") {
      throw invalidPngIcon(path, "PNG must start with an IHDR chunk");
    }
    if (typeName === "IHDR") {
      if (seenHeader || length !== 13) {
        throw invalidPngIcon(path, "PNG must contain one 13-byte IHDR chunk");
      }
      seenHeader = true;
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
      const compression = chunkData[10];
      const filter = chunkData[11];
      interlace = chunkData[12];
      const allowedDepths = PNG_ALLOWED_BIT_DEPTHS.get(colorType);
      if (width === 0 || height === 0 || width > MAX_ICON_DIMENSION || height > MAX_ICON_DIMENSION || width * height > MAX_ICON_PIXELS) {
        throw invalidPngIcon(
          path,
          `PNG dimensions must be within ${MAX_ICON_DIMENSION}\xD7${MAX_ICON_DIMENSION} and ${MAX_ICON_PIXELS} pixels`
        );
      }
      if (!allowedDepths?.has(bitDepth) || compression !== 0 || filter !== 0 || interlace !== 0 && interlace !== 1) {
        throw invalidPngIcon(path, "PNG uses unsupported or invalid image parameters");
      }
    } else if (typeName === "PLTE") {
      if (seenPalette || seenImageData || length === 0 || length > 768 || length % 3 !== 0) {
        throw invalidPngIcon(path, "PNG contains an invalid PLTE chunk");
      }
      seenPalette = true;
      paletteEntries = length / 3;
    } else if (typeName === "IDAT") {
      if (imageDataEnded) {
        throw invalidPngIcon(path, "PNG IDAT chunks must be consecutive");
      }
      seenImageData = true;
      imageData.push(chunkData);
    } else if (typeName === "IEND") {
      if (!seenImageData || length !== 0) {
        throw invalidPngIcon(path, "PNG must end with an empty IEND chunk after image data");
      }
      seenEnd = true;
    } else {
      if (seenImageData) imageDataEnded = true;
      if ((type[0] & 32) === 0) {
        throw invalidPngIcon(path, `PNG contains unsupported critical chunk ${typeName}`);
      }
    }
    offset = chunkEnd;
  }
  if (!seenHeader || !seenImageData || !seenEnd || offset !== data.length) {
    throw invalidPngIcon(path, "PNG is incomplete or missing its IEND chunk");
  }
  if (colorType === 3 && (!seenPalette || paletteEntries > 2 ** bitDepth)) {
    throw invalidPngIcon(path, "Indexed PNG images require a valid palette");
  }
  if ((colorType === 0 || colorType === 4) && seenPalette) {
    throw invalidPngIcon(path, "Grayscale PNG images cannot contain a palette");
  }
  const channels = PNG_CHANNELS.get(colorType);
  const bitsPerPixel = channels * bitDepth;
  const passes = pngPasses(width, height, interlace);
  const decodedBytes = passes.reduce((total, pass) => total + pass.height * (1 + Math.ceil(pass.width * bitsPerPixel / 8)), 0);
  if (decodedBytes > MAX_ICON_DECODED_BYTES) {
    throw invalidPngIcon(path, "PNG decoded data exceeds the resource limit");
  }
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(imageData), {
      maxOutputLength: decodedBytes
    });
  } catch {
    throw invalidPngIcon(path, "PNG image data could not be decoded safely");
  }
  if (decoded.length !== decodedBytes) {
    throw invalidPngIcon(path, "PNG decoded data length does not match its dimensions");
  }
  let decodedOffset = 0;
  for (const pass of passes) {
    const rowBytes = Math.ceil(pass.width * bitsPerPixel / 8);
    for (let row = 0; row < pass.height; row += 1) {
      if (decoded[decodedOffset] > 4) {
        throw invalidPngIcon(path, "PNG contains an invalid scanline filter");
      }
      decodedOffset += 1 + rowBytes;
    }
  }
}
function isEmojiIcon(value) {
  if (/^https?:\/\//i.test(value) || value.includes("/") || value.includes("\\")) return false;
  if (value.length > 64 || !/\p{Extended_Pictographic}/u.test(value)) return false;
  return value.replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0F\u200D\s]/gu, "").length === 0;
}
function canonicalManifestJson(manifest) {
  return JSON.stringify(manifest.map((entry) => ({
    path: entry.path,
    size: entry.size,
    sha256: entry.sha256
  })));
}
function calculateContentDigest(manifest) {
  return createHash("sha256").update(canonicalManifestJson(manifest), "utf8").digest("hex");
}
function sortManifest(entries) {
  return entries.sort((left, right) => Buffer.from(left.path, "utf8").compare(Buffer.from(right.path, "utf8")));
}
function compareExpectedManifest(actual, expected) {
  if (!expected) return;
  const normalizedExpected = sortManifest(expected.map((entry) => ({
    path: entry.path.normalize("NFC").replace(/\\/g, "/"),
    size: entry.size,
    sha256: entry.sha256.toLowerCase()
  })));
  if (canonicalManifestJson(actual) !== canonicalManifestJson(normalizedExpected)) {
    throw new CreatorSkillArchiveError(
      "content_digest_mismatch",
      "Extracted files do not match the published manifest",
      [issue("manifest_mismatch", "", "File paths, sizes, or hashes differ from the published manifest")]
    );
  }
}
async function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolvePromise(hash.digest("hex")));
  });
}
async function preflightCreatorSkillArchive(args) {
  const policy = effectivePolicy(args.policy);
  const archiveStats = await stat(args.archivePath);
  if (!archiveStats.isFile() || archiveStats.size > policy.maxArchiveBytes) {
    throw new CreatorSkillArchiveError(
      "archive_policy_exceeded",
      "ZIP exceeds the archive size policy",
      [issue("max_archive_bytes_exceeded", "", `Archive must be at most ${policy.maxArchiveBytes} bytes`)]
    );
  }
  const archiveChecksum = await sha256File(args.archivePath);
  const zipFile = await openZip(args.archivePath);
  try {
    const rawEntries = await readEntries(zipFile);
    const { warnings } = inspectArchiveDirectory(rawEntries, policy, args.slug);
    return { archiveChecksum, warnings };
  } finally {
    zipFile.close();
  }
}
async function validateCreatorSkillArchive(args) {
  const policy = effectivePolicy(args.policy);
  const archiveStats = await stat(args.archivePath);
  if (!archiveStats.isFile() || archiveStats.size > policy.maxArchiveBytes) {
    throw new CreatorSkillArchiveError(
      "archive_policy_exceeded",
      "ZIP exceeds the archive size policy",
      [issue("max_archive_bytes_exceeded", "", `Archive must be at most ${policy.maxArchiveBytes} bytes`)]
    );
  }
  const archiveChecksum = await sha256File(args.archivePath);
  if (args.expectedArchiveChecksum && archiveChecksum !== args.expectedArchiveChecksum.toLowerCase()) {
    throw new CreatorSkillArchiveError(
      "checksum_mismatch",
      "Downloaded ZIP checksum does not match the published version",
      [issue("archive_checksum_mismatch", "", "The downloaded object failed its SHA-256 check")]
    );
  }
  const zipFile = await openZip(args.archivePath);
  try {
    const rawEntries = await readEntries(zipFile);
    const { normalizedEntries, warnings } = inspectArchiveDirectory(
      rawEntries,
      policy,
      args.slug
    );
    const businessEntries = normalizedEntries.filter((entry) => !entry.ignored);
    const manifest = [];
    let metadata;
    let expandedBytes = 0;
    const destination = args.destinationRoot ? resolve(args.destinationRoot) : void 0;
    if (destination) await mkdir(destination, { recursive: true });
    for (const archiveEntry of businessEntries) {
      if (archiveEntry.directory) {
        if (destination) {
          const outputDir = resolve(destination, archiveEntry.normalizedPath.replace(/\/$/, ""));
          if (!outputDir.startsWith(`${destination}${sep}`) && outputDir !== destination) {
            throw new CreatorSkillArchiveError(
              "invalid_skill_archive",
              "Archive extraction escaped the staging directory",
              [issue("path_traversal", archiveEntry.normalizedPath, "Unsafe extraction target")]
            );
          }
          await prepareSafeExtractionPath(destination, outputDir, archiveEntry.normalizedPath);
          await mkdir(outputDir, { recursive: true, mode: 493 });
          const outputDirStat = await lstat(outputDir).catch(() => void 0);
          if (!outputDirStat?.isDirectory() || outputDirStat.isSymbolicLink()) {
            throw new CreatorSkillArchiveError(
              "invalid_skill_archive",
              "Archive extraction encountered an unsafe directory",
              [issue("unsafe_extraction_target", archiveEntry.normalizedPath, "Extraction target must be a real directory")]
            );
          }
          await chmod(outputDir, 493);
        }
        continue;
      }
      const data = await readEntry(zipFile, archiveEntry.entry, policy.maxFileBytes);
      expandedBytes += data.length;
      if (expandedBytes > policy.maxExpandedBytes) {
        throw new CreatorSkillArchiveError(
          "archive_policy_exceeded",
          "ZIP expands beyond the size policy",
          [issue("max_expanded_bytes_exceeded", archiveEntry.normalizedPath, "Expanded data exceeded the configured limit")]
        );
      }
      if (isNestedArchive(archiveEntry.normalizedPath, data)) {
        throw new CreatorSkillArchiveError(
          "invalid_skill_archive",
          "Nested archives are not allowed",
          [issue("nested_archive", archiveEntry.normalizedPath, "ZIP and TAR payloads cannot be bundled inside a Creator Skill")]
        );
      }
      if (isExecutableBinary(data)) {
        throw new CreatorSkillArchiveError(
          "invalid_skill_archive",
          "Executable binaries are not allowed",
          [issue("executable_binary", archiveEntry.normalizedPath, "ELF, PE, and Mach-O binaries are rejected")]
        );
      }
      if (archiveEntry.normalizedPath === `${args.slug}/icon.png`) {
        validatePngIcon(data, archiveEntry.normalizedPath);
      }
      if (archiveEntry.normalizedPath === `${args.slug}/SKILL.md`) {
        const content = data.toString("utf8");
        const contentValidation = validateCreatorSkillContent(content, args.slug);
        if (!contentValidation.valid) {
          throw new CreatorSkillArchiveError(
            "skill_validation_failed",
            "SKILL.md validation failed",
            contentValidation.errors.map((error) => issue(
              "invalid_skill_content",
              "SKILL.md",
              error.message,
              error.path,
              error.suggestion
            ))
          );
        }
        const parsed = readValidatedSkillMetadata(content, args.slug);
        if (!parsed) {
          throw new CreatorSkillArchiveError(
            "skill_validation_failed",
            "SKILL.md validation failed"
          );
        }
        if (parsed.metadata.icon && !isEmojiIcon(parsed.metadata.icon)) {
          throw new CreatorSkillArchiveError(
            "skill_validation_failed",
            "Creator Skill icon must be an emoji",
            [issue(
              "invalid_creator_icon",
              "SKILL.md",
              "Creator Skill frontmatter icon must be an emoji, not a URL or file path",
              "icon"
            )]
          );
        }
        metadata = parsed.metadata;
      }
      const relativePath = archiveEntry.normalizedPath.slice(args.slug.length + 1);
      manifest.push({
        path: relativePath,
        size: data.length,
        sha256: createHash("sha256").update(data).digest("hex")
      });
      if (destination) {
        const outputPath = resolve(destination, archiveEntry.normalizedPath);
        if (!outputPath.startsWith(`${destination}${sep}`)) {
          throw new CreatorSkillArchiveError(
            "invalid_skill_archive",
            "Archive extraction escaped the staging directory",
            [issue("path_traversal", archiveEntry.normalizedPath, "Unsafe extraction target")]
          );
        }
        await prepareSafeExtractionPath(destination, outputPath, archiveEntry.normalizedPath);
        await writeFile(outputPath, data, { mode: 420, flag: "wx" });
        const outputStat = await lstat(outputPath).catch(() => void 0);
        if (!outputStat?.isFile() || outputStat.isSymbolicLink()) {
          throw new CreatorSkillArchiveError(
            "invalid_skill_archive",
            "Archive extraction encountered an unsafe file",
            [issue("unsafe_extraction_target", archiveEntry.normalizedPath, "Extraction target must be a regular file")]
          );
        }
        await chmod(outputPath, 420);
      }
    }
    if (!metadata) {
      throw new CreatorSkillArchiveError(
        "skill_validation_failed",
        "SKILL.md metadata was not produced"
      );
    }
    sortManifest(manifest);
    compareExpectedManifest(manifest, args.expectedManifest);
    const contentDigest = calculateContentDigest(manifest);
    if (args.expectedContentDigest && contentDigest !== args.expectedContentDigest.toLowerCase()) {
      throw new CreatorSkillArchiveError(
        "content_digest_mismatch",
        "Extracted content digest does not match the published version",
        [issue("content_digest_mismatch", "", "Canonical manifest digest differs from the published digest")]
      );
    }
    return {
      archiveChecksum,
      contentDigest,
      manifest,
      metadata,
      warnings,
      expandedBytes
    };
  } finally {
    zipFile.close();
  }
}
async function scanCreatorSkillDirectory(skillDirectory) {
  const root = resolve(skillDirectory);
  const manifest = [];
  let fileCount = 0;
  let totalBytes = 0;
  const scan = async (directory, relativeDirectory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative2 = relativeDirectory ? `${relativeDirectory}/${entry.name.normalize("NFC")}` : entry.name.normalize("NFC");
      const fullPath = join(directory, entry.name);
      const fileStat = await lstat(fullPath);
      if (fileStat.isSymbolicLink() || !fileStat.isDirectory() && !fileStat.isFile()) {
        throw new CreatorSkillArchiveError(
          "content_digest_mismatch",
          "Installed Skill contains a link or special file",
          [issue("local_type_mismatch", relative2, "Only regular files and directories are expected")]
        );
      }
      if (fileStat.isDirectory()) {
        await scan(fullPath, relative2);
      } else {
        fileCount += 1;
        totalBytes += fileStat.size;
        if (fileCount > HARD_SKILL_ARCHIVE_POLICY.maxFileCount || fileStat.size > HARD_SKILL_ARCHIVE_POLICY.maxFileBytes || totalBytes > HARD_SKILL_ARCHIVE_POLICY.maxExpandedBytes) {
          throw new CreatorSkillArchiveError(
            "content_digest_mismatch",
            "Installed Skill exceeds the local integrity scan limits",
            [issue(
              "local_policy_exceeded",
              relative2,
              "The installed Skill exceeds an absolute file count or size limit"
            )]
          );
        }
        const fileHash = await sha256File(fullPath);
        const afterHashStat = await lstat(fullPath);
        if (!afterHashStat.isFile() || afterHashStat.size !== fileStat.size || afterHashStat.mtimeMs !== fileStat.mtimeMs) {
          throw new CreatorSkillArchiveError(
            "content_digest_mismatch",
            "Installed Skill changed during the integrity scan",
            [issue("local_scan_race", relative2, "The file changed while it was being checked")]
          );
        }
        manifest.push({
          path: relative2,
          size: fileStat.size,
          sha256: fileHash
        });
      }
    }
  };
  await scan(root, "");
  sortManifest(manifest);
  return { manifest, contentDigest: calculateContentDigest(manifest) };
}
async function directorySize(path) {
  const pathStat = await lstat(path);
  if (pathStat.isFile()) return pathStat.size;
  if (!pathStat.isDirectory()) return 0;
  const entries = await readdir(path);
  let total = 0;
  for (const entry of entries) total += await directorySize(join(path, entry));
  return total;
}
function creatorSkillBackupTimestamp(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}
function inferBackupCreatedAt(path) {
  const name = basename(path);
  const candidate = name.replace(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    "$1:$2:$3.$4"
  );
  return Number.isNaN(Date.parse(candidate)) ? (/* @__PURE__ */ new Date(0)).toISOString() : candidate;
}
function hasArchiveLikeExtension(path) {
  const lower = path.toLowerCase();
  return NESTED_ARCHIVE_EXTENSIONS.some((extension) => lower.endsWith(extension)) || extname(lower) === ".gz";
}
export {
  CreatorSkillArchiveError,
  calculateContentDigest,
  canonicalManifestJson,
  creatorSkillBackupTimestamp,
  directorySize,
  hasArchiveLikeExtension,
  inferBackupCreatedAt,
  preflightCreatorSkillArchive,
  scanCreatorSkillDirectory,
  validateCreatorSkillArchive
};
