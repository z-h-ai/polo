/**
 * Tests for the app-shipped bundled skill tier (POO-110).
 *
 * Bundled skills live in apps/electron/resources/builtin-skills/ and are read
 * in place — they are never copied into a user directory. The tier has the
 * lowest priority: bundled < global < workspace < project, so a same-slug
 * user skill always wins.
 *
 * The fixture simulates a packaged app root via setBundledAssetsRoot
 * (candidate 1 of the bundled-assets resolution chain) so these tests do not
 * depend on the repository checkout or the developer's ~/.agents directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  loadAllSkills,
  loadSkillBySlug,
  loadBundledSkills,
  loadBundledSkill,
  invalidateSkillsCache,
} from '../storage.ts';
import { BUNDLED_SKILLS_ASSET_DIRNAME, getBundledSkillsRoot } from '../bundled.ts';
import { clearBundledAssetsRoot, getBundledAssetsRoot, setBundledAssetsRoot } from '../../utils/paths.ts';

// ============================================================
// Fixture helpers
// ============================================================

let tempDir: string;
let assetsRoot: string;
let bundledRoot: string;
let globalRoot: string;
let workspaceRoot: string;
let projectRoot: string;

const savedAssetsRoot = getBundledAssetsRoot();

/** Write a valid SKILL.md under <skillsRoot>/<slug>/ */
function writeSkill(skillsRoot: string, slug: string, name: string, description: string): void {
  const skillDir = join(skillsRoot, slug);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\nBody of ${name}.\n`,
  );
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-bundled-'));
  assetsRoot = join(tempDir, 'electron');
  bundledRoot = join(assetsRoot, 'resources', BUNDLED_SKILLS_ASSET_DIRNAME);
  globalRoot = join(tempDir, 'global-skills');
  workspaceRoot = join(tempDir, 'workspace');
  projectRoot = join(tempDir, 'project');
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true });
  mkdirSync(globalRoot, { recursive: true });
  // A packaged app always ships the builtin-skills directory, even when a
  // specific build carries no skills inside it.
  mkdirSync(bundledRoot, { recursive: true });
  setBundledAssetsRoot(assetsRoot);
  invalidateSkillsCache();
});

afterEach(() => {
  invalidateSkillsCache();
  rmSync(tempDir, { recursive: true, force: true });
  // Restore whatever root the surrounding environment had registered; when it
  // was unset, restore "unset" so the dev fallback candidates stay in effect.
  if (savedAssetsRoot === undefined) {
    clearBundledAssetsRoot();
  } else {
    setBundledAssetsRoot(savedAssetsRoot);
  }
});

// ============================================================
// Root resolution
// ============================================================

describe('getBundledSkillsRoot', () => {
  it('resolves through the packaged assets root before the dev fallback', () => {
    expect(getBundledSkillsRoot()).toBe(bundledRoot);
  });

  it('still resolves a usable bundled root when the packaged assets root is missing', () => {
    // The packaged root does not exist, so resolution falls through to the
    // monorepo dev checkout — its source directory, or the dist/resources
    // staging copy when one has been built. Either way the skills it serves
    // must be the real shipped upload guides, byte-identical to the source.
    const repoSource = resolve(import.meta.dir, '../../../../../apps/electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME);
    setBundledAssetsRoot(join(tempDir, 'nonexistent-root'));

    const root = getBundledSkillsRoot();
    expect(root).toBeDefined();
    expect(root!.endsWith(join('resources', BUNDLED_SKILLS_ASSET_DIRNAME))).toBe(true);

    const bundled = loadBundledSkills();
    expect(bundled.length).toBeGreaterThan(0);
    for (const skill of bundled) {
      expect(skill.source).toBe('bundled');
      expect(skill.path.startsWith(root!)).toBe(true);
      expect(readFileSync(join(skill.path, 'SKILL.md'), 'utf-8'))
        .toBe(readFileSync(join(repoSource, skill.slug, 'SKILL.md'), 'utf-8'));
    }
    expect(bundled.map(s => s.slug)).toContain('polo-upload-app');
    expect(bundled.map(s => s.slug)).toContain('polo-upload-skill');
  });

  it('returns no root when neither the assets root nor the dev fallback exists', () => {
    // Simulate a packaged root without builtin-skills running outside a dev
    // checkout: every candidate misses and the app ships no bundled skills.
    setBundledAssetsRoot(join(tempDir, 'nonexistent-root'));
    const originalCwd = process.cwd();
    const outsideDir = mkdtempSync(join(tmpdir(), 'skills-bundled-cwd-'));
    try {
      process.chdir(outsideDir);
      expect(getBundledSkillsRoot()).toBeUndefined();
      expect(loadBundledSkills()).toEqual([]);
      expect(loadBundledSkill('polo-upload-app')).toBeNull();
    } finally {
      process.chdir(originalCwd);
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

// ============================================================
// Composition rules
// ============================================================

describe('bundled tier composition', () => {
  it('discovers bundled skills with empty user tiers', () => {
    writeSkill(bundledRoot, 'bundled_only', 'Bundled Only', 'Ships with the app');

    const skills = loadAllSkills(workspaceRoot, undefined, globalRoot);
    const bundled = skills.find(s => s.slug === 'bundled_only');

    expect(bundled).toBeDefined();
    expect(bundled!.source).toBe('bundled');
    expect(bundled!.path).toBe(join(bundledRoot, 'bundled_only'));
  });

  it('lets every user tier override a same-slug bundled skill', () => {
    writeSkill(bundledRoot, 'dup', 'Bundled Dup', 'Bundled version');
    writeSkill(globalRoot, 'dup', 'Global Dup', 'Global version');
    writeSkill(join(workspaceRoot, 'skills'), 'dup', 'Workspace Dup', 'Workspace version');
    writeSkill(join(projectRoot, '.agents', 'skills'), 'dup', 'Project Dup', 'Project version');

    // With every tier present the project version wins.
    const all = loadAllSkills(workspaceRoot, projectRoot, globalRoot);
    const dupEntries = all.filter(s => s.slug === 'dup');
    expect(dupEntries).toHaveLength(1);
    expect(dupEntries[0]!.source).toBe('project');
    expect(dupEntries[0]!.metadata.name).toBe('Project Dup');
    expect(loadSkillBySlug(workspaceRoot, 'dup', projectRoot)?.source).toBe('project');

    // Without the project tier the workspace version wins...
    const withoutProject = loadAllSkills(workspaceRoot, undefined, globalRoot);
    expect(withoutProject.find(s => s.slug === 'dup')?.source).toBe('workspace');
    expect(loadSkillBySlug(workspaceRoot, 'dup')?.source).toBe('workspace');

    // ...and an empty workspace without project leaves the global fixture
    // version (loadSkillBySlug reads the real global directory, so the
    // global tier is asserted through the list loader only).
    const emptyWorkspace = mkdtempSync(join(tmpdir(), 'skills-bundled-empty-'));
    mkdirSync(join(emptyWorkspace, 'skills'), { recursive: true });
    try {
      const globalOnly = loadAllSkills(emptyWorkspace, undefined, globalRoot);
      expect(globalOnly.find(s => s.slug === 'dup')?.source).toBe('global');
    } finally {
      rmSync(emptyWorkspace, { recursive: true, force: true });
    }
  });

  it('falls through to bundled when no user tier has the slug', () => {
    writeSkill(bundledRoot, 'bundled_only', 'Bundled Only', 'Ships with the app');
    writeSkill(globalRoot, 'unrelated', 'Unrelated', 'User-owned skill');

    const skill = loadSkillBySlug(workspaceRoot, 'bundled_only', projectRoot);
    expect(skill).not.toBeNull();
    expect(skill!.source).toBe('bundled');
    expect(skill!.metadata.name).toBe('Bundled Only');
  });

  it('agrees between list loading and single-item loading for the bundled tier', () => {
    writeSkill(bundledRoot, 'bundled_only', 'Bundled Only', 'Ships with the app');
    writeSkill(bundledRoot, 'second_bundled', 'Second Bundled', 'Also ships');

    const listed = loadAllSkills(workspaceRoot, projectRoot, globalRoot);
    const bundledFromList = listed.filter(s => s.source === 'bundled');
    const bundledDirect = loadBundledSkills();

    expect(bundledDirect.map(s => s.slug).sort())
      .toEqual(bundledFromList.map(s => s.slug).sort());
    for (const skill of bundledDirect) {
      const fromList = listed.find(s => s.slug === skill.slug);
      expect(fromList?.path).toBe(skill.path);
      expect(fromList?.source).toBe(skill.source);
      const single = loadBundledSkill(skill.slug);
      expect(single?.path).toBe(skill.path);
      expect(single?.metadata.name).toBe(skill.metadata.name);
    }
  });
});

// ============================================================
// Cache correctness
// ============================================================

describe('bundled tier caching', () => {
  it('does not reuse cache entries computed against a different bundled root', () => {
    const assetsRootA = join(tempDir, 'electron-a');
    const assetsRootB = join(tempDir, 'electron-b');
    for (const root of [assetsRootA, assetsRootB]) {
      writeSkill(join(root, 'resources', BUNDLED_SKILLS_ASSET_DIRNAME), 'cached_slug', `Name ${root.slice(-1).toUpperCase()}`, 'Bundled');
    }

    setBundledAssetsRoot(assetsRootA);
    invalidateSkillsCache();
    const fromA = loadAllSkills(workspaceRoot, undefined, globalRoot);
    expect(fromA.find(s => s.slug === 'cached_slug')?.metadata.name).toBe('Name A');

    // No invalidateSkillsCache() in between: the resolved bundled root is part
    // of the cache key, so the late re-registration must not reuse A's result.
    setBundledAssetsRoot(assetsRootB);
    const fromB = loadAllSkills(workspaceRoot, undefined, globalRoot);
    expect(fromB.find(s => s.slug === 'cached_slug')?.metadata.name).toBe('Name B');

    setBundledAssetsRoot(assetsRootA);
    const backToA = loadAllSkills(workspaceRoot, undefined, globalRoot);
    expect(backToA.find(s => s.slug === 'cached_slug')?.metadata.name).toBe('Name A');
  });
});

// ============================================================
// Packaging
// ============================================================

describe('resource staging', () => {
  it('stages builtin-skills into dist/resources for packaging', async () => {
    const { stageResources } = await import('../../../../../apps/electron/scripts/copy-assets.ts');

    writeSkill(bundledRoot, 'polo-upload-app', 'Upload an App to Polo', 'Guide');
    writeSkill(bundledRoot, 'polo-upload-skill', 'Upload a Skill to Polo', 'Guide');

    stageResources(assetsRoot);

    const stagedDir = join(assetsRoot, 'dist', 'resources', BUNDLED_SKILLS_ASSET_DIRNAME);
    expect(existsSync(stagedDir)).toBe(true);
    for (const slug of ['polo-upload-app', 'polo-upload-skill']) {
      const stagedFile = join(stagedDir, slug, 'SKILL.md');
      expect(existsSync(stagedFile)).toBe(true);
      expect(readFileSync(stagedFile, 'utf-8'))
        .toBe(readFileSync(join(bundledRoot, slug, 'SKILL.md'), 'utf-8'));
    }
  });
});
