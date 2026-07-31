// packages/shared/src/creator-skills/installer.ts
import {
  createHash as createHash2,
  randomBytes,
  randomUUID,
  timingSafeEqual
} from "node:crypto";
import {
  access,
  cp,
  lstat as lstat2,
  mkdir as mkdir3,
  open as open2,
  readFile as readFile3,
  readdir as readdir2,
  realpath as realpath2,
  rename as rename2,
  rm as rm2,
  stat as stat2,
  writeFile as writeFile2
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename as basename2, dirname as dirname3, join as join3, resolve as resolve2, sep as sep2 } from "node:path";

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

// packages/shared/src/creator-skills/ledger.ts
import {
  mkdir as mkdir2,
  open,
  readFile as readFile2,
  rename,
  rm
} from "node:fs/promises";
import { dirname as dirname2, join as join2 } from "node:path";

// packages/shared/src/creator-skills/schemas.ts
import { z as z2 } from "zod";
var entityId = z2.string().trim().min(1).max(512);
var isoDate = z2.string().datetime({ offset: true });
var checksum = z2.string().trim().transform((value) => value.toLowerCase().replace(/^sha256:/, "")).pipe(z2.string().regex(/^[a-f0-9]{64}$/));
var stableSemver = z2.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
var skillSlug = z2.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
var localSkillBasename = z2.string().min(1).max(255).refine((value) => value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0"));
var idempotencyKey = z2.string().min(1).max(128).regex(/^[\x21-\x7E]+$/);
var CreatorSkillOperationIdSchema = z2.string().uuid();
var nonnegativeSafeInteger = z2.union([
  z2.number().int().nonnegative(),
  z2.string().regex(/^\d+$/).transform((value) => Number(value))
]).refine((value) => Number.isSafeInteger(value) && value >= 0);
function nullableOptional(schema) {
  return schema.nullish().transform((value) => value ?? void 0).optional();
}
var SkillArchivePolicySchema = z2.object({
  version: z2.string().min(1).max(128),
  maxArchiveBytes: z2.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes),
  maxFileCount: z2.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount),
  maxFileBytes: z2.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxFileBytes),
  maxExpandedBytes: z2.number().int().positive().max(HARD_SKILL_ARCHIVE_POLICY.maxExpandedBytes)
});
var SkillValidationIssueSchema = z2.object({
  code: z2.string().min(1).max(128),
  severity: z2.enum(["error", "warning"]),
  path: z2.string().max(4096),
  field: z2.string().max(256).optional(),
  message: z2.string().min(1).max(4096),
  suggestion: z2.string().max(4096).optional()
});
var SkillVersionMetadataSchema = z2.object({
  name: z2.string().min(1).max(512),
  description: z2.string().min(1).max(8192),
  globs: z2.array(z2.string().max(2048)).max(1e3).optional(),
  alwaysAllow: z2.array(z2.string().max(512)).max(1e3).optional(),
  icon: z2.string().max(64).optional(),
  requiredSources: z2.array(z2.string().max(512)).max(1e3).optional()
});
var creatorArtifactBaseSchema = z2.object({
  id: entityId,
  organizationId: entityId,
  name: nullableOptional(z2.string().max(512)),
  summary: nullableOptional(z2.string().max(8192)),
  displayIcon: nullableOptional(z2.discriminatedUnion("kind", [
    z2.object({ kind: z2.literal("emoji"), value: z2.string().min(1).max(64) }),
    z2.object({ kind: z2.literal("image"), url: z2.string().url().max(8192) })
  ])),
  status: z2.enum(["draft", "published", "archived"]),
  latestPublishedVersion: nullableOptional(stableSemver),
  createdByUserId: entityId,
  createdAt: isoDate,
  updatedAt: isoDate,
  archivedAt: nullableOptional(isoDate),
  archivedByUserId: nullableOptional(entityId)
});
var CreatorArtifactSchema = z2.discriminatedUnion("type", [
  creatorArtifactBaseSchema.extend({
    type: z2.literal("web_app"),
    // Legacy Web App slugs are opaque to the desktop client.
    slug: z2.string().trim().min(1).max(512)
  }),
  creatorArtifactBaseSchema.extend({
    type: z2.literal("skill"),
    slug: skillSlug
  })
]);
var CreatorArtifactVersionSchema = z2.object({
  id: entityId,
  artifactId: entityId,
  version: stableSemver,
  changelog: nullableOptional(z2.string().max(2e3)),
  status: z2.enum([
    "upload_pending",
    "uploaded",
    "validating",
    "validation_failed",
    "validated",
    "published",
    "revoked",
    "expired"
  ]),
  archiveChecksum: nullableOptional(checksum),
  contentDigest: nullableOptional(checksum),
  sizeBytes: nullableOptional(nonnegativeSafeInteger),
  createdAt: isoDate,
  publishedAt: nullableOptional(isoDate),
  publishedByUserId: nullableOptional(entityId),
  revokedAt: nullableOptional(isoDate),
  revokedByUserId: nullableOptional(entityId),
  revocationReason: nullableOptional(z2.string().max(2e3)),
  validationPolicy: nullableOptional(SkillArchivePolicySchema),
  uploadGeneration: z2.number().int().nonnegative(),
  validatorVersion: nullableOptional(z2.string().max(128)),
  validatedArchiveChecksum: nullableOptional(checksum),
  validatedAt: nullableOptional(isoDate),
  metadata: nullableOptional(SkillVersionMetadataSchema),
  validationIssues: nullableOptional(z2.array(SkillValidationIssueSchema).max(1e4))
});
var CreatorArtifactCapabilitySchema = z2.object({
  creatorSkillArtifacts: z2.boolean()
});
var CreatorArtifactCatalogPageSchema = z2.object({
  artifacts: z2.array(CreatorArtifactSchema),
  nextCursor: z2.string().max(2048).optional()
});
var CreatorArtifactDetailSchema = z2.object({
  artifact: CreatorArtifactSchema,
  versions: z2.array(CreatorArtifactVersionSchema),
  selectedVersion: nullableOptional(stableSemver),
  // Zod's string max is measured in UTF-16 code units, while the archive
  // policy is expressed in bytes.  Keep the transport boundary aligned with
  // the absolute archive limit and validate the actual UTF-8 representation.
  skillContent: z2.string().superRefine((value, ctx) => {
    if (new TextEncoder().encode(value).byteLength > HARD_SKILL_ARCHIVE_POLICY.maxFileBytes) {
      ctx.addIssue({
        code: z2.ZodIssueCode.too_big,
        origin: "string",
        maximum: HARD_SKILL_ARCHIVE_POLICY.maxFileBytes,
        inclusive: true,
        type: "string",
        message: "SKILL.md exceeds the maximum UTF-8 byte length"
      });
    }
  }).optional(),
  fileTree: z2.array(z2.object({
    path: z2.string().max(4096),
    size: z2.number().int().nonnegative(),
    sha256: checksum.optional()
  })).max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount).optional(),
  reference: z2.object({
    path: z2.string().min(1).max(4096),
    content: z2.string().max(5 * 1024 * 1024).optional(),
    downloadUrl: z2.string().url().max(8192).optional()
  }).optional()
});
var CreatorArtifactMutationResponseSchema = z2.object({
  artifact: CreatorArtifactSchema,
  replayed: z2.boolean().optional()
});
var CreatorArtifactVersionMutationResponseSchema = z2.object({
  version: CreatorArtifactVersionSchema,
  replayed: z2.boolean().optional()
});
var CreatorSkillUploadGrantSchema = z2.object({
  method: z2.literal("PUT"),
  url: z2.string().url().max(8192),
  headers: z2.record(z2.string(), z2.string().max(8192)).optional(),
  expiresAt: isoDate,
  uploadGeneration: z2.number().int().positive()
});
var CreatorArtifactVersionCreatedResponseSchema = z2.object({
  version: CreatorArtifactVersionSchema,
  upload: CreatorSkillUploadGrantSchema,
  replayed: z2.boolean().optional()
});
var CreatorSkillManifestEntrySchema = z2.object({
  path: z2.string().min(1).max(4096),
  size: z2.number().int().nonnegative().max(HARD_SKILL_ARCHIVE_POLICY.maxFileBytes),
  sha256: checksum
});
var CreatorSkillDownloadGrantSchema = z2.object({
  artifactId: entityId,
  organizationId: entityId,
  slug: skillSlug,
  version: stableSemver,
  url: z2.string().url().max(8192),
  expiresAt: isoDate,
  archiveChecksum: checksum,
  contentDigest: checksum,
  manifest: z2.array(CreatorSkillManifestEntrySchema).max(HARD_SKILL_ARCHIVE_POLICY.maxFileCount),
  validationPolicy: SkillArchivePolicySchema
});
var CreatorSkillSafetyStatusSchema = z2.object({
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum,
  status: z2.enum(["active", "revoked", "archived"]),
  safeVersion: stableSemver.optional()
});
var CreatorSkillSafetyStatusBatchSchema = z2.object({
  statuses: z2.array(CreatorSkillSafetyStatusSchema).max(1e3)
});
var InstalledCreatorSkillSchema = z2.object({
  artifactId: entityId,
  organizationId: entityId,
  slug: skillSlug,
  version: stableSemver,
  archiveChecksum: checksum,
  contentDigest: checksum,
  installedAt: isoDate,
  lastKnownStatus: z2.enum(["active", "revoked", "archived"]).optional(),
  lastCheckedAt: isoDate.optional(),
  ignoredVersion: stableSemver.optional()
});
var CreatorSkillsLedgerSchema = z2.object({
  schemaVersion: z2.literal(1),
  installed: z2.array(InstalledCreatorSkillSchema)
});
var CreateCreatorArtifactRpcInputSchema = z2.object({
  organizationId: entityId,
  type: z2.literal("skill"),
  slug: skillSlug,
  idempotencyKey
}).strict();
var CreatorArtifactListRpcInputSchema = z2.object({
  organizationId: entityId,
  type: z2.enum(["web_app", "skill"]).optional(),
  includeDrafts: z2.boolean().optional(),
  cursor: z2.string().max(2048).optional()
}).strict();
var CreatorArtifactIdRpcInputSchema = z2.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver.optional(),
  referencePath: z2.string().min(1).max(4096).regex(
    /^references\/(?!\/)(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))(?!.*\\)(?!.*\/\/).+$/
  ).optional()
}).strict().refine(
  (input) => !input.referencePath || Boolean(input.version),
  { message: "referencePath requires version", path: ["referencePath"] }
);
var CreateCreatorArtifactVersionRpcInputSchema = z2.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
  changelog: z2.string().trim().min(1).max(2e3).optional(),
  idempotencyKey
}).strict();
var CreatorArtifactVersionRpcInputSchema = z2.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
  idempotencyKey
}).strict();
var CreatorArtifactArchiveRpcInputSchema = z2.object({
  organizationId: entityId,
  artifactId: entityId,
  archived: z2.boolean(),
  idempotencyKey
}).strict();
var CreatorArtifactUploadGrantRpcInputSchema = z2.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver,
  idempotencyKey
}).strict();
var CreatorArtifactUploadCompleteRpcInputSchema = CreatorArtifactUploadGrantRpcInputSchema.extend({
  uploadGeneration: z2.number().int().positive(),
  sizeBytes: z2.number().int().nonnegative().max(HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes)
}).strict();
var CreatorArtifactRevokeRpcInputSchema = CreatorArtifactVersionRpcInputSchema.extend({
  reason: z2.string().trim().min(1).max(2e3)
}).strict();
var CreatorSkillDownloadRpcInputSchema = z2.object({
  organizationId: entityId,
  artifactId: entityId,
  version: stableSemver
}).strict();
var CreatorSkillTargetRpcInputSchema = z2.object({
  workspaceId: entityId
}).strict();
var DeleteSkillRpcInputSchema = z2.object({
  workspaceId: entityId,
  skillSlug: localSkillBasename
}).strict();
var CreatorSkillSafetyRpcInputSchema = z2.object({
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum
}).strict();
var CreatorSkillInstallRpcInputSchema = z2.object({
  workspaceId: entityId,
  operationId: CreatorSkillOperationIdSchema,
  grant: CreatorSkillDownloadGrantSchema,
  replaceExisting: z2.boolean().optional(),
  confirmGlobalOverride: z2.boolean().optional(),
  backupLocalChanges: z2.boolean().optional()
}).strict();
var CreatorSkillUninstallRpcInputSchema = z2.object({
  workspaceId: entityId,
  operationId: CreatorSkillOperationIdSchema,
  slug: skillSlug,
  forceDeleteModified: z2.boolean().optional(),
  forceDeleteCredential: z2.string().min(32).max(256).optional()
}).strict();
var CreatorSkillBackupRpcInputSchema = z2.object({
  workspaceId: entityId
}).strict();
var CreatorSkillBackupDeleteRpcInputSchema = z2.object({
  workspaceId: entityId,
  backup: z2.object({
    slug: skillSlug,
    backupId: z2.string().regex(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/
    )
  }).strict().optional()
}).strict();
var CreatorSkillStatusUpdateRpcInputSchema = z2.object({
  workspaceId: entityId,
  status: CreatorSkillSafetyStatusSchema,
  checkedAt: isoDate
}).strict();
var CreatorSkillIgnoreVersionRpcInputSchema = z2.object({
  workspaceId: entityId,
  artifactId: entityId,
  version: stableSemver,
  archiveChecksum: checksum,
  ignoredVersion: stableSemver
}).strict();

// packages/shared/src/creator-skills/ledger.ts
var CREATOR_SKILLS_LEDGER_FILE = "creator-skills.json";
function emptyCreatorSkillsLedger() {
  return { schemaVersion: 1, installed: [] };
}
function isInstalledCreatorSkill(value) {
  return InstalledCreatorSkillSchema.safeParse(value).success;
}
function parseCreatorSkillsLedger(raw) {
  if (!raw || typeof raw !== "object") return emptyCreatorSkillsLedger();
  const record = raw;
  if (record.schemaVersion !== 1 || !Array.isArray(record.installed)) {
    return emptyCreatorSkillsLedger();
  }
  const bySlug = /* @__PURE__ */ new Map();
  for (const item of record.installed) {
    if (isInstalledCreatorSkill(item)) {
      bySlug.set(item.slug, InstalledCreatorSkillSchema.parse(item));
    }
  }
  return {
    schemaVersion: 1,
    installed: [...bySlug.values()].sort((left, right) => left.slug.localeCompare(right.slug))
  };
}
async function readCreatorSkillsLedger(workspaceRoot) {
  try {
    return parseCreatorSkillsLedger(JSON.parse(
      await readFile2(join2(workspaceRoot, CREATOR_SKILLS_LEDGER_FILE), "utf8")
    ));
  } catch {
    return emptyCreatorSkillsLedger();
  }
}
async function writeCreatorSkillsLedger(workspaceRoot, ledger, dependencies = {}) {
  const ledgerPath = join2(workspaceRoot, CREATOR_SKILLS_LEDGER_FILE);
  const ledgerDirectory = dirname2(ledgerPath);
  await mkdir2(ledgerDirectory, { recursive: true });
  const tempPath = `${ledgerPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const normalized = {
    schemaVersion: 1,
    installed: [...ledger.installed].sort((left, right) => left.slug.localeCompare(right.slug))
  };
  let handle;
  try {
    handle = await open(tempPath, "wx", 384);
    await handle.writeFile(`${JSON.stringify(normalized, null, 2)}
`, "utf8");
    await handle.sync();
    await dependencies.onStep?.("temporary_file_synced");
    await handle.close();
    handle = void 0;
    await rename(tempPath, ledgerPath);
    await dependencies.onStep?.("ledger_renamed");
    if (dependencies.syncDirectory) {
      await dependencies.syncDirectory(ledgerDirectory);
    } else {
      const directoryHandle = await open(ledgerDirectory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
    await dependencies.onStep?.("directory_synced");
  } catch (error) {
    await handle?.close().catch(() => {
    });
    await rm(tempPath, { force: true });
    throw error;
  }
}
function replaceLedgerInstallation(ledger, installation) {
  return {
    schemaVersion: 1,
    installed: [
      ...ledger.installed.filter((item) => item.slug !== installation.slug),
      installation
    ]
  };
}
function removeLedgerInstallation(ledger, slug) {
  return {
    schemaVersion: 1,
    installed: ledger.installed.filter((item) => item.slug !== slug)
  };
}

// packages/shared/src/creator-skills/installer.ts
var OP_DIRECTORY = ".creator-skill-ops";
var BACKUP_DIRECTORY = "skill-backups";
var FORCE_DELETE_CREDENTIAL_FILE = ".creator-skill-force-delete.json";
var UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var BACKUP_NAME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
var MAX_JOURNAL_BYTES = 5 * 1024 * 1024;
var MAX_BACKUP_METADATA_BYTES = 16 * 1024;
var MAX_FORCE_DELETE_CREDENTIAL_BYTES = 1024 * 1024;
var FORCE_DELETE_CREDENTIAL_TTL_MS = 10 * 60 * 1e3;
var BACKUP_MANAGEMENT_LOCK = "__creator-skill-backups__";
var LEDGER_MUTATION_LOCK = "__creator-skills-ledger__";
var processQueues = /* @__PURE__ */ new Map();
var cancellationControllers = /* @__PURE__ */ new Map();
function validForceDeleteConfirmation(value) {
  if (!value || typeof value !== "object") return false;
  const confirmation = value;
  return typeof confirmation.artifactId === "string" && confirmation.artifactId.length > 0 && confirmation.artifactId.length <= 512 && typeof confirmation.archiveChecksum === "string" && /^[a-f0-9]{64}$/.test(confirmation.archiveChecksum) && typeof confirmation.directoryIdentity === "string" && /^[0-9]+:[0-9]+:[0-9]+$/.test(confirmation.directoryIdentity) && typeof confirmation.contentFingerprint === "string" && /^[a-f0-9]{64}$/.test(confirmation.contentFingerprint);
}
function errorResult(args) {
  return {
    success: false,
    operationId: args.operationId,
    errorCode: args.errorCode,
    stage: args.stage,
    message: args.message,
    ...args.path ? { path: args.path } : {},
    ...args.conflicts ? { conflicts: args.conflicts } : {},
    ...args.conflictDetails ? { conflictDetails: args.conflictDetails } : {},
    diagnostic: JSON.stringify({
      operationId: args.operationId,
      stage: args.stage,
      errorCode: args.errorCode,
      ...args.path ? { path: args.path } : {}
    }),
    retryable: args.retryable ?? false
  };
}
var SAFE_OPERATION_ERROR_CODES = /* @__PURE__ */ new Set([
  "archive_policy_exceeded",
  "artifact_not_published",
  "artifact_version_revoked",
  "checksum_mismatch",
  "content_digest_mismatch",
  "creator_skill_cancelled",
  "creator_skill_conflict",
  "creator_skill_download_failed",
  "creator_skill_feature_disabled",
  "creator_skill_force_delete_credential_required",
  "creator_skill_force_delete_stale",
  "creator_skill_not_installed",
  "creator_skill_operation_id_conflict",
  "creator_skill_operation_in_progress",
  "invalid_operation_id",
  "invalid_backup_path",
  "invalid_creator_skill_operation_path",
  "invalid_skill_archive",
  "project_skill_conflict",
  "skill_validation_failed"
]);
function safeOperationErrorCode(value, fallback) {
  return typeof value === "string" && SAFE_OPERATION_ERROR_CODES.has(value) ? value : fallback;
}
function exists(path) {
  return access(path).then(() => true, () => false);
}
function cancellationKey(workspaceRoot, ownerId, operationId) {
  return `${workspaceRoot}\0${ownerId}\0${operationId}`;
}
function invalidOperationPath(message) {
  return Object.assign(new Error(message), { code: "invalid_creator_skill_operation_path" });
}
function invalidBackupPath(message) {
  return Object.assign(new Error(message), { code: "invalid_backup_path" });
}
function assertChildPath(parent, candidate, label) {
  if (candidate === parent || !candidate.startsWith(`${parent}${sep2}`)) {
    throw invalidOperationPath(`${label} is outside its allowed directory`);
  }
}
async function canonicalWorkspaceRoot(workspaceRoot) {
  const candidate = resolve2(workspaceRoot);
  const canonical = await realpath2(candidate);
  if (canonical !== candidate) {
    return canonical;
  }
  return candidate;
}
async function lstatIfPresent(path) {
  try {
    return await lstat2(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
async function directoryIdentity(path) {
  const stats = await lstat2(path, { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw Object.assign(new Error("Creator Skill target must be a regular directory"), {
      code: "content_digest_mismatch"
    });
  }
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}
function forceDeleteCredentialPath(workspaceRoot) {
  const path = resolve2(workspaceRoot, FORCE_DELETE_CREDENTIAL_FILE);
  assertChildPath(workspaceRoot, path, "Creator Skill force-delete credential store");
  return path;
}
function validStoredForceDeleteCredential(value) {
  if (!value || typeof value !== "object") return false;
  const credential = value;
  return typeof credential.tokenHash === "string" && /^[a-f0-9]{64}$/.test(credential.tokenHash) && typeof credential.slug === "string" && SKILL_SLUG_PATTERN.test(credential.slug) && typeof credential.artifactId === "string" && credential.artifactId.length > 0 && credential.artifactId.length <= 512 && typeof credential.archiveChecksum === "string" && /^[a-f0-9]{64}$/.test(credential.archiveChecksum) && typeof credential.directoryIdentity === "string" && /^[0-9]+:[0-9]+:[0-9]+$/.test(credential.directoryIdentity) && typeof credential.contentFingerprint === "string" && /^[a-f0-9]{64}$/.test(credential.contentFingerprint) && typeof credential.expiresAt === "string" && !Number.isNaN(Date.parse(credential.expiresAt));
}
async function readForceDeleteCredentialStore(workspaceRoot) {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const path = forceDeleteCredentialPath(canonicalWorkspace);
  const stats = await lstatIfPresent(path);
  if (!stats) return { schemaVersion: 1, credentials: [] };
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > MAX_FORCE_DELETE_CREDENTIAL_BYTES || await realpath2(path) !== path) {
    throw invalidOperationPath("Creator Skill force-delete credential store is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile3(path, "utf8"));
  } catch {
    throw invalidOperationPath("Creator Skill force-delete credential store is invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.credentials) || !parsed.credentials.every(
    validStoredForceDeleteCredential
  )) {
    throw invalidOperationPath("Creator Skill force-delete credential store is invalid");
  }
  const now = Date.now();
  return {
    schemaVersion: 1,
    credentials: parsed.credentials.filter((credential) => Date.parse(credential.expiresAt) > now).slice(-64)
  };
}
async function writeForceDeleteCredentialStore(workspaceRoot, store) {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const path = forceDeleteCredentialPath(canonicalWorkspace);
  const existing = await lstatIfPresent(path);
  if (existing?.isSymbolicLink() || existing && !existing.isFile()) {
    throw invalidOperationPath("Creator Skill force-delete credential store is invalid");
  }
  if (store.credentials.length === 0) {
    await rm2(path, { force: true });
    await syncJournalDirectory(canonicalWorkspace);
    return;
  }
  const tempPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open2(tempPath, "wx", 384);
  try {
    await handle.writeFile(`${JSON.stringify(store, null, 2)}
`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename2(tempPath, path);
    await syncJournalDirectory(canonicalWorkspace);
  } catch (error) {
    await rm2(tempPath, { force: true });
    throw error;
  }
}
function hashForceDeleteCredential(token) {
  return createHash2("sha256").update(token, "utf8").digest("hex");
}
function credentialHashesEqual(left, right) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
async function assertSafeBackupDirectory(path, parent, label) {
  assertChildPath(parent, path, label);
  const pathStats = await lstatIfPresent(path);
  if (!pathStats) return;
  if (pathStats.isSymbolicLink() || !pathStats.isDirectory()) {
    throw invalidBackupPath(`${label} must be a regular directory`);
  }
  const canonical = await realpath2(path);
  if (canonical !== path) {
    throw invalidBackupPath(`${label} cannot resolve through a symbolic link`);
  }
}
async function resolveCreatorSkillBackupTarget(args) {
  if (!SKILL_SLUG_PATTERN.test(args.slug) || !BACKUP_NAME_PATTERN.test(args.backupId)) {
    throw invalidBackupPath("Creator Skill backup identity is invalid");
  }
  const canonicalWorkspace = await canonicalWorkspaceRoot(args.workspaceRoot);
  const backupRoot = resolve2(canonicalWorkspace, BACKUP_DIRECTORY);
  assertChildPath(canonicalWorkspace, backupRoot, "Creator Skill backup root");
  await assertSafeBackupDirectory(
    backupRoot,
    canonicalWorkspace,
    "Creator Skill backup root"
  );
  if (!await lstatIfPresent(backupRoot) && args.createAncestors) {
    await mkdir3(backupRoot, { mode: 448 });
    await assertSafeBackupDirectory(
      backupRoot,
      canonicalWorkspace,
      "Creator Skill backup root"
    );
  }
  const slugBackupRoot = resolve2(backupRoot, args.slug);
  await assertSafeBackupDirectory(
    slugBackupRoot,
    backupRoot,
    "Creator Skill slug backup root"
  );
  if (!await lstatIfPresent(slugBackupRoot) && args.createAncestors) {
    if (!await lstatIfPresent(backupRoot)) {
      throw invalidBackupPath("Creator Skill backup root is unavailable");
    }
    await mkdir3(slugBackupRoot, { mode: 448 });
    await assertSafeBackupDirectory(
      slugBackupRoot,
      backupRoot,
      "Creator Skill slug backup root"
    );
  }
  const targetPath = resolve2(slugBackupRoot, args.backupId);
  assertChildPath(slugBackupRoot, targetPath, "Creator Skill backup target");
  const targetStats = await lstatIfPresent(targetPath);
  if (targetStats) {
    if (targetStats.isSymbolicLink() || !targetStats.isDirectory()) {
      throw invalidBackupPath("Creator Skill backup target must be a regular directory");
    }
    const canonicalTarget = await realpath2(targetPath);
    if (canonicalTarget !== targetPath) {
      throw invalidBackupPath("Creator Skill backup target cannot resolve through a symbolic link");
    }
  }
  return {
    workspaceRoot: canonicalWorkspace,
    backupRoot,
    slugBackupRoot,
    targetPath,
    targetExists: targetStats !== null
  };
}
function backupMetadataPath(targetPath) {
  return `${targetPath}.metadata.json`;
}
function isBackupOperation(value) {
  return value === "modified_update" || value === "update_safety_snapshot" || value === "clean_uninstall_snapshot" || value === "concurrent_recreation";
}
function parseBackupMetadata(raw, expected) {
  if (!raw || typeof raw !== "object") {
    throw invalidBackupPath("Creator Skill backup metadata is invalid");
  }
  const metadata = raw;
  if (metadata.schemaVersion !== 1 || metadata.slug !== expected.slug || metadata.backupId !== expected.backupId || !isBackupOperation(metadata.operation) || typeof metadata.createdAt !== "string" || Number.isNaN(Date.parse(metadata.createdAt)) || metadata.version !== void 0 && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(metadata.version)) {
    throw invalidBackupPath("Creator Skill backup metadata is invalid");
  }
  return metadata;
}
async function readBackupMetadata(args) {
  const metadataPath = backupMetadataPath(args.targetPath);
  assertChildPath(dirname3(args.targetPath), metadataPath, "Creator Skill backup metadata");
  const metadataStats = await lstatIfPresent(metadataPath);
  if (!metadataStats) return null;
  if (metadataStats.isSymbolicLink() || !metadataStats.isFile() || metadataStats.size > MAX_BACKUP_METADATA_BYTES) {
    throw invalidBackupPath("Creator Skill backup metadata must be a small regular file");
  }
  try {
    return parseBackupMetadata(
      JSON.parse(await readFile3(metadataPath, "utf8")),
      { slug: args.slug, backupId: args.backupId }
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "invalid_backup_path") {
      throw error;
    }
    throw invalidBackupPath("Creator Skill backup metadata is invalid JSON");
  }
}
async function writeBackupMetadata(targetPath, metadata) {
  const metadataPath = backupMetadataPath(targetPath);
  assertChildPath(dirname3(targetPath), metadataPath, "Creator Skill backup metadata");
  const existing = await readBackupMetadata({
    targetPath,
    slug: metadata.slug,
    backupId: metadata.backupId
  });
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(metadata)) {
      throw invalidBackupPath("Creator Skill backup metadata conflicts with the operation journal");
    }
    return;
  }
  const tempPath = `${metadataPath}.${randomUUID()}.tmp`;
  await writeFile2(tempPath, `${JSON.stringify(metadata, null, 2)}
`, {
    encoding: "utf8",
    mode: 384,
    flag: "wx"
  });
  try {
    await rename2(tempPath, metadataPath);
  } catch (error) {
    await rm2(tempPath, { force: true });
    throw error;
  }
}
async function allocateCreatorSkillBackupTarget(workspaceRoot, slug) {
  const now = Date.now();
  for (let offset = 0; offset < 1e3; offset += 1) {
    const target = await resolveCreatorSkillBackupTarget({
      workspaceRoot,
      slug,
      backupId: creatorSkillBackupTimestamp(new Date(now + offset)),
      createAncestors: true
    });
    if (!target.targetExists && !await lstatIfPresent(backupMetadataPath(target.targetPath))) {
      return target;
    }
  }
  throw invalidBackupPath("Unable to allocate a unique Creator Skill backup identity");
}
async function ensureOperationRoot(workspaceRoot) {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const candidate = resolve2(canonicalWorkspace, OP_DIRECTORY);
  assertChildPath(canonicalWorkspace, candidate, "Creator Skill operation root");
  await mkdir3(candidate, { recursive: true, mode: 448 });
  const canonicalOperationRoot = await realpath2(candidate);
  if (canonicalOperationRoot !== candidate) {
    throw invalidOperationPath("Creator Skill operation root cannot be a symbolic link");
  }
  assertChildPath(canonicalWorkspace, canonicalOperationRoot, "Creator Skill operation root");
  return {
    workspaceRoot: canonicalWorkspace,
    operationRoot: canonicalOperationRoot
  };
}
async function resolveOperationPath(workspaceRoot, operationId) {
  if (!UUID_PATTERN.test(operationId)) {
    throw Object.assign(new Error("Creator Skill operationId must be a UUID"), {
      code: "invalid_operation_id"
    });
  }
  const roots = await ensureOperationRoot(workspaceRoot);
  const operationPath = resolve2(roots.operationRoot, operationId);
  assertChildPath(roots.operationRoot, operationPath, "Creator Skill operation");
  if (await exists(operationPath)) {
    const canonicalOperationPath = await realpath2(operationPath);
    if (canonicalOperationPath !== operationPath) {
      throw invalidOperationPath("Creator Skill operation directory cannot be a symbolic link");
    }
    assertChildPath(roots.operationRoot, canonicalOperationPath, "Creator Skill operation");
  }
  return { ...roots, operationPath };
}
async function reserveOperationPath(workspaceRoot, operationId) {
  const resolved = await resolveOperationPath(workspaceRoot, operationId);
  try {
    await mkdir3(resolved.operationPath, {
      recursive: false,
      mode: 448
    });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw Object.assign(
        new Error("Creator Skill operationId is already reserved in this workspace"),
        { code: "creator_skill_operation_id_conflict" }
      );
    }
    throw error;
  }
  const canonicalOperationPath = await realpath2(resolved.operationPath);
  if (canonicalOperationPath !== resolved.operationPath) {
    throw invalidOperationPath("Creator Skill operation directory cannot be a symbolic link");
  }
  return resolved;
}
function validateJournalShape(journal, expectedOperationId) {
  const hasAnyBackupMetadata = journal.backupOperation !== void 0 || journal.backupVersion !== void 0 || journal.backupCreatedAt !== void 0;
  const forceDeleteConfirmation = journal.forceDeleteConfirmation;
  const hasValidForceDeleteConfirmation = forceDeleteConfirmation === void 0 || validForceDeleteConfirmation(forceDeleteConfirmation);
  if (!journal || journal.schemaVersion !== 1 || journal.operationId !== expectedOperationId || !UUID_PATTERN.test(journal.operationId) || !SKILL_SLUG_PATTERN.test(journal.slug) || !["install", "uninstall"].includes(journal.action) || ![
    "preparing",
    "prepared",
    "old_backed_up",
    "new_installed",
    "ledger_committed",
    "detaching",
    "committed"
  ].includes(journal.state) || journal.oldLedger !== null && typeof journal.oldLedger !== "string" || (journal.oldLedger?.length ?? 0) > MAX_JOURNAL_BYTES || journal.promotedDirectoryIdentity !== void 0 && !/^[0-9]+:[0-9]+:[0-9]+$/.test(journal.promotedDirectoryIdentity) || !hasValidForceDeleteConfirmation || forceDeleteConfirmation !== void 0 && (journal.action !== "uninstall" || journal.preserveBackupPath !== void 0) || hasAnyBackupMetadata && (!isBackupOperation(journal.backupOperation) || typeof journal.backupCreatedAt !== "string" || Number.isNaN(Date.parse(journal.backupCreatedAt)) || journal.backupVersion !== void 0 && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(journal.backupVersion))) {
    throw invalidOperationPath("Creator Skill recovery journal is invalid");
  }
}
function backupMetadataFromJournal(journal, preserveBackupPath) {
  if (!journal.backupOperation || !journal.backupCreatedAt) return null;
  return {
    schemaVersion: 1,
    slug: journal.slug,
    backupId: basename2(preserveBackupPath),
    operation: journal.backupOperation,
    createdAt: journal.backupCreatedAt,
    ...journal.backupVersion ? { version: journal.backupVersion } : {}
  };
}
async function assertCanonicalPathWhenPresent(path, label) {
  if (!await exists(path)) return;
  const canonical = await realpath2(path);
  if (canonical !== path) {
    throw invalidOperationPath(`${label} cannot be a symbolic link`);
  }
}
async function canonicalizePotentialPath(path) {
  let existingAncestor = resolve2(path);
  const missingSegments = [];
  while (!await exists(existingAncestor)) {
    const parent = dirname3(existingAncestor);
    if (parent === existingAncestor) {
      throw invalidOperationPath("Creator Skill recovery path has no valid ancestor");
    }
    missingSegments.unshift(basename2(existingAncestor));
    existingAncestor = parent;
  }
  return resolve2(await realpath2(existingAncestor), ...missingSegments);
}
async function deriveJournalPaths(workspaceRoot, operationPath, journal) {
  validateJournalShape(journal, basename2(operationPath));
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const skillsRoot = resolve2(canonicalWorkspace, "skills");
  assertChildPath(canonicalWorkspace, skillsRoot, "Workspace Skills root");
  await assertCanonicalPathWhenPresent(skillsRoot, "Workspace Skills root");
  const targetPath = resolve2(skillsRoot, journal.slug);
  assertChildPath(skillsRoot, targetPath, "Creator Skill target");
  await assertCanonicalPathWhenPresent(targetPath, "Creator Skill target");
  const transactionBackupPath = resolve2(operationPath, "backup");
  assertChildPath(operationPath, transactionBackupPath, "Creator Skill transaction backup");
  await assertCanonicalPathWhenPresent(
    transactionBackupPath,
    "Creator Skill transaction backup"
  );
  const ledgerPath = resolve2(canonicalWorkspace, "creator-skills.json");
  assertChildPath(canonicalWorkspace, ledgerPath, "Creator Skill ledger");
  if (await canonicalizePotentialPath(journal.targetPath) !== targetPath || await canonicalizePotentialPath(journal.transactionBackupPath) !== transactionBackupPath || await canonicalizePotentialPath(journal.ledgerPath) !== ledgerPath) {
    throw invalidOperationPath("Creator Skill recovery journal contains an out-of-bound path");
  }
  let preserveBackupPath;
  if (journal.preserveBackupPath !== void 0) {
    const backupName = basename2(journal.preserveBackupPath);
    const backupTarget = await resolveCreatorSkillBackupTarget({
      workspaceRoot: canonicalWorkspace,
      slug: journal.slug,
      backupId: backupName
    });
    preserveBackupPath = backupTarget.targetPath;
    if (await canonicalizePotentialPath(journal.preserveBackupPath) !== preserveBackupPath) {
      throw invalidOperationPath("Creator Skill recovery journal contains an out-of-bound backup");
    }
  }
  return {
    targetPath,
    transactionBackupPath,
    ledgerPath,
    ...preserveBackupPath ? { preserveBackupPath } : {}
  };
}
function compareStableSemver(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
function report(dependencies, input, stage, percent, cancellable) {
  dependencies.onProgress?.({
    operationId: input.operationId,
    workspaceId: input.workspaceId,
    slug: input.grant.slug,
    stage,
    percent,
    cancellable
  });
}
async function syncJournalDirectory(directoryPath) {
  let directoryHandle;
  try {
    directoryHandle = await open2(directoryPath, "r");
    await directoryHandle.sync();
  } finally {
    await directoryHandle?.close();
  }
}
async function writeJournal(path, journal, syncDirectory = syncJournalDirectory) {
  const tempPath = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open2(tempPath, "wx", 384);
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}
`);
    await handle.sync();
    await handle.close();
    handle = void 0;
    await rename2(tempPath, path);
    try {
      await syncDirectory(dirname3(path));
      return true;
    } catch (error) {
      const code = error && typeof error === "object" ? error.code : void 0;
      if (code === "EINVAL" || code === "ENOTSUP" || code === "EISDIR") {
        return false;
      }
      throw error;
    }
  } catch (error) {
    await handle?.close().catch(() => {
    });
    await rm2(tempPath, { force: true }).catch(() => {
    });
    throw error;
  }
}
async function persistJournal(path, journal, dependencies) {
  const durable = await writeJournal(
    path,
    journal,
    dependencies?.syncJournalDirectory
  );
  await dependencies?.onJournalPersisted?.(journal.state);
  return durable;
}
async function readLedgerSnapshot(workspaceRoot) {
  try {
    return await readFile3(join3(workspaceRoot, "creator-skills.json"), "utf8");
  } catch {
    return null;
  }
}
async function restoreLedgerSnapshot(workspaceRoot, snapshot, slug) {
  let oldInstallation;
  if (snapshot !== null) {
    try {
      oldInstallation = parseCreatorSkillsLedger(
        JSON.parse(snapshot)
      ).installed.find((item) => item.slug === slug);
    } catch {
      oldInstallation = void 0;
    }
  }
  const current = await readCreatorSkillsLedger(workspaceRoot);
  const restored = oldInstallation ? replaceLedgerInstallation(current, oldInstallation) : removeLedgerInstallation(current, slug);
  if (snapshot === null && restored.installed.length === 0) {
    await rm2(join3(workspaceRoot, "creator-skills.json"), { force: true });
  } else {
    await writeCreatorSkillsLedger(workspaceRoot, restored);
  }
}
async function acquireOperationLock(workspaceRoot, slug) {
  if (slug !== BACKUP_MANAGEMENT_LOCK && slug !== LEDGER_MUTATION_LOCK && !SKILL_SLUG_PATTERN.test(slug)) {
    throw invalidOperationPath("Creator Skill lock slug is invalid");
  }
  const { operationRoot } = await ensureOperationRoot(workspaceRoot);
  const lockDirectory = resolve2(operationRoot, "locks");
  assertChildPath(operationRoot, lockDirectory, "Creator Skill lock directory");
  await mkdir3(lockDirectory, { recursive: true, mode: 448 });
  const canonicalLockDirectory = await realpath2(lockDirectory);
  if (canonicalLockDirectory !== lockDirectory) {
    throw invalidOperationPath("Creator Skill lock directory cannot be a symbolic link");
  }
  const lockPath = join3(lockDirectory, `${slug}.lock`);
  let handle;
  try {
    handle = await open2(lockPath, "wx", 384);
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }));
  } catch (error) {
    await handle?.close();
    throw Object.assign(new Error("Another Creator Skill operation is already running"), {
      code: "creator_skill_operation_in_progress"
    });
  }
  return async () => {
    await handle.close();
    await rm2(lockPath, { force: true });
  };
}
async function acquireProcessQueueSlot(key) {
  const previous = processQueues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolvePromise) => {
    release = resolvePromise;
  });
  const queued = previous.then(() => current);
  processQueues.set(key, queued);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (processQueues.get(key) === queued) processQueues.delete(key);
  };
}
async function enqueue(key, operation) {
  const release = await acquireProcessQueueSlot(key);
  try {
    return await operation();
  } finally {
    release();
  }
}
async function withBackupManagementLock(workspaceRoot, operation) {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const key = `${canonicalWorkspace}\0${BACKUP_MANAGEMENT_LOCK}`;
  return enqueue(key, async () => {
    const releaseLock = await acquireOperationLock(
      canonicalWorkspace,
      BACKUP_MANAGEMENT_LOCK
    );
    try {
      return await operation();
    } finally {
      await releaseLock();
    }
  });
}
async function acquireLedgerMutationLock(workspaceRoot, onContended) {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const key = `${canonicalWorkspace}\0${LEDGER_MUTATION_LOCK}`;
  if (processQueues.has(key)) await onContended?.();
  const releaseQueue = await acquireProcessQueueSlot(key);
  try {
    const releaseFile = await acquireOperationLock(
      canonicalWorkspace,
      LEDGER_MUTATION_LOCK
    );
    return async () => {
      try {
        await releaseFile();
      } finally {
        releaseQueue();
      }
    };
  } catch (error) {
    releaseQueue();
    throw error;
  }
}
async function downloadArchive(args) {
  const response = await args.fetchImpl(args.url, {
    method: "GET",
    redirect: "error",
    signal: args.signal
  });
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`Download failed with HTTP ${response.status}`), {
      code: "creator_skill_download_failed"
    });
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > args.maxBytes) {
    throw Object.assign(new Error("Download exceeds the archive policy"), {
      code: "archive_policy_exceeded"
    });
  }
  const handle = await open2(args.outputPath, "wx", 384);
  const reader = response.body.getReader();
  let downloaded = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      downloaded += chunk.value.byteLength;
      if (downloaded > args.maxBytes) {
        throw Object.assign(new Error("Download exceeds the archive policy"), {
          code: "archive_policy_exceeded"
        });
      }
      await handle.write(chunk.value);
      args.onChunk(downloaded, Number.isFinite(declared) ? declared : void 0);
    }
  } finally {
    await handle.close();
  }
}
async function inspectConflicts(workspaceRoot, input) {
  const slug = input.grant.slug;
  const targetPath = join3(workspaceRoot, "skills", slug);
  const projectPath = input.workingDirectory ? join3(input.workingDirectory, ".agents", "skills", slug) : void 0;
  if (projectPath && await exists(projectPath)) {
    throw Object.assign(new Error("A project-level Skill with this slug has priority"), {
      code: "project_skill_conflict"
    });
  }
  const ledger = await readCreatorSkillsLedger(workspaceRoot);
  const existing = ledger.installed.find((item) => item.slug === slug);
  const targetIdentity = await inspectCreatorSkillTarget(targetPath);
  const targetExists = targetIdentity.kind !== "missing";
  const localModified = isTargetLocallyModified(targetIdentity, existing);
  const conflicts = [];
  const existingIdentities = [];
  if (targetExists && !existing) conflicts.push("workspace_skill");
  if (targetExists && !existing) {
    existingIdentities.push({
      source: "workspace",
      slug
    });
  }
  if (existing && existing.artifactId !== input.grant.artifactId) {
    conflicts.push("different_artifact");
  }
  if (existing) {
    existingIdentities.push({
      source: "creator_space",
      artifactId: existing.artifactId,
      organizationId: existing.organizationId,
      slug: existing.slug,
      version: existing.version
    });
  }
  if (localModified) conflicts.push("local_changes");
  if (await exists(join3(homedir(), ".agents", "skills", slug))) {
    conflicts.push("global_skill");
    existingIdentities.push({
      source: "global",
      slug
    });
  }
  return {
    conflicts,
    ...existing ? { existing } : {},
    localModified,
    targetIdentity,
    conflictDetails: {
      existing: existingIdentities,
      incoming: {
        source: "creator_space",
        artifactId: input.grant.artifactId,
        organizationId: input.grant.organizationId,
        slug: input.grant.slug,
        version: input.grant.version
      }
    }
  };
}
async function inspectCreatorSkillTarget(targetPath) {
  if (!await exists(targetPath)) return { kind: "missing" };
  try {
    const beforeIdentity = await directoryIdentity(targetPath);
    const scanned = await scanCreatorSkillDirectory(targetPath);
    const afterIdentity = await directoryIdentity(targetPath);
    if (beforeIdentity !== afterIdentity) return { kind: "unreadable" };
    return {
      kind: "scanned",
      contentDigest: scanned.contentDigest,
      directoryIdentity: afterIdentity
    };
  } catch {
    return { kind: "unreadable" };
  }
}
function targetIdentitiesEqual(left, right) {
  return left.kind === right.kind && left.contentDigest === right.contentDigest && left.directoryIdentity === right.directoryIdentity;
}
async function issueForceDeleteCredential(args) {
  const identity = await inspectCreatorSkillTarget(args.targetPath);
  if (identity.kind !== "scanned" || !identity.contentDigest || !identity.directoryIdentity) {
    throw Object.assign(
      new Error("Creator Skill changed while preparing permanent deletion"),
      { code: "creator_skill_force_delete_stale" }
    );
  }
  const token = randomBytes(32).toString("base64url");
  const store = await readForceDeleteCredentialStore(args.workspaceRoot);
  const credential = {
    tokenHash: hashForceDeleteCredential(token),
    slug: args.slug,
    artifactId: args.artifactId,
    archiveChecksum: args.archiveChecksum,
    directoryIdentity: identity.directoryIdentity,
    contentFingerprint: identity.contentDigest,
    expiresAt: new Date(Date.now() + FORCE_DELETE_CREDENTIAL_TTL_MS).toISOString()
  };
  await writeForceDeleteCredentialStore(args.workspaceRoot, {
    schemaVersion: 1,
    credentials: [
      ...store.credentials.filter((item) => item.slug !== args.slug),
      credential
    ]
  });
  return token;
}
async function pendingForceDeleteCredential(workspaceRoot, slug) {
  const store = await readForceDeleteCredentialStore(workspaceRoot);
  return store.credentials.find((credential) => credential.slug === slug);
}
async function removeForceDeleteCredential(workspaceRoot, slug) {
  const store = await readForceDeleteCredentialStore(workspaceRoot);
  await writeForceDeleteCredentialStore(workspaceRoot, {
    schemaVersion: 1,
    credentials: store.credentials.filter((credential) => credential.slug !== slug)
  });
}
async function validateForceDeleteCredential(args) {
  if (!args.token) {
    throw Object.assign(new Error("Permanent deletion requires a confirmation credential"), {
      code: "creator_skill_force_delete_credential_required"
    });
  }
  const credential = await pendingForceDeleteCredential(args.workspaceRoot, args.slug);
  const tokenHash = hashForceDeleteCredential(args.token);
  if (!credential || !credentialHashesEqual(credential.tokenHash, tokenHash) || Date.parse(credential.expiresAt) <= Date.now()) {
    throw Object.assign(new Error("Permanent deletion credential is invalid or expired"), {
      code: "creator_skill_force_delete_credential_required"
    });
  }
  const identity = await inspectCreatorSkillTarget(args.targetPath);
  if (identity.kind !== "scanned" || identity.directoryIdentity !== credential.directoryIdentity || identity.contentDigest !== credential.contentFingerprint) {
    throw forceDeleteStaleError();
  }
  return credential;
}
function forceDeleteStaleError() {
  return Object.assign(new Error("Creator Skill changed after deletion confirmation"), {
    code: "creator_skill_force_delete_stale"
  });
}
function forceDeleteConfirmationFromCredential(credential) {
  return {
    artifactId: credential.artifactId,
    archiveChecksum: credential.archiveChecksum,
    directoryIdentity: credential.directoryIdentity,
    contentFingerprint: credential.contentFingerprint
  };
}
async function assertForceDeleteBackupUnchanged(transactionBackupPath, confirmation) {
  if (!confirmation) throw forceDeleteStaleError();
  const captured = await inspectCreatorSkillTarget(transactionBackupPath);
  if (captured.kind !== "scanned" || captured.directoryIdentity !== confirmation.directoryIdentity || captured.contentDigest !== confirmation.contentFingerprint) {
    throw forceDeleteStaleError();
  }
}
async function hasPendingCreatorSkillForceDelete(workspaceRoot, slug) {
  if (!SKILL_SLUG_PATTERN.test(slug)) return false;
  return Boolean(await pendingForceDeleteCredential(workspaceRoot, slug));
}
function isTargetLocallyModified(identity, existing) {
  if (!existing || identity.kind === "missing") return Boolean(existing);
  return identity.kind !== "scanned" || identity.contentDigest !== existing.contentDigest;
}
function lateLocalChangesResult(input, conflictDetails) {
  return errorResult({
    operationId: input.operationId,
    stage: "prepare",
    errorCode: "creator_skill_conflict",
    message: "The existing Skill changed while the update was being prepared",
    conflicts: ["local_changes"],
    conflictDetails
  });
}
function confirmationsMissing(conflicts, input) {
  return conflicts.filter((conflict) => {
    if (conflict === "global_skill") return !input.confirmGlobalOverride;
    if (conflict === "local_changes") return !input.backupLocalChanges;
    return !input.replaceExisting;
  });
}
async function preserveConcurrentRecreation(args) {
  if (!await exists(args.targetPath)) return void 0;
  return withBackupManagementLock(args.workspaceRoot, async () => {
    if (!await exists(args.targetPath)) return void 0;
    await assertCanonicalPathWhenPresent(
      args.targetPath,
      "Concurrent Creator Skill recreation"
    );
    const backup = await allocateCreatorSkillBackupTarget(
      args.workspaceRoot,
      args.slug
    );
    await rename2(args.targetPath, backup.targetPath);
    await writeBackupMetadata(backup.targetPath, {
      schemaVersion: 1,
      slug: args.slug,
      backupId: basename2(backup.targetPath),
      operation: "concurrent_recreation",
      createdAt: inferBackupCreatedAt(backup.targetPath),
      ...args.version ? { version: args.version } : {}
    });
    return backup.targetPath;
  });
}
async function removeTransactionTargetOrPreserveRecreation(args) {
  if (!await exists(args.targetPath)) return;
  const currentIdentity = await directoryIdentity(args.targetPath).catch(() => void 0);
  if (args.journal.promotedDirectoryIdentity && currentIdentity === args.journal.promotedDirectoryIdentity) {
    await rm2(args.targetPath, { recursive: true, force: true });
    return;
  }
  await preserveConcurrentRecreation({
    workspaceRoot: args.workspaceRoot,
    slug: args.journal.slug,
    targetPath: args.targetPath,
    version: args.journal.backupVersion
  });
}
async function assertPromotedTargetIdentity(targetPath, expectedIdentity) {
  const actualIdentity = await directoryIdentity(targetPath).catch(() => void 0);
  if (actualIdentity !== expectedIdentity) {
    throw Object.assign(new Error("Creator Skill target was recreated during commit"), {
      code: "creator_skill_conflict"
    });
  }
}
async function assertDirectoryMatchesPublishedGrant(directory, grant) {
  const scanned = await scanCreatorSkillDirectory(directory);
  const expected = grant.manifest;
  const manifestMatches = scanned.manifest.length === expected.length && scanned.manifest.every((entry, index) => {
    const expectedEntry = expected[index];
    return expectedEntry && entry.path === expectedEntry.path && entry.size === expectedEntry.size && entry.sha256 === expectedEntry.sha256;
  });
  if (!manifestMatches || scanned.contentDigest !== grant.contentDigest) {
    throw new CreatorSkillArchiveError(
      "content_digest_mismatch",
      "Creator Skill changed after archive validation",
      [{
        code: "content_digest_mismatch",
        severity: "error",
        path: "",
        message: "The staged Skill no longer matches the published manifest"
      }]
    );
  }
}
async function rollbackJournal(workspaceRoot, operationPath, journal) {
  const paths = await deriveJournalPaths(workspaceRoot, operationPath, journal);
  if (journal.state === "preparing") {
    await rm2(operationPath, { recursive: true, force: true });
    return;
  }
  const recoverableBackupPath = await exists(paths.transactionBackupPath) ? paths.transactionBackupPath : paths.preserveBackupPath && await exists(paths.preserveBackupPath) ? paths.preserveBackupPath : void 0;
  const detachedTargetAlreadyRestored = journal.action === "uninstall" && journal.state === "detaching" && !recoverableBackupPath && await exists(paths.targetPath);
  if (!detachedTargetAlreadyRestored && (recoverableBackupPath || journal.state !== "prepared")) {
    await removeTransactionTargetOrPreserveRecreation({
      workspaceRoot,
      targetPath: paths.targetPath,
      journal
    });
  }
  if (recoverableBackupPath) {
    await mkdir3(dirname3(paths.targetPath), { recursive: true });
    await rename2(recoverableBackupPath, paths.targetPath);
  }
  if (paths.preserveBackupPath) {
    await rm2(backupMetadataPath(paths.preserveBackupPath), { force: true });
  }
  await restoreLedgerSnapshot(workspaceRoot, journal.oldLedger, journal.slug);
  await rm2(operationPath, { recursive: true, force: true });
}
async function publishCommittedBackup(workspaceRoot, operationPath, journal) {
  const paths = await deriveJournalPaths(workspaceRoot, operationPath, journal);
  const preserveBackupPath = paths.preserveBackupPath;
  if (!preserveBackupPath) return void 0;
  return withBackupManagementLock(workspaceRoot, async () => {
    const metadata = backupMetadataFromJournal(journal, preserveBackupPath);
    const transactionExists = await exists(paths.transactionBackupPath);
    const preserveExists = await exists(preserveBackupPath);
    if (transactionExists && preserveExists) {
      throw invalidBackupPath(
        "Creator Skill committed backup exists in both transaction and permanent storage"
      );
    }
    if (transactionExists) {
      const backupTarget = await resolveCreatorSkillBackupTarget({
        workspaceRoot,
        slug: journal.slug,
        backupId: basename2(preserveBackupPath),
        createAncestors: true
      });
      if (backupTarget.targetPath !== preserveBackupPath || backupTarget.targetExists) {
        throw invalidBackupPath("Creator Skill backup target is unsafe or already exists");
      }
      if (metadata) await writeBackupMetadata(preserveBackupPath, metadata);
      await rename2(paths.transactionBackupPath, preserveBackupPath);
    }
    if (!await exists(preserveBackupPath)) return void 0;
    if (metadata) await writeBackupMetadata(preserveBackupPath, metadata);
    return preserveBackupPath;
  });
}
async function finalizeCommittedJournal(workspaceRoot, operationPath, journal) {
  if (journal.action === "uninstall" && !journal.preserveBackupPath) {
    const paths = await deriveJournalPaths(workspaceRoot, operationPath, journal);
    if (await exists(paths.transactionBackupPath)) {
      try {
        await assertForceDeleteBackupUnchanged(
          paths.transactionBackupPath,
          journal.forceDeleteConfirmation
        );
      } catch (error) {
        await rollbackJournal(workspaceRoot, operationPath, journal);
        if (error && typeof error === "object" && error.code === "creator_skill_force_delete_stale") {
          return;
        }
        throw error;
      }
      await rm2(paths.transactionBackupPath, { recursive: true, force: true });
    }
    await removeForceDeleteCredential(workspaceRoot, journal.slug);
    await rm2(operationPath, { recursive: true, force: true });
    return;
  }
  await publishCommittedBackup(workspaceRoot, operationPath, journal);
  await rm2(operationPath, { recursive: true, force: true });
}
async function installCreatorSkill(workspaceRoot, input, dependencies = {}) {
  const queueWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const key = `${queueWorkspace}\0${input.grant.slug}`;
  return enqueue(key, async () => {
    let releaseLock;
    let releaseLedgerLock;
    const controller = new AbortController();
    const ownerId = dependencies.operationOwnerId ?? input.workspaceId;
    const controllerKey = cancellationKey(
      queueWorkspace,
      ownerId,
      input.operationId
    );
    let controllerRegistered = false;
    let operationPath;
    let journal;
    let commitStarted = false;
    let committedResult;
    try {
      releaseLock = await acquireOperationLock(queueWorkspace, input.grant.slug);
      const conflictState = await inspectConflicts(queueWorkspace, input);
      const missing = confirmationsMissing(conflictState.conflicts, input);
      if (missing.length > 0) {
        return errorResult({
          operationId: input.operationId,
          stage: "prepare",
          errorCode: "creator_skill_conflict",
          message: "Installing this Skill requires explicit conflict confirmation",
          conflicts: missing,
          conflictDetails: conflictState.conflictDetails
        });
      }
      const resolvedOperation = await reserveOperationPath(
        queueWorkspace,
        input.operationId
      );
      const canonicalWorkspace = resolvedOperation.workspaceRoot;
      operationPath = resolvedOperation.operationPath;
      const stagePath = join3(operationPath, "stage");
      const archivePath = join3(operationPath, "archive.zip");
      const transactionBackupPath = join3(operationPath, "backup");
      const targetPath = resolve2(canonicalWorkspace, "skills", input.grant.slug);
      assertChildPath(resolve2(canonicalWorkspace, "skills"), targetPath, "Creator Skill target");
      journal = {
        schemaVersion: 1,
        operationId: input.operationId,
        action: "install",
        slug: input.grant.slug,
        targetPath,
        transactionBackupPath,
        ledgerPath: resolve2(canonicalWorkspace, "creator-skills.json"),
        oldLedger: null,
        state: "preparing"
      };
      await persistJournal(join3(operationPath, "journal.json"), journal, dependencies);
      await mkdir3(stagePath, { recursive: true, mode: 448 });
      cancellationControllers.set(controllerKey, controller);
      controllerRegistered = true;
      report(dependencies, input, "download", 2, true);
      const policyMax = Math.min(
        input.grant.validationPolicy.maxArchiveBytes,
        HARD_SKILL_ARCHIVE_POLICY.maxArchiveBytes
      );
      await downloadArchive({
        url: input.grant.url,
        outputPath: archivePath,
        maxBytes: policyMax,
        signal: controller.signal,
        fetchImpl: dependencies.fetch ?? fetch,
        onChunk: (downloaded, total) => report(
          dependencies,
          input,
          "download",
          total ? Math.min(35, Math.round(downloaded / total * 35)) : 20,
          true
        )
      });
      report(dependencies, input, "validate", 40, true);
      await validateCreatorSkillArchive({
        archivePath,
        slug: input.grant.slug,
        destinationRoot: stagePath,
        policy: input.grant.validationPolicy,
        expectedArchiveChecksum: input.grant.archiveChecksum,
        expectedContentDigest: input.grant.contentDigest,
        expectedManifest: input.grant.manifest
      });
      if (controller.signal.aborted) {
        throw Object.assign(new Error("Installation cancelled"), {
          code: "creator_skill_cancelled"
        });
      }
      report(dependencies, input, "prepare", 65, true);
      await dependencies.assertCommitAllowed?.({
        artifactId: input.grant.artifactId,
        version: input.grant.version,
        archiveChecksum: input.grant.archiveChecksum
      });
      if (controller.signal.aborted) {
        throw Object.assign(new Error("Installation cancelled"), {
          code: "creator_skill_cancelled"
        });
      }
      releaseLedgerLock = await acquireLedgerMutationLock(
        canonicalWorkspace,
        dependencies.onLedgerMutationLockContended
      );
      const ledger = await readCreatorSkillsLedger(canonicalWorkspace);
      await dependencies.onLedgerMutationLocked?.();
      const previous = conflictState.existing;
      const ignoredVersion = previous && previous.artifactId === input.grant.artifactId && compareStableSemver(input.grant.version, previous.version) < 0 ? previous.version : void 0;
      const installation = {
        artifactId: input.grant.artifactId,
        organizationId: input.grant.organizationId,
        slug: input.grant.slug,
        version: input.grant.version,
        archiveChecksum: input.grant.archiveChecksum,
        contentDigest: input.grant.contentDigest,
        installedAt: (/* @__PURE__ */ new Date()).toISOString(),
        lastKnownStatus: "active",
        lastCheckedAt: (/* @__PURE__ */ new Date()).toISOString(),
        ...ignoredVersion ? { ignoredVersion } : {}
      };
      await assertCanonicalPathWhenPresent(resolve2(canonicalWorkspace, "skills"), "Workspace Skills root");
      await assertCanonicalPathWhenPresent(targetPath, "Creator Skill target");
      const oldLedger = await readLedgerSnapshot(canonicalWorkspace);
      await dependencies.beforeCommitSnapshot?.();
      await assertDirectoryMatchesPublishedGrant(join3(stagePath, input.grant.slug), input.grant);
      const preCommitTargetIdentity = await inspectCreatorSkillTarget(targetPath);
      const changedDuringPreparation = !targetIdentitiesEqual(
        conflictState.targetIdentity,
        preCommitTargetIdentity
      );
      if (changedDuringPreparation && !input.backupLocalChanges) {
        await rm2(operationPath, { recursive: true, force: true });
        return lateLocalChangesResult(input, conflictState.conflictDetails);
      }
      let preserveBackupPath = preCommitTargetIdentity.kind !== "missing" ? (await allocateCreatorSkillBackupTarget(
        canonicalWorkspace,
        input.grant.slug
      )).targetPath : void 0;
      let backupOperation = preserveBackupPath ? conflictState.localModified || changedDuringPreparation || isTargetLocallyModified(preCommitTargetIdentity, conflictState.existing) ? "modified_update" : "update_safety_snapshot" : void 0;
      const backupCreatedAt = preserveBackupPath ? inferBackupCreatedAt(preserveBackupPath) : void 0;
      journal.oldLedger = oldLedger;
      journal.state = "prepared";
      if (preserveBackupPath) journal.preserveBackupPath = preserveBackupPath;
      if (backupOperation) journal.backupOperation = backupOperation;
      if (conflictState.existing?.version) {
        journal.backupVersion = conflictState.existing.version;
      }
      if (backupCreatedAt) journal.backupCreatedAt = backupCreatedAt;
      const journalPath = join3(operationPath, "journal.json");
      await persistJournal(journalPath, journal, dependencies);
      commitStarted = true;
      report(dependencies, input, "commit", 72, false);
      await mkdir3(dirname3(targetPath), { recursive: true });
      if (await exists(targetPath)) {
        await rename2(targetPath, transactionBackupPath);
      }
      const capturedTargetIdentity = await inspectCreatorSkillTarget(transactionBackupPath);
      const changedAtRename = !targetIdentitiesEqual(
        preCommitTargetIdentity,
        capturedTargetIdentity
      );
      if (changedAtRename && !input.backupLocalChanges) {
        await rollbackJournal(canonicalWorkspace, operationPath, journal);
        return lateLocalChangesResult(input, conflictState.conflictDetails);
      }
      const capturedLocalModified = isTargetLocallyModified(
        capturedTargetIdentity,
        conflictState.existing
      );
      if (preserveBackupPath && backupOperation !== "modified_update" && (capturedLocalModified || changedDuringPreparation || changedAtRename)) {
        backupOperation = "modified_update";
        journal.backupOperation = backupOperation;
        await persistJournal(journalPath, journal, dependencies);
      }
      const promotedDirectoryIdentity = await directoryIdentity(
        join3(stagePath, input.grant.slug)
      );
      journal.promotedDirectoryIdentity = promotedDirectoryIdentity;
      journal.state = "old_backed_up";
      await persistJournal(journalPath, journal, dependencies);
      await preserveConcurrentRecreation({
        workspaceRoot: canonicalWorkspace,
        slug: input.grant.slug,
        targetPath,
        version: conflictState.existing?.version
      });
      await rename2(join3(stagePath, input.grant.slug), targetPath);
      await assertPromotedTargetIdentity(targetPath, promotedDirectoryIdentity);
      await assertDirectoryMatchesPublishedGrant(targetPath, input.grant);
      journal.state = "new_installed";
      await persistJournal(journalPath, journal, dependencies);
      await assertPromotedTargetIdentity(targetPath, promotedDirectoryIdentity);
      await assertDirectoryMatchesPublishedGrant(targetPath, input.grant);
      await writeCreatorSkillsLedger(
        canonicalWorkspace,
        replaceLedgerInstallation(ledger, installation),
        dependencies.ledgerWriteDependencies
      );
      journal.state = "ledger_committed";
      await persistJournal(journalPath, journal, dependencies);
      await assertPromotedTargetIdentity(targetPath, promotedDirectoryIdentity);
      journal.state = "committed";
      const committedJournalDurable = await writeJournal(
        journalPath,
        journal,
        dependencies.syncJournalDirectory
      );
      committedResult = {
        success: true,
        operationId: input.operationId,
        installed: installation
      };
      await dependencies.onJournalPersisted?.(journal.state);
      if (!committedJournalDurable) {
        report(dependencies, input, "refresh", 100, false);
        return committedResult;
      }
      const backupPath = await publishCommittedBackup(
        canonicalWorkspace,
        operationPath,
        journal
      );
      if (!backupPath) {
        await rm2(transactionBackupPath, { recursive: true, force: true });
      }
      await dependencies.onCleanupStep?.("transaction_backup_removed");
      await rm2(operationPath, { recursive: true, force: true });
      await dependencies.onCleanupStep?.("operation_removed");
      report(dependencies, input, "refresh", 100, false);
      return committedResult;
    } catch (error) {
      dependencies.onError?.(error);
      if (journal?.state === "committed" && committedResult) {
        report(dependencies, input, "refresh", 100, false);
        return committedResult;
      }
      if (commitStarted && operationPath && journal) {
        try {
          await rollbackJournal(workspaceRoot, operationPath, journal);
        } catch {
        }
      } else if (operationPath) {
        await rm2(operationPath, { recursive: true, force: true }).catch(() => {
        });
      }
      const record = error && typeof error === "object" ? error : {};
      const code = safeOperationErrorCode(
        record.code,
        "creator_skill_install_failed"
      );
      const cancelled = code === "creator_skill_cancelled" || controller.signal.aborted;
      const failureStage = commitStarted ? "commit" : code.includes("download") ? "download" : code.includes("conflict") || code === "creator_skill_operation_in_progress" ? "prepare" : "validate";
      const issuePath = record.issues?.find((item) => item.path)?.path;
      const failurePath = issuePath && !issuePath.startsWith("/") && !/^[a-zA-Z]:/.test(issuePath) && !issuePath.includes("\\") && !issuePath.split("/").some((segment) => segment === "..") ? issuePath.replace(new RegExp(`^${input.grant.slug}/`), "") : void 0;
      return errorResult({
        operationId: input.operationId,
        stage: failureStage,
        errorCode: cancelled ? "creator_skill_cancelled" : code,
        message: cancelled ? "Installation was cancelled before the commit boundary" : "Creator Skill installation failed",
        ...failurePath ? { path: failurePath } : {},
        retryable: !commitStarted && !cancelled && code !== "project_skill_conflict"
      });
    } finally {
      if (controllerRegistered && cancellationControllers.get(controllerKey) === controller) {
        cancellationControllers.delete(controllerKey);
      }
      await releaseLedgerLock?.();
      await releaseLock?.();
    }
  });
}
async function cancelCreatorSkillOperation(workspaceRoot, ownerId, operationId) {
  if (!UUID_PATTERN.test(operationId)) return false;
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const controller = cancellationControllers.get(cancellationKey(
    canonicalWorkspace,
    ownerId,
    operationId
  ));
  if (!controller) return false;
  controller.abort();
  return true;
}
async function uninstallCreatorSkill(args, dependencies = {}) {
  const queueWorkspace = await canonicalWorkspaceRoot(args.workspaceRoot);
  const key = `${queueWorkspace}\0${args.slug}`;
  return enqueue(key, async () => {
    let releaseLock;
    let releaseLedgerLock;
    let journal;
    let operationPath;
    let committedResult;
    try {
      releaseLock = await acquireOperationLock(queueWorkspace, args.slug);
      const resolvedOperation = await resolveOperationPath(
        queueWorkspace,
        args.operationId
      );
      const canonicalWorkspace = resolvedOperation.workspaceRoot;
      releaseLedgerLock = await acquireLedgerMutationLock(
        canonicalWorkspace,
        dependencies.onLedgerMutationLockContended
      );
      const ledger = await readCreatorSkillsLedger(canonicalWorkspace);
      await dependencies.onLedgerMutationLocked?.();
      const installed = ledger.installed.find((item) => item.slug === args.slug);
      const pendingCredential = installed ? void 0 : await pendingForceDeleteCredential(canonicalWorkspace, args.slug);
      if (!installed && !pendingCredential) {
        return errorResult({
          operationId: args.operationId,
          stage: "prepare",
          errorCode: "creator_skill_not_installed",
          message: "This workspace Skill is not managed by Creator Space"
        });
      }
      const targetPath = resolve2(canonicalWorkspace, "skills", args.slug);
      assertChildPath(resolve2(canonicalWorkspace, "skills"), targetPath, "Creator Skill target");
      await assertCanonicalPathWhenPresent(resolve2(canonicalWorkspace, "skills"), "Workspace Skills root");
      await assertCanonicalPathWhenPresent(targetPath, "Creator Skill target");
      const targetIdentity = await inspectCreatorSkillTarget(targetPath);
      await dependencies.beforeCommitSnapshot?.();
      let validatedForceCredential;
      if (args.forceDeleteModified) {
        if (installed) {
          throw Object.assign(new Error("Detach the modified Creator Skill before deleting it"), {
            code: "creator_skill_force_delete_credential_required"
          });
        }
        validatedForceCredential = await validateForceDeleteCredential({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          token: args.forceDeleteCredential,
          targetPath
        });
      }
      const nextLedger = installed ? removeLedgerInstallation(ledger, args.slug) : ledger;
      if (targetIdentity.kind === "missing") {
        await writeCreatorSkillsLedger(
          canonicalWorkspace,
          nextLedger,
          dependencies.ledgerWriteDependencies
        );
        if (pendingCredential) {
          await removeForceDeleteCredential(canonicalWorkspace, args.slug);
        }
        return {
          success: true,
          operationId: args.operationId
        };
      }
      if (!args.forceDeleteModified && (installed && isTargetLocallyModified(targetIdentity, installed) || !installed && pendingCredential)) {
        await writeCreatorSkillsLedger(
          canonicalWorkspace,
          nextLedger,
          dependencies.ledgerWriteDependencies
        );
        let forceDeleteCredential;
        try {
          forceDeleteCredential = await issueForceDeleteCredential({
            workspaceRoot: canonicalWorkspace,
            slug: args.slug,
            artifactId: installed?.artifactId ?? pendingCredential.artifactId,
            archiveChecksum: installed?.archiveChecksum ?? pendingCredential.archiveChecksum,
            targetPath
          });
        } catch (error) {
          if (installed) {
            await writeCreatorSkillsLedger(
              canonicalWorkspace,
              ledger,
              dependencies.ledgerWriteDependencies
            );
          }
          throw error;
        }
        return {
          success: true,
          operationId: args.operationId,
          detached: true,
          forceDeleteCredential
        };
      }
      const reservedOperation = await reserveOperationPath(
        canonicalWorkspace,
        args.operationId
      );
      operationPath = reservedOperation.operationPath;
      const transactionBackupPath = join3(operationPath, "backup");
      const preserveBackupPath = !args.forceDeleteModified ? (await allocateCreatorSkillBackupTarget(
        canonicalWorkspace,
        args.slug
      )).targetPath : void 0;
      journal = {
        schemaVersion: 1,
        operationId: args.operationId,
        action: "uninstall",
        slug: args.slug,
        targetPath,
        transactionBackupPath,
        ledgerPath: resolve2(canonicalWorkspace, "creator-skills.json"),
        oldLedger: await readLedgerSnapshot(canonicalWorkspace),
        state: "prepared",
        ...preserveBackupPath ? {
          preserveBackupPath,
          backupOperation: "clean_uninstall_snapshot",
          backupVersion: installed?.version,
          backupCreatedAt: inferBackupCreatedAt(preserveBackupPath)
        } : {},
        ...validatedForceCredential ? {
          forceDeleteConfirmation: forceDeleteConfirmationFromCredential(
            validatedForceCredential
          )
        } : {}
      };
      const journalPath = join3(operationPath, "journal.json");
      await persistJournal(journalPath, journal, dependencies);
      if (await exists(targetPath)) await rename2(targetPath, transactionBackupPath);
      await assertCanonicalPathWhenPresent(
        transactionBackupPath,
        "Creator Skill uninstall snapshot"
      );
      if (validatedForceCredential) {
        await assertForceDeleteBackupUnchanged(
          transactionBackupPath,
          journal.forceDeleteConfirmation
        );
      }
      journal.state = "old_backed_up";
      await persistJournal(journalPath, journal, dependencies);
      if (args.forceDeleteModified && await exists(targetPath)) {
        throw Object.assign(new Error("Creator Skill target was recreated during deletion"), {
          code: "creator_skill_force_delete_stale"
        });
      }
      if (!args.forceDeleteModified) {
        await preserveConcurrentRecreation({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          targetPath,
          version: installed?.version
        });
      }
      await writeCreatorSkillsLedger(
        canonicalWorkspace,
        nextLedger,
        dependencies.ledgerWriteDependencies
      );
      journal.state = "ledger_committed";
      await persistJournal(journalPath, journal, dependencies);
      if (args.forceDeleteModified && await exists(targetPath)) {
        throw Object.assign(new Error("Creator Skill target was recreated during deletion"), {
          code: "creator_skill_force_delete_stale"
        });
      }
      if (!args.forceDeleteModified) {
        await preserveConcurrentRecreation({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          targetPath,
          version: installed?.version
        });
      }
      journal.state = "committed";
      const committedJournalDurable = await writeJournal(
        journalPath,
        journal,
        dependencies.syncJournalDirectory
      );
      committedResult = {
        success: true,
        operationId: args.operationId
      };
      await dependencies.onJournalPersisted?.(journal.state);
      if (!committedJournalDurable) return committedResult;
      if (!args.forceDeleteModified) {
        await preserveConcurrentRecreation({
          workspaceRoot: canonicalWorkspace,
          slug: args.slug,
          targetPath,
          version: installed?.version
        });
      }
      if (args.forceDeleteModified) {
        await assertForceDeleteBackupUnchanged(
          transactionBackupPath,
          journal.forceDeleteConfirmation
        );
        await rm2(transactionBackupPath, { recursive: true, force: true });
        await removeForceDeleteCredential(canonicalWorkspace, args.slug);
      } else {
        const backupPath = await publishCommittedBackup(
          canonicalWorkspace,
          operationPath,
          journal
        );
        if (!backupPath) {
          await rm2(transactionBackupPath, { recursive: true, force: true });
        }
      }
      await dependencies.onCleanupStep?.("transaction_backup_removed");
      await rm2(operationPath, { recursive: true, force: true });
      await dependencies.onCleanupStep?.("operation_removed");
      return committedResult;
    } catch (error) {
      dependencies.onError?.(error);
      const record = error && typeof error === "object" ? error : {};
      if (record.code === "creator_skill_force_delete_stale" && journal && operationPath) {
        await rollbackJournal(args.workspaceRoot, operationPath, journal).catch(() => {
        });
        return errorResult({
          operationId: args.operationId,
          stage: "commit",
          errorCode: "creator_skill_force_delete_stale",
          message: "Creator Skill uninstall failed"
        });
      }
      if (journal?.state === "committed" && committedResult) {
        if (journal.forceDeleteConfirmation && operationPath) {
          const transactionBackupPath = resolve2(operationPath, "backup");
          try {
            if (await exists(transactionBackupPath)) {
              await assertForceDeleteBackupUnchanged(
                transactionBackupPath,
                journal.forceDeleteConfirmation
              );
            }
          } catch (validationError) {
            dependencies.onError?.(validationError);
            await rollbackJournal(args.workspaceRoot, operationPath, journal).catch(() => {
            });
            return errorResult({
              operationId: args.operationId,
              stage: "commit",
              errorCode: "creator_skill_force_delete_stale",
              message: "Creator Skill uninstall failed"
            });
          }
        }
        return committedResult;
      }
      if (journal && operationPath) {
        await rollbackJournal(args.workspaceRoot, operationPath, journal).catch(() => {
        });
      }
      return errorResult({
        operationId: args.operationId,
        stage: "commit",
        errorCode: safeOperationErrorCode(
          record.code,
          "creator_skill_uninstall_failed"
        ),
        message: "Creator Skill uninstall failed"
      });
    } finally {
      await releaseLedgerLock?.();
      await releaseLock?.();
    }
  });
}
async function cleanupAbandonedPreJournalOperation(operationPath) {
  const entries = await readdir2(operationPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "stage") {
      if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
      continue;
    }
    if (entry.name === "archive.zip") {
      if (!entry.isFile() || entry.isSymbolicLink()) return false;
      continue;
    }
    if (/^journal\.json\.[0-9a-f-]+\.tmp$/i.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) {
      continue;
    }
    return false;
  }
  await rm2(operationPath, { recursive: true, force: true });
  return true;
}
async function recoverCreatorSkillOperations(workspaceRoot) {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const root = resolve2(canonicalWorkspace, OP_DIRECTORY);
  assertChildPath(canonicalWorkspace, root, "Creator Skill operation root");
  let entries;
  try {
    entries = await readdir2(root, { withFileTypes: true });
  } catch {
    return;
  }
  const canonicalRoot = await realpath2(root);
  if (canonicalRoot !== root) {
    throw invalidOperationPath("Creator Skill operation root cannot be a symbolic link");
  }
  for (const entry of entries) {
    if (entry.name === "locks") continue;
    if (!entry.isDirectory() || !UUID_PATTERN.test(entry.name)) {
      throw Object.assign(
        new Error(`Creator Skill recovery requires attention for operation '${entry.name}'`),
        { code: "creator_skill_recovery_failed" }
      );
    }
    const { operationPath } = await resolveOperationPath(canonicalWorkspace, entry.name);
    try {
      const journalPath = resolve2(operationPath, "journal.json");
      assertChildPath(operationPath, journalPath, "Creator Skill recovery journal");
      const journalStats = await lstatIfPresent(journalPath);
      if (!journalStats) {
        if (await cleanupAbandonedPreJournalOperation(operationPath)) continue;
        throw invalidOperationPath(
          "Creator Skill operation without a journal contains recovery material"
        );
      }
      if (!journalStats.isFile() || journalStats.size > MAX_JOURNAL_BYTES) {
        throw invalidOperationPath("Creator Skill recovery journal is oversized or invalid");
      }
      const journal = JSON.parse(
        await readFile3(journalPath, "utf8")
      );
      await deriveJournalPaths(canonicalWorkspace, operationPath, journal);
      if (journal.state === "committed") {
        await finalizeCommittedJournal(canonicalWorkspace, operationPath, journal);
      } else {
        await rollbackJournal(canonicalWorkspace, operationPath, journal);
      }
    } catch {
      throw Object.assign(
        new Error(`Creator Skill recovery requires attention for operation '${entry.name}'`),
        { code: "creator_skill_recovery_failed" }
      );
    }
  }
  const lockRoot = resolve2(root, "locks");
  assertChildPath(root, lockRoot, "Creator Skill lock directory");
  if (await exists(lockRoot)) {
    const lockStats = await stat2(lockRoot);
    if (lockStats.isDirectory()) {
      const canonicalLockRoot = await realpath2(lockRoot);
      if (canonicalLockRoot !== lockRoot) {
        throw invalidOperationPath("Creator Skill lock directory cannot be a symbolic link");
      }
    }
    await rm2(lockRoot, { recursive: true, force: true });
  }
}
async function listCreatorSkillBackups(workspaceRoot) {
  const canonicalWorkspace = await canonicalWorkspaceRoot(workspaceRoot);
  const root = resolve2(canonicalWorkspace, BACKUP_DIRECTORY);
  assertChildPath(canonicalWorkspace, root, "Creator Skill backup root");
  const rootStats = await lstatIfPresent(root);
  if (!rootStats) return [];
  await assertSafeBackupDirectory(root, canonicalWorkspace, "Creator Skill backup root");
  let slugs;
  try {
    slugs = await readdir2(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const backups = [];
  for (const slugEntry of slugs) {
    if (slugEntry.isSymbolicLink()) {
      throw invalidBackupPath("Creator Skill backup slug cannot be a symbolic link");
    }
    if (!slugEntry.isDirectory()) continue;
    if (!SKILL_SLUG_PATTERN.test(slugEntry.name)) continue;
    const slugPath = resolve2(root, slugEntry.name);
    await assertSafeBackupDirectory(
      slugPath,
      root,
      "Creator Skill slug backup root"
    );
    const versions = await readdir2(slugPath, { withFileTypes: true });
    for (const version of versions) {
      if (version.isSymbolicLink()) {
        throw invalidBackupPath("Creator Skill backup target cannot be a symbolic link");
      }
      if (!version.isDirectory()) continue;
      if (!BACKUP_NAME_PATTERN.test(version.name)) continue;
      const resolved = await resolveCreatorSkillBackupTarget({
        workspaceRoot: canonicalWorkspace,
        slug: slugEntry.name,
        backupId: version.name
      });
      const metadata = await readBackupMetadata({
        targetPath: resolved.targetPath,
        slug: slugEntry.name,
        backupId: version.name
      });
      backups.push({
        backupId: version.name,
        slug: slugEntry.name,
        createdAt: metadata?.createdAt ?? inferBackupCreatedAt(resolved.targetPath),
        sizeBytes: await directorySize(resolved.targetPath),
        operation: metadata?.operation ?? "update_safety_snapshot",
        ...metadata?.version ? { version: metadata.version } : {}
      });
    }
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}
async function deleteCreatorSkillBackups(workspaceRoot, backup) {
  return withBackupManagementLock(workspaceRoot, async () => {
    if (!backup) {
      const backups = await listCreatorSkillBackups(workspaceRoot);
      for (const item of backups) {
        const target2 = await resolveCreatorSkillBackupTarget({
          workspaceRoot,
          slug: item.slug,
          backupId: item.backupId
        });
        if (!target2.targetExists) continue;
        await rm2(target2.targetPath, { recursive: true, force: true });
        await rm2(backupMetadataPath(target2.targetPath), { force: true });
      }
      return backups.length;
    }
    const target = await resolveCreatorSkillBackupTarget({
      workspaceRoot,
      slug: backup.slug,
      backupId: backup.backupId
    });
    if (!target.targetExists) return 0;
    await rm2(target.targetPath, { recursive: true, force: true });
    await rm2(backupMetadataPath(target.targetPath), { force: true });
    return 1;
  });
}
async function updateCreatorSkillInstallationMetadata(args, dependencies = {}) {
  const queueWorkspace = await canonicalWorkspaceRoot(args.workspaceRoot);
  const ledger = await readCreatorSkillsLedger(queueWorkspace);
  const candidate = ledger.installed.find((item) => item.artifactId === args.artifactId && item.version === args.version && item.archiveChecksum === args.archiveChecksum);
  if (!candidate) return false;
  const key = `${queueWorkspace}\0${candidate.slug}`;
  return enqueue(key, async () => {
    const releaseLock = await acquireOperationLock(queueWorkspace, candidate.slug);
    let releaseLedgerLock;
    try {
      releaseLedgerLock = await acquireLedgerMutationLock(
        queueWorkspace,
        dependencies.onLedgerMutationLockContended
      );
      const currentLedger = await readCreatorSkillsLedger(queueWorkspace);
      await dependencies.onLedgerMutationLocked?.();
      const current = currentLedger.installed.find((item) => item.artifactId === args.artifactId && item.version === args.version && item.archiveChecksum === args.archiveChecksum);
      if (!current) return false;
      const changes = current.lastKnownStatus === "revoked" && args.changes.lastKnownStatus && args.changes.lastKnownStatus !== "revoked" ? {
        ...args.changes,
        // A precise revoked version is terminal. A delayed active/archived
        // response may refresh its timestamp, but can never clear the warning.
        lastKnownStatus: "revoked"
      } : args.changes;
      await writeCreatorSkillsLedger(
        queueWorkspace,
        replaceLedgerInstallation(currentLedger, {
          ...current,
          ...changes
        }),
        dependencies.ledgerWriteDependencies
      );
      return true;
    } finally {
      await releaseLedgerLock?.();
      await releaseLock();
    }
  });
}
async function copyCreatorSkillBackupForTesting(source, workspaceRoot, slug) {
  const target = await allocateCreatorSkillBackupTarget(workspaceRoot, slug);
  await cp(source, target.targetPath, { recursive: true, errorOnExist: true });
  return target.targetPath;
}
export {
  cancelCreatorSkillOperation,
  copyCreatorSkillBackupForTesting,
  deleteCreatorSkillBackups,
  hasPendingCreatorSkillForceDelete,
  installCreatorSkill,
  listCreatorSkillBackups,
  recoverCreatorSkillOperations,
  uninstallCreatorSkill,
  updateCreatorSkillInstallationMetadata
};
