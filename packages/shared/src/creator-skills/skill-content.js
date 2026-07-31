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
  return error.issues.map((issue) => ({
    file,
    path: issue.path.join(".") || "frontmatter",
    message: issue.message,
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
export {
  PortableSkillMetadataSchema,
  isValidCreatorSkillSlug,
  isValidSkillSlug,
  readValidatedSkillMetadata,
  suggestSkillSlug,
  validateCreatorSkillContent,
  validatePortableSkillContent
};
