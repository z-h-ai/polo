/**
 * Read-before-execute behaviour for the app-shipped bundled skill tier (POO-110).
 *
 * Bundled skills ride the same BaseAgent pipeline as every other skill tier:
 * they are discovered through extractSkillPaths, injected by mentions, and
 * read in place. Unlike canonical skills they never enter the turn
 * authorization chain (listing or mentioning one is not a grant), and unlike
 * personal skills they stay readable in enterprise spaces where local skills
 * are disabled.
 */
import { expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestAgent, createMockBackendConfig, createMockWorkspace } from './test-utils.ts'
import { clearBundledAssetsRoot, setBundledAssetsRoot, getBundledAssetsRoot } from '../../utils/paths.ts'
import { BUNDLED_SKILLS_ASSET_DIRNAME } from '../../skills/bundled.ts'

class Consumer extends TestAgent {
  check(tool: string, input: Record<string, unknown>) { return this.checkCanonicalSkillUse(tool, input) }
}

const BUNDLED_SLUG = 'polo-upload-app'

async function writeBundledFixture(root: string, slug: string, name: string, description: string) {
  const dir = join(root, 'electron', 'resources', BUNDLED_SKILLS_ASSET_DIRNAME, slug)
  await mkdir(dir, { recursive: true })
  const body = `---\nname: "${name}"\ndescription: "${description}"\n---\n\nBundled instructions for ${name}.\n`
  await writeFile(join(dir, 'SKILL.md'), body)
  return { dir, file: join(dir, 'SKILL.md'), body }
}

it('an enterprise space with local Skills disabled can still mention and read bundled Skills, while personal Skills stay denied', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-bundled-enterprise-'))
  const savedAssetsRoot = getBundledAssetsRoot()
  try {
    const bundled = await writeBundledFixture(root, BUNDLED_SLUG, 'Upload an App to Polo', 'Explain how to submit an App.')
    await mkdir(join(root, 'skills/private-helper'), { recursive: true })
    await writeFile(join(root, 'skills/private-helper/SKILL.md'), '---\nname: private-helper\ndescription: Personal only.\n---\nPrivate instructions.')
    setBundledAssetsRoot(join(root, 'electron'))

    const admissions: string[][] = []
    const agent = new Consumer(createMockBackendConfig({
      workspace: createMockWorkspace({ rootPath: root }),
      canonicalSkills: {
        allowLocalSkills: async () => false,
        load: async () => [],
        authorize: async (paths) => { admissions.push([...paths]) },
        finish: async () => {},
      },
    }))

    const turn = agent.chat(`[skill:${BUNDLED_SLUG}] prepare the upload`)
    const firstEvent = await turn.next()
    expect(firstEvent.value.type).not.toBe('error')

    const injected = agent.chatCalls[0]!.message
    expect(injected).toContain('Upload an App to Polo')
    expect(injected).toContain(bundled.file)
    // Mentioning a bundled skill must not spend turn authorization.
    expect(admissions).toHaveLength(0)
    expect(agent.chatCalls).toHaveLength(1)

    // Same turn: bundled files stay readable without authorization...
    expect(await agent.check('Read', { file_path: bundled.file })).toBeNull()
    // ...while personal skill instructions remain denied.
    expect(await agent.check('Read', { file_path: join(root, 'skills/private-helper/SKILL.md') })).toContain('Personal')
    await turn.return(undefined as never)
  } finally {
    if (savedAssetsRoot === undefined) clearBundledAssetsRoot()
    else setBundledAssetsRoot(savedAssetsRoot)
    await rm(root, { recursive: true, force: true })
  }
})

it('bundled Skills never enter the canonical authorization chain while canonical Skills still authorize normally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-bundled-canonical-'))
  const savedAssetsRoot = getBundledAssetsRoot()
  try {
    const bundled = await writeBundledFixture(root, BUNDLED_SLUG, 'Upload an App to Polo', 'Explain how to submit an App.')
    const canonicalPath = join(root, '.polo/canonical-skills', 'a'.repeat(64), 'skills/team-helper')
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'SKILL.md'), '---\nname: team-helper\ndescription: Use for reports.\n---\nRead inputs and report.')
    setBundledAssetsRoot(join(root, 'electron'))

    const canonical = {
      slug: `canonical-${'a'.repeat(64)}`,
      metadata: { name: 'team-helper', description: 'Use for reports.' },
      content: 'Read inputs and report.',
      path: canonicalPath,
      source: 'workspace' as const,
    }
    const authorized: string[][] = []
    const agent = new Consumer(createMockBackendConfig({
      workspace: createMockWorkspace({ rootPath: root }),
      canonicalSkills: {
        load: async () => [canonical],
        authorize: async (paths) => { authorized.push([...paths]) },
        finish: async () => {},
      },
    }))

    const turn = agent.chat(`[skill:${BUNDLED_SLUG}] and [skill:canonical-${'a'.repeat(64)}] prepare a team report`)
    await turn.next()

    // Only the canonical skill directory was authorized; the bundled skill
    // directory appears in the turn instructions but never in the grant.
    expect(authorized).toHaveLength(1)
    expect(authorized[0]!.some(path => path.startsWith(join(root, '.polo/canonical-skills')))).toBe(true)
    expect(authorized[0]!.some(path => path.startsWith(bundled.dir))).toBe(false)
    expect(await agent.check('Read', { file_path: bundled.file })).toBeNull()
    expect(await agent.check('Read', { file_path: join(canonicalPath, 'SKILL.md') })).toBeNull()
    await turn.return(undefined as never)
  } finally {
    if (savedAssetsRoot === undefined) clearBundledAssetsRoot()
    else setBundledAssetsRoot(savedAssetsRoot)
    await rm(root, { recursive: true, force: true })
  }
})

it('after the original turn ends canonical authority expires fail-closed while a backend without the canonical stack still reads bundled Skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-bundled-scope-'))
  const savedAssetsRoot = getBundledAssetsRoot()
  try {
    const bundled = await writeBundledFixture(root, BUNDLED_SLUG, 'Upload an App to Polo', 'Explain how to submit an App.')
    const canonicalPath = join(root, '.polo/canonical-skills', 'a'.repeat(64), 'skills/team-helper')
    await mkdir(canonicalPath, { recursive: true })
    await writeFile(join(canonicalPath, 'SKILL.md'), '---\nname: team-helper\ndescription: Use for reports.\n---\nRead inputs and report.')
    setBundledAssetsRoot(join(root, 'electron'))

    const canonical = {
      slug: `canonical-${'a'.repeat(64)}`,
      metadata: { name: 'team-helper', description: 'Use for reports.' },
      content: 'Read inputs and report.',
      path: canonicalPath,
      source: 'workspace' as const,
    }
    const canonicalAgent = new Consumer(createMockBackendConfig({
      workspace: createMockWorkspace({ rootPath: root }),
      canonicalSkills: { load: async () => [canonical], authorize: async () => {}, finish: async () => {} },
    }))
    const turn = canonicalAgent.chat('Prepare a team report')
    await turn.next()
    await turn.return(undefined as never)

    // The original turn is gone: canonical skill files have no native
    // authority any more and the whole pre-tool check fails closed.
    expect(await canonicalAgent.check('Read', { file_path: join(canonicalPath, 'SKILL.md') })).toContain('no current native authority')

    // A backend host that never wires the canonical stack still reads the
    // bundled tier through the shared BaseAgent pipeline.
    const plainAgent = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }) }))
    const plainTurn = plainAgent.chat(`[skill:${BUNDLED_SLUG}] prepare the upload`)
    await plainTurn.next()
    expect(plainAgent.chatCalls[0]!.message).toContain('Upload an App to Polo')
    expect(await plainAgent.check('Read', { file_path: bundled.file })).toBeNull()
    await plainTurn.return(undefined as never)
  } finally {
    if (savedAssetsRoot === undefined) clearBundledAssetsRoot()
    else setBundledAssetsRoot(savedAssetsRoot)
    await rm(root, { recursive: true, force: true })
  }
})

it('both agent backends share the BaseAgent skill pipeline instead of carrying their own', async () => {
  // The bundled tier is injected once in base-agent.ts. Neither backend may
  // grow a private composition path: if one does, this guard fails and the
  // composition rule must move back into the shared base class.
  const agentDir = new URL('.', import.meta.url).pathname
  for (const backend of ['claude-agent.ts', 'pi-agent.ts']) {
    const source = await readFile(join(agentDir, '..', backend), 'utf-8')
    expect(source.includes('loadAllSkills')).toBe(false)
    expect(source.includes('loadBundledSkills')).toBe(false)
  }
})
