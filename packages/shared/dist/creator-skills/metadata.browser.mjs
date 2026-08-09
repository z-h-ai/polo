// src/creator-skills/metadata.ts
var CreatorSkillMetadataError = class extends Error {
  issues;
  constructor(message, issues) {
    super(message);
    this.name = "CreatorSkillMetadataError";
    this.issues = issues;
  }
};
function metadataIssue(code, path, message, field, suggestion) {
  return { code, path, ...field ? { field } : {}, message, ...suggestion ? { suggestion } : {} };
}
function isCreatorSkillPackagingNoise(path) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "__MACOSX") return true;
  const name = parts.at(-1) ?? "";
  return name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");
}
function readContent(entry) {
  if (typeof entry.content === "string") return entry.content;
  if (!entry.content) {
    throw new CreatorSkillMetadataError("SKILL.md content is missing", [
      metadataIssue("missing_skill_content", entry.path, "Provide the UTF-8 contents of the root SKILL.md entry")
    ]);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(entry.content);
  } catch {
    throw new CreatorSkillMetadataError("SKILL.md must be UTF-8", [
      metadataIssue("invalid_skill_utf8", entry.path, "SKILL.md must contain valid UTF-8 text")
    ]);
  }
}
function decodeScalar(value, path, field) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded === "string") return decoded;
    } catch {
    }
    throw new CreatorSkillMetadataError("SKILL.md frontmatter is invalid", [
      metadataIssue("invalid_skill_metadata", path, `Invalid quoted value for '${field}'`, field)
    ]);
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) {
      throw new CreatorSkillMetadataError("SKILL.md frontmatter is invalid", [
        metadataIssue("invalid_skill_metadata", path, `Invalid quoted value for '${field}'`, field)
      ]);
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
}
function parseFrontmatter(content, path) {
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new CreatorSkillMetadataError("SKILL.md frontmatter is invalid", [
      metadataIssue("invalid_skill_metadata", path, "SKILL.md must start with YAML frontmatter", "frontmatter")
    ]);
  }
  const end = lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
  if (end === -1) {
    throw new CreatorSkillMetadataError("SKILL.md frontmatter is invalid", [
      metadataIssue("invalid_skill_metadata", path, "SKILL.md frontmatter is missing its closing delimiter", "frontmatter")
    ]);
  }
  const data = /* @__PURE__ */ new Map();
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/\t/.test(line)) {
      throw new CreatorSkillMetadataError("SKILL.md frontmatter is invalid", [
        metadataIssue("invalid_skill_metadata", path, "YAML frontmatter cannot use tab indentation", "frontmatter")
      ]);
    }
    const property = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ ](.*)|\s*)$/.exec(line);
    if (!property) {
      throw new CreatorSkillMetadataError("SKILL.md frontmatter is invalid", [
        metadataIssue("invalid_skill_metadata", path, "Invalid YAML frontmatter property", "frontmatter")
      ]);
    }
    const key = property[1];
    if (data.has(key)) {
      throw new CreatorSkillMetadataError("SKILL.md frontmatter is invalid", [
        metadataIssue("invalid_skill_metadata", path, `Duplicate frontmatter field '${key}'`, key)
      ]);
    }
    const rawValue = property[2];
    if (rawValue !== void 0 && rawValue.length > 0) {
      data.set(key, decodeScalar(rawValue, path, key));
      continue;
    }
    const values = [];
    while (index + 1 < end && /^  - /.test(lines[index + 1])) {
      index += 1;
      values.push(decodeScalar(lines[index].slice(4), path, key));
    }
    data.set(key, values);
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}
function requiredString(data, field, path) {
  const value = data.get(field);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CreatorSkillMetadataError("SKILL.md metadata is invalid", [
      metadataIssue("invalid_skill_metadata", path, `Creator Skill ${field} is required`, field)
    ]);
  }
  return value.trim();
}
function optionalString(data, field, path) {
  const value = data.get(field);
  if (value === void 0) return void 0;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CreatorSkillMetadataError("SKILL.md metadata is invalid", [
      metadataIssue("invalid_skill_metadata", path, `Creator Skill ${field} must be a non-empty string`, field)
    ]);
  }
  return value.trim();
}
function optionalStrings(data, field, path) {
  const value = data.get(field);
  if (value === void 0) return void 0;
  if (!Array.isArray(value) || value.some((item) => item.length === 0)) {
    throw new CreatorSkillMetadataError("SKILL.md metadata is invalid", [
      metadataIssue("invalid_skill_metadata", path, `Creator Skill ${field} must be an array of strings`, field)
    ]);
  }
  return value;
}
function parseCreatorSkillMetadata(entries) {
  const businessEntries = entries.filter((entry) => entry.path.length > 0 && !isCreatorSkillPackagingNoise(entry.path));
  const roots = new Set(businessEntries.map((entry) => entry.path.replace(/\/$/, "").split("/")[0]).filter(Boolean));
  if (roots.size !== 1) {
    throw new CreatorSkillMetadataError("ZIP must contain exactly one root directory", [
      metadataIssue("multiple_root_directories", "", "ZIP must contain exactly one root directory")
    ]);
  }
  const skillEntries = businessEntries.filter((entry) => !entry.directory && entry.path.split("/").at(-1)?.toLocaleLowerCase("en-US") === "skill.md");
  if (skillEntries.length === 0) {
    throw new CreatorSkillMetadataError("ZIP is missing SKILL.md", [
      metadataIssue("missing_skill_file", "SKILL.md", "Add one root-level SKILL.md file")
    ]);
  }
  if (skillEntries.length !== 1) {
    throw new CreatorSkillMetadataError("ZIP contains multiple SKILL.md files", [
      metadataIssue("multiple_skill_files", "SKILL.md", "Keep exactly one root-level SKILL.md file")
    ]);
  }
  const skillEntry = skillEntries[0];
  const rootDirectory = skillEntry.path.split("/")[0];
  if (skillEntry.path !== `${rootDirectory}/SKILL.md`) {
    throw new CreatorSkillMetadataError("SKILL.md must be at the ZIP root", [
      metadataIssue("skill_file_not_root", skillEntry.path, "Place SKILL.md directly under the Skill root directory")
    ]);
  }
  const content = readContent(skillEntry);
  const { data, body } = parseFrontmatter(content, skillEntry.path);
  const name = requiredString(data, "name", skillEntry.path);
  const description = requiredString(data, "description", skillEntry.path);
  const issues = [];
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    issues.push(metadataIssue("invalid_skill_metadata", skillEntry.path, "Creator Skill name must use strict kebab-case (for example, polo-test)", "name"));
  }
  if (description.length > 1024) {
    issues.push(metadataIssue("invalid_skill_metadata", skillEntry.path, "Creator Skill description must be at most 1024 characters", "description"));
  }
  if (name !== rootDirectory) {
    issues.push(metadataIssue(
      "invalid_skill_metadata",
      skillEntry.path,
      `Creator Skill name '${name}' must match root directory '${rootDirectory}'`,
      "name",
      `Use 'name: ${rootDirectory}' or rename the root directory`
    ));
  }
  if (issues.length > 0) throw new CreatorSkillMetadataError("SKILL.md metadata is invalid", issues);
  const globs = optionalStrings(data, "globs", skillEntry.path);
  const alwaysAllow = optionalStrings(data, "alwaysAllow", skillEntry.path);
  const icon = optionalString(data, "icon", skillEntry.path);
  const requiredSources = optionalStrings(data, "requiredSources", skillEntry.path);
  return {
    slug: name,
    metadata: {
      name,
      description,
      ...globs ? { globs } : {},
      ...alwaysAllow ? { alwaysAllow } : {},
      ...icon ? { icon } : {},
      ...requiredSources ? { requiredSources } : {}
    },
    body
  };
}
export {
  CreatorSkillMetadataError,
  isCreatorSkillPackagingNoise,
  parseCreatorSkillMetadata
};
