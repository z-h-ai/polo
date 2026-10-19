import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadProductSpaceSkills, bindCanonicalSkillContextResolver, type CanonicalSkillScope } from '../canonical-skills'
import { managedSkillEnablementFilePath, setManagedSkillsRoot, writeManagedSkillEnablement } from '../managed-skill-enablement'
import { setBundledAssetsRoot, clearBundledAssetsRoot, getBundledAssetsRoot } from '@polo-ai/shared/utils/paths'
import { BUNDLED_SKILLS_ASSET_DIRNAME, invalidateSkillsCache } from '@polo-ai/shared/skills'

const SCOPE: CanonicalSkillScope = { accountId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', productSpaceId: 'ps-one', fenceGeneration: 0 }

function writeSkill(skillsRoot: string, slug: string, name: string): void {
  const dir = join(skillsRoot, slug)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} description\n---\n\nBody.\n`)
}

let tempDir: string
let workspaceRoot: string
let savedAssetsRoot: string | undefined

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'skills-managed-filter-'))
  workspaceRoot = join(tempDir, 'workspace')
  mkdirSync(join(workspaceRoot, 'skills'), { recursive: true })
  savedAssetsRoot = getBundledAssetsRoot()
  setBundledAssetsRoot(join(tempDir, 'electron'))
  mkdirSync(join(tempDir, 'electron', 'resources', BUNDLED_SKILLS_ASSET_DIRNAME), { recursive: true })
  writeSkill(join(tempDir, 'electron', 'resources', BUNDLED_SKILLS_ASSET_DIRNAME), 'bundled-helper', 'Bundled Helper')
  writeSkill(join(workspaceRoot, 'skills'), 'review-skill', 'Review Skill')
  setManagedSkillsRoot(join(tempDir, 'managed-skills'))
  bindCanonicalSkillContextResolver(async () => ({ id: SCOPE.productSpaceId, kind: 'personal', accessMode: 'active' } as never))
  invalidateSkillsCache()
})

afterEach(() => {
  bindCanonicalSkillContextResolver(async () => { throw new Error('Skill ProductSpace authority unavailable') })
  setManagedSkillsRoot(null)
  clearBundledAssetsRoot()
  if (savedAssetsRoot) setBundledAssetsRoot(savedAssetsRoot)
  invalidateSkillsCache()
  rmSync(tempDir, { recursive: true, force: true })
})

/** The host machine may carry real global skills; assert relatively. */
function slugs(skills: Awaited<ReturnType<typeof loadProductSpaceSkills>>): string[] {
  return skills.map(skill => skill.slug)
}

describe('loadProductSpaceSkills managed-enablement filter', () => {
  it('returns bundled and local skills when nothing is disabled', async () => {
    const skills = slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))
    expect(skills).toContain('bundled-helper')
    expect(skills).toContain('review-skill')
  })

  it('drops a disabled local skill from composition (SM-09)', async () => {
    const before = slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))
    const write = writeManagedSkillEnablement({
      accountId: SCOPE.accountId,
      workspaceRoot,
      slug: 'review-skill',
      source: 'workspace',
      enabled: false,
    })
    expect(write.ok).toBe(true)
    const after = slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))
    expect(after).toContain('bundled-helper')
    expect(after).toEqual(before.filter(slug => slug !== 'review-skill'))
  })

  it('restores a local skill after it is re-enabled', async () => {
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'review-skill', source: 'workspace', enabled: false })
    expect(slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))).not.toContain('review-skill')
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'review-skill', source: 'workspace', enabled: true })
    expect(slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))).toContain('review-skill')
  })

  it('never disables a bundled skill even if a stray slug is stored (SM-18d)', async () => {
    const before = slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'bundled-helper', source: 'workspace', enabled: false })
    expect(slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))).toEqual(before)
  })

  it('reflects a revision bump without an explicit cache invalidation', async () => {
    expect(slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))).toContain('review-skill')
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'review-skill', source: 'workspace', enabled: false })
    // The composition memo keys on the enablement document identity, which
    // moves with every revision bump — no invalidateSkillsCache() call needed.
    expect(slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))).not.toContain('review-skill')
  })

  it('refreshes the disabled set when mtime and size repeat across writes (M2)', async () => {
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'review-skill', source: 'workspace', enabled: false })
    expect(slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))).not.toContain('review-skill')
    const filePath = managedSkillEnablementFilePath(SCOPE.accountId, workspaceRoot)
    const staleStats = statSync(filePath)
    // Re-enable the 12-char slug, then disable another 12-char slug: same byte
    // length. Pinning the earlier mtime reproduces the exact mtime+size
    // collision the memo key must survive.
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'review-skill', source: 'workspace', enabled: true })
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'rival-skillx', source: 'workspace', enabled: false })
    utimesSync(filePath, staleStats.mtimeMs / 1000, staleStats.mtimeMs / 1000)
    const repeated = statSync(filePath)
    expect(`${repeated.mtimeMs}:${repeated.size}`).toBe(`${staleStats.mtimeMs}:${staleStats.size}`)
    const after = slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))
    expect(after).toContain('review-skill')
    expect(after).not.toContain('rival-skillx')
  })

  it('returns only bundled skills in an active enterprise space', async () => {
    bindCanonicalSkillContextResolver(async () => ({ id: SCOPE.productSpaceId, kind: 'enterprise', accessMode: 'active' } as never))
    writeManagedSkillEnablement({ accountId: SCOPE.accountId, workspaceRoot, slug: 'bundled-helper', source: 'workspace', enabled: false })
    expect(slugs(await loadProductSpaceSkills(workspaceRoot, SCOPE))).toEqual(['bundled-helper'])
  })
})
