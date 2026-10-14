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

it('enterprise discovery never falls back to personal local Skills when canonical authority fails', async () => {
  const root=await mkdtemp(join(tmpdir(),'polo-enterprise-skill-isolation-'))
  try {
    await mkdir(join(root,'skills/private-helper'),{recursive:true})
    await writeFile(join(root,'skills/private-helper/SKILL.md'),'---\nname: private-helper\ndescription: Personal only.\n---\nPrivate instructions.')
    const agent=new Consumer(createMockBackendConfig({workspace:createMockWorkspace({rootPath:root}),canonicalSkills:{allowLocalSkills:async()=>false,load:async()=>{throw new Error('Enterprise catalog unavailable')},authorize:async()=>{},finish:async()=>{}}} as any))
    const events=[];for await(const event of agent.chat('[skill:private-helper] make a report')) events.push(event)
    expect(events.some(event=>event.type==='error' && event.message.includes('not found'))).toBe(true)
    expect(agent.chatCalls).toHaveLength(0)
  } finally {await rm(root,{recursive:true,force:true})}
})
