/**
 * ProductSpace discovery of the app-shipped bundled skill tier (POO-110).
 *
 * loadProductSpaceSkills is the single composition rule behind the RPC skill
 * list, SessionManager broadcasts and automation mentions. An active space
 * discovers bundled skills in every ProductSpace kind, but only a personal
 * active space may additionally read the personal legacy roots; a read_only
 * space starts no local skill work at all.
 */
import { expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindCanonicalSkillContextResolver, loadProductSpaceSkills, type CanonicalSkillScope } from '../canonical-skills'
import { clearBundledAssetsRoot, setBundledAssetsRoot, getBundledAssetsRoot } from '@polo-ai/shared/utils/paths'
import { BUNDLED_SKILLS_ASSET_DIRNAME, getBundledSkillsRoot } from '@polo-ai/shared/skills'

const scope: CanonicalSkillScope = {
  accountId: randomUUID(),
  productSpaceId: randomUUID(),
  fenceGeneration: 1,
}

it('an active enterprise space discovers bundled Skills and canonical Skills but no personal local Skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-space-bundled-enterprise-'))
  const savedAssetsRoot = getBundledAssetsRoot()
  try {
    await mkdir(join(root, 'skills/private-helper'), { recursive: true })
    await writeFile(join(root, 'skills/private-helper/SKILL.md'), '---\nname: private-helper\ndescription: Personal only.\n---\nPrivate instructions.')
    await mkdir(join(root, 'electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME, 'polo-upload-app'), { recursive: true })
    await writeFile(join(root, 'electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME, 'polo-upload-app/SKILL.md'), '---\nname: "Upload an App to Polo"\ndescription: "Enterprise guide."\n---\nBundled instructions.')
    setBundledAssetsRoot(join(root, 'electron'))

    bindCanonicalSkillContextResolver(async () => ({ id: scope.productSpaceId, kind: 'enterprise', accessMode: 'active' }) as never)
    const skills = await loadProductSpaceSkills(root, scope)

    const bundled = skills.filter(row => row.source === 'bundled')
    expect(bundled.map(row => row.slug)).toEqual(['polo-upload-app'])
    expect(bundled[0]!.metadata.name).toBe('Upload an App to Polo')
    expect(skills.some(row => row.slug === 'private-helper')).toBe(false)
  } finally {
    if (savedAssetsRoot === undefined) clearBundledAssetsRoot()
    else setBundledAssetsRoot(savedAssetsRoot)
    await rm(root, { recursive: true, force: true })
  }
})

it('a personal active space keeps its local Skills and still sees the bundled tier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-space-bundled-personal-'))
  const savedAssetsRoot = getBundledAssetsRoot()
  try {
    await mkdir(join(root, 'skills/private-helper'), { recursive: true })
    await writeFile(join(root, 'skills/private-helper/SKILL.md'), '---\nname: private-helper\ndescription: Personal only.\n---\nPrivate instructions.')
    await mkdir(join(root, 'electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME, 'polo-upload-skill'), { recursive: true })
    await writeFile(join(root, 'electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME, 'polo-upload-skill/SKILL.md'), '---\nname: "Upload a Skill to Polo"\ndescription: "Personal guide."\n---\nBundled instructions.')
    setBundledAssetsRoot(join(root, 'electron'))

    bindCanonicalSkillContextResolver(async () => ({ id: scope.productSpaceId, kind: 'personal', accessMode: 'active' }) as never)
    const skills = await loadProductSpaceSkills(root, scope)

    expect(skills.find(row => row.slug === 'private-helper')?.source).toBe('workspace')
    expect(skills.find(row => row.slug === 'polo-upload-skill')?.source).toBe('bundled')
  } finally {
    if (savedAssetsRoot === undefined) clearBundledAssetsRoot()
    else setBundledAssetsRoot(savedAssetsRoot)
    await rm(root, { recursive: true, force: true })
  }
})

it('a read_only space and a mid-discovery policy change expose no bundled or local Skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-space-bundled-readonly-'))
  const savedAssetsRoot = getBundledAssetsRoot()
  try {
    await mkdir(join(root, 'skills/private-helper'), { recursive: true })
    await writeFile(join(root, 'skills/private-helper/SKILL.md'), '---\nname: private-helper\ndescription: Personal only.\n---\nPrivate instructions.')
    await mkdir(join(root, 'electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME, 'polo-upload-app'), { recursive: true })
    await writeFile(join(root, 'electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME, 'polo-upload-app/SKILL.md'), '---\nname: "Upload an App to Polo"\ndescription: "Enterprise guide."\n---\nBundled instructions.')
    setBundledAssetsRoot(join(root, 'electron'))

    bindCanonicalSkillContextResolver(async () => ({ id: scope.productSpaceId, kind: 'enterprise', accessMode: 'read_only' }) as never)
    expect(await loadProductSpaceSkills(root, scope)).toEqual([])

    let reads = 0
    bindCanonicalSkillContextResolver(async () => ({
      id: scope.productSpaceId,
      kind: 'personal',
      accessMode: ++reads === 1 ? 'active' : 'read_only',
    }) as never)
    await expect(loadProductSpaceSkills(root, scope)).rejects.toThrow('policy changed')
  } finally {
    if (savedAssetsRoot === undefined) clearBundledAssetsRoot()
    else setBundledAssetsRoot(savedAssetsRoot)
    await rm(root, { recursive: true, force: true })
  }
})

it('the dev checkout ships both upload guide Skills and they state that upload is not connected yet', async () => {
  // Outside a packaged app the bundled root falls back to the monorepo's
  // apps/electron/resources/builtin-skills — the same directory copy-assets
  // stages into dist/resources for packaging.
  const expected = join(import.meta.dir, '../../../../../apps/electron/resources', BUNDLED_SKILLS_ASSET_DIRNAME)
  const root = getBundledSkillsRoot()
  expect(root).toBe(expected)

  const slugs = ['polo-upload-app', 'polo-upload-skill']
  for (const slug of slugs) {
    const source = await readFile(join(expected, slug, 'SKILL.md'), 'utf-8')
    expect(source).toMatch(/^name: "/m)
    expect(source).toContain('has not connected')
    expect(source.toLowerCase()).not.toContain('curl ')
  }
})
