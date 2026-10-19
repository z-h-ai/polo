/**
 * Skills Storage
 *
 * CRUD operations for workspace skills.
 * Skills are stored in {workspace}/skills/{slug}/ directories.
 */

import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
} from 'fs';
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve, sep } from 'path';
import matter from 'gray-matter';
import type { LoadedSkill, SkillMetadata, SkillSource } from './types.ts';
import { getBundledSkillsRoot } from './bundled.ts';
import { getWorkspaceSkillsPath } from '../workspaces/storage.ts';
import {
  validateIconValue,
  findIconFile,
  downloadIcon,
  needsIconDownload,
  isIconUrl,
} from '../utils/icon.ts';

// ============================================================
// Agent Skills Paths (Issue #171)
// ============================================================

/** Global agent skills directory: ~/.agents/skills/ */
export const GLOBAL_AGENT_SKILLS_DIR = join(homedir(), '.agents', 'skills');

/** Project-level agent skills relative directory name */
export const PROJECT_AGENT_SKILLS_DIR = '.agents/skills';

/**
 * Normalize requiredSources frontmatter to a clean string array.
 * Accepts a single string or array of strings, trims whitespace, and deduplicates.
 */
function normalizeRequiredSources(value: unknown): string[] | undefined {
  const asArray = typeof value === 'string'
    ? [value]
    : Array.isArray(value)
      ? value
      : undefined;

  if (!asArray) return undefined;

  const normalized = Array.from(new Set(
    asArray
      .filter((entry): entry is string => typeof entry === 'string')
      .map(entry => entry.trim())
      .filter(Boolean)
  ));

  return normalized.length > 0 ? normalized : undefined;
}

// ============================================================
// Parsing
// ============================================================

/**
 * Parse SKILL.md content and extract frontmatter + body
 */
function parseSkillFile(content: string): { metadata: SkillMetadata; body: string } | null {
  try {
    const parsed = matter(content);

    // Validate required fields
    if (!parsed.data.name || !parsed.data.description) {
      return null;
    }

    // Validate and extract optional icon field
    // Only accepts emoji or URL - rejects inline SVG and relative paths
    const icon = validateIconValue(parsed.data.icon, 'Skills');

    return {
      metadata: {
        name: parsed.data.name as string,
        description: parsed.data.description as string,
        globs: parsed.data.globs as string[] | undefined,
        alwaysAllow: parsed.data.alwaysAllow as string[] | undefined,
        icon,
        requiredSources: normalizeRequiredSources(parsed.data.requiredSources),
      },
      body: parsed.content,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Load Operations
// ============================================================

/**
 * Load a single skill from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param slug - Skill directory name
 * @param source - Where this skill is loaded from
 */
function loadSkillFromDir(skillsDir: string, slug: string, source: SkillSource): LoadedSkill | null {
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  // Check directory exists
  if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
    return null;
  }

  // Check SKILL.md exists
  if (!existsSync(skillFile)) {
    return null;
  }

  // Read and parse SKILL.md
  let content: string;
  try {
    content = readFileSync(skillFile, 'utf-8');
  } catch {
    return null;
  }

  const parsed = parseSkillFile(content);
  if (!parsed) {
    return null;
  }

  return {
    slug,
    metadata: parsed.metadata,
    content: parsed.body,
    iconPath: findIconFile(skillDir),
    path: skillDir,
    source,
  };
}

/**
 * Load all skills from a directory
 * @param skillsDir - Absolute path to skills directory
 * @param source - Where these skills are loaded from
 */
function loadSkillsFromDir(skillsDir: string, source: SkillSource): LoadedSkill[] {
  if (!existsSync(skillsDir)) {
    return [];
  }

  const skills: LoadedSkill[] = [];

  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skill = loadSkillFromDir(skillsDir, entry.name, source);
      if (skill) {
        skills.push(skill);
      }
    }
  } catch {
    // Ignore errors reading skills directory
  }

  return skills;
}

/**
 * Load a single skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function loadSkill(workspaceRoot: string, slug: string): LoadedSkill | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillFromDir(skillsDir, slug, 'workspace');
}

/**
 * Load all skills from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function loadWorkspaceSkills(workspaceRoot: string): LoadedSkill[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  return loadSkillsFromDir(skillsDir, 'workspace');
}

// ── Skills cache ────────────────────────────────────────────────────────
// loadAllSkills reads from up to 3 directories on every call (~100ms).
// The result rarely changes during a session, so we cache it per
// (workspaceRoot, projectRoot) pair with a 5-minute safety TTL.

const skillsCache = new Map<string, { skills: LoadedSkill[]; ts: number }>();
const SKILLS_CACHE_TTL = 5 * 60_000; // 5 minutes

/** Invalidate the skills cache (call on working dir change or skill file events). */
export function invalidateSkillsCache(): void {
  skillsCache.clear();
}

/**
 * One skill directory tier. Ordered lowest priority first; a later tier
 * overrides earlier tiers on slug clash.
 */
interface SkillTier {
  dir: string;
  source: SkillSource;
}

/**
 * The single ordering of skill directories shared by loadAllSkills() and
 * loadSkillBySlug() so a slug resolves to the same skill in list and
 * single-item lookups. Bundled app skills sit below every user tier:
 * bundled < global < workspace < project.
 */
function skillTiers(workspaceRoot: string, projectRoot?: string, globalSkillsRoot = GLOBAL_AGENT_SKILLS_DIR): SkillTier[] {
  const tiers: SkillTier[] = [];

  const bundledSkillsRoot = getBundledSkillsRoot();
  if (bundledSkillsRoot) {
    tiers.push({ dir: bundledSkillsRoot, source: 'bundled' });
  }

  tiers.push(
    { dir: globalSkillsRoot, source: 'global' },
    { dir: getWorkspaceSkillsPath(workspaceRoot), source: 'workspace' },
  );
  if (projectRoot) {
    tiers.push({ dir: join(projectRoot, PROJECT_AGENT_SKILLS_DIR), source: 'project' });
  }
  return tiers;
}

/**
 * Load the app-shipped bundled skills (read-only, lowest priority tier).
 * Returns an empty array when the runtime ships without bundled skills.
 */
export function loadBundledSkills(): LoadedSkill[] {
  const bundledSkillsRoot = getBundledSkillsRoot();
  return bundledSkillsRoot ? loadSkillsFromDir(bundledSkillsRoot, 'bundled') : [];
}

/**
 * Load a single app-shipped bundled skill by slug.
 */
export function loadBundledSkill(slug: string): LoadedSkill | null {
  const bundledSkillsRoot = getBundledSkillsRoot();
  return bundledSkillsRoot ? loadSkillFromDir(bundledSkillsRoot, slug, 'bundled') : null;
}

/**
 * The bundled tier as actually reachable under the full priority order: for
 * each app-shipped slug, the skill a user lookup resolves to. Without a
 * same-slug user skill that is the bundled entry itself; with one it is the
 * effective user skill, which stays a personal-space asset. Discovery and
 * mentions must agree on this view so a user override never leaves the
 * shadowed bundled readPath advertised.
 */
export function loadEffectiveBundledSkills(workspaceRoot: string, projectRoot?: string, globalSkillsRoot = GLOBAL_AGENT_SKILLS_DIR): LoadedSkill[] {
  const all = loadAllSkills(workspaceRoot, projectRoot, globalSkillsRoot);
  return loadBundledSkills().map(bundled => all.find(skill => skill.slug === bundled.slug) ?? bundled);
}

/**
 * Load all skills from all sources (bundled, global, workspace, project)
 * Skills with the same slug are overridden by higher-priority sources.
 * Priority: bundled (lowest) < global < workspace < project (highest)
 *
 * Results are cached per (workspaceRoot, projectRoot, globalSkillsRoot,
 * bundledSkillsRoot) tuple — the resolved bundled root is part of the key so a
 * late assets-root registration, an app upgrade or a test that swaps roots
 * can never reuse a result computed against a different root. Call
 * invalidateSkillsCache() on working directory changes or skill file events.
 * Note: the config watcher only listens on user directories, so in a dev
 * checkout an edit to the bundled source tree itself stays invisible for up
 * to the 5-minute TTL (packaged apps ship static bundled skills, so this only
 * affects dev iteration; restart or clear the cache to see the change).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param projectRoot - Optional project root (working directory) for project-level skills
 * @param globalSkillsRoot - Optional override of the global skills directory
 */
export function loadAllSkills(workspaceRoot: string, projectRoot?: string, globalSkillsRoot = GLOBAL_AGENT_SKILLS_DIR): LoadedSkill[] {
  const tiers = skillTiers(workspaceRoot, projectRoot, globalSkillsRoot);
  const bundledSkillsRoot = tiers.find(tier => tier.source === 'bundled')?.dir ?? '';
  const cacheKey = JSON.stringify([workspaceRoot, projectRoot ?? '', globalSkillsRoot, bundledSkillsRoot]);
  const now = Date.now();
  const cached = skillsCache.get(cacheKey);
  if (cached && now - cached.ts < SKILLS_CACHE_TTL) {
    return cached.skills;
  }

  const skillsBySlug = new Map<string, LoadedSkill>();
  for (const tier of tiers) {
    for (const skill of loadSkillsFromDir(tier.dir, tier.source)) {
      skillsBySlug.set(skill.slug, skill);
    }
  }

  const result = Array.from(skillsBySlug.values());
  skillsCache.set(cacheKey, { skills: result, ts: now });
  return result;
}

/**
 * Load a single skill by slug from all sources (project > workspace > global > bundled).
 * Unlike loadAllSkills(), this only reads the specific slug directory — O(1) not O(N).
 *
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill slug to load
 * @param projectRoot - Optional project root for project-level skills
 */
export function loadSkillBySlug(workspaceRoot: string, slug: string, projectRoot?: string): LoadedSkill | null {
  const tiers = skillTiers(workspaceRoot, projectRoot);

  // Highest priority first: walk the ordered tiers from the top.
  for (let index = tiers.length - 1; index >= 0; index--) {
    const tier = tiers[index]!;
    const skill = loadSkillFromDir(tier.dir, slug, tier.source);
    if (skill) return skill;
  }
  return null;
}

/**
 * Get icon path for a skill
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function getSkillIconPath(workspaceRoot: string, slug: string): string | null {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);

  if (!existsSync(skillDir)) {
    return null;
  }

  return findIconFile(skillDir) || null;
}

// ============================================================
// Delete Operations
// ============================================================

/**
 * Delete a skill from a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function deleteSkill(workspaceRoot: string, slug: string): boolean {
  try {
    if (
      !slug
      || slug.length > 255
      || slug === '.'
      || slug === '..'
      || slug.includes('/')
      || slug.includes('\\')
      || slug.includes('\0')
    ) return false;

    const canonicalWorkspace = realpathSync(resolve(workspaceRoot));
    const skillsDir = getWorkspaceSkillsPath(canonicalWorkspace);
    if (!existsSync(skillsDir)) return false;
    const canonicalSkillsDir = realpathSync(skillsDir);
    if (!isStrictChildPath(canonicalWorkspace, canonicalSkillsDir)) return false;

    const skillDir = resolve(canonicalSkillsDir, slug);
    if (!isStrictChildPath(canonicalSkillsDir, skillDir) || !existsSync(skillDir)) {
      return false;
    }
    // Refuse all directory-entry symlinks. Even though rm normally unlinks the
    // link itself, deletion must never depend on platform-specific traversal.
    const skillStats = lstatSync(skillDir);
    if (skillStats.isSymbolicLink() || !skillStats.isDirectory()) return false;
    const canonicalSkillDir = realpathSync(skillDir);
    if (!isStrictChildPath(canonicalSkillsDir, canonicalSkillDir)) return false;

    rmSync(skillDir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function isStrictChildPath(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== ''
    && child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}

// ============================================================
// Utility Functions
// ============================================================

/**
 * Check if a skill exists in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 * @param slug - Skill directory name
 */
export function skillExists(workspaceRoot: string, slug: string): boolean {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);
  const skillDir = join(skillsDir, slug);
  const skillFile = join(skillDir, 'SKILL.md');

  return existsSync(skillDir) && existsSync(skillFile);
}

/**
 * List skill slugs in a workspace
 * @param workspaceRoot - Absolute path to workspace root
 */
export function listSkillSlugs(workspaceRoot: string): string[] {
  const skillsDir = getWorkspaceSkillsPath(workspaceRoot);

  if (!existsSync(skillsDir)) {
    return [];
  }

  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        const skillFile = join(skillsDir, entry.name, 'SKILL.md');
        return existsSync(skillFile);
      })
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// ============================================================
// Icon Download (uses shared utilities)
// ============================================================

/**
 * Download an icon from a URL and save it to the skill directory.
 * Returns the path to the downloaded icon, or null on failure.
 */
export async function downloadSkillIcon(
  skillDir: string,
  iconUrl: string
): Promise<string | null> {
  return downloadIcon(skillDir, iconUrl, 'Skills');
}

/**
 * Check if a skill needs its icon downloaded.
 * Returns true if metadata has a URL icon and no local icon file exists.
 */
export function skillNeedsIconDownload(skill: LoadedSkill): boolean {
  return needsIconDownload(skill.metadata.icon, skill.iconPath);
}

// Re-export icon utilities for convenience
export { isIconUrl } from '../utils/icon.ts';
