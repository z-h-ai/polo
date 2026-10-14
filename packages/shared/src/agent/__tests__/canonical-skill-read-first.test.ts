import { expect, it } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestAgent, createMockBackendConfig, createMockWorkspace } from './test-utils.ts'

class Consumer extends TestAgent {
  check(tool: string, input: Record<string, unknown>) { return this.checkCanonicalSkillUse(tool, input) }
}
it('an automatically discovered Skill Read stays authorized for all later tools in its original turn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'polo-skill-read-first-'))
  try {
    const path = join(root, '.polo/canonical-skills', 'a'.repeat(64), 'skills/team-helper')
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), '---\nname: team-helper\ndescription: Use for reports.\n---\nRead inputs and report.')
    let permitted = true
    const checks: string[] = []
    const skill = { slug: `canonical-${'a'.repeat(64)}`, metadata: { name: 'team-helper', description: 'Use for reports.' }, content: 'Read inputs and report.', path, source: 'workspace' as const }
    const agent = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), canonicalSkills: { load: async () => [skill], authorize: async (_paths, turnId) => { checks.push(turnId); if (!permitted) throw new Error('User disabled the skill') }, finish: async () => {} } }))
    const turn = agent.chat('Prepare a team report')
    await turn.next()
    expect(await agent.check('Read', { file_path: join(path, 'SKILL.md') })).toBeNull()
    permitted = false
    expect(await agent.check('Bash', { command: 'echo continue report' })).toContain('unavailable')
    expect(await agent.check('WebFetch', { url: 'https://example.invalid/report' })).toContain('unavailable')
    expect(checks).toHaveLength(3)
    expect(new Set(checks).size).toBe(1)
    await turn.return(undefined as never)
  } finally { await rm(root, { recursive: true, force: true }) }
})
