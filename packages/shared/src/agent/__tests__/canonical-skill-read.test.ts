import { expect, it } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TestAgent, createMockBackendConfig, createMockWorkspace, collectEvents } from './test-utils.ts'
import type { LoadedSkill } from '../../skills/types.ts'

class Consumer extends TestAgent { check(name: string, input: Record<string, unknown>) { return this.checkCanonicalSkillUse(name, input) } }
async function own(run: (root: string, skill: LoadedSkill) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'canonical-agent-read-'))
  try {
    const path = join(root, '.polo/canonical-skills', 'a'.repeat(64), 'skills/original-slug')
    await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), '---\nname: original-slug\ndescription: Canonical native instructions.\n---\nOriginal instructions.')
    await run(root, { slug: `canonical-${'a'.repeat(64)}`, metadata: { name: 'original-slug', description: 'Canonical native instructions.' }, content: 'Original instructions.', source: 'workspace', path })
  } finally { await rm(root, { recursive: true, force: true }) }
}
it('BaseAgent real chat resolves isolated native SKILL.md and registered prerequisites, then Read/Bash use fresh authority', async () => own(async (root, skill) => {
  let allowed = true, checks = 0
  const agent = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), canonicalSkills: { load: async () => [skill], authorize: async () => { checks++; if (!allowed) throw new Error('membership revoked') }, finish: async () => {} } }))
  const turn = agent.chat(`[skill:${skill.slug}] inspect the change`)
  expect((await turn.next()).value?.type).toBe('complete')
  expect(agent.chatCalls[0]!.message).toContain(join(skill.path, 'SKILL.md'))
  expect(await agent.check('Read', { file_path: join(skill.path, 'SKILL.md') })).toBeNull()
  expect(await agent.check('Bash', { command: `cat '${join(skill.path, 'SKILL.md')}'` })).toBeNull()
  allowed = false
  expect(await agent.check('Read', { file_path: join(skill.path, 'SKILL.md') })).toContain('unavailable')
  expect(await agent.check('Bash', { command: 'echo instructions from this selected Skill' })).toContain('unavailable')
  expect(checks).toBeGreaterThanOrEqual(5)
  await turn.return(undefined as never)
  expect(await agent.check('Read', { file_path: join(skill.path, 'SKILL.md') })).toContain('no current')
}))
it('cold canonical paths and SDK plugin Skill cannot borrow ordinary workspace or global slug authority', async () => own(async (root, skill) => {
  const cold = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }) }))
  expect(await cold.check('Read', { file_path: join(skill.path, 'SKILL.md') })).toContain('no current')
  const bound = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), canonicalSkills: { allowLocalSkills: async () => true, load: async () => [skill], authorize: async () => {}, finish: async () => {} } }))
  const turn = bound.chat('Ordinary message'); await turn.next()
  expect(await bound.check('Skill', { skill: skill.slug })).toContain('Read-before-execute')
  expect(await bound.check('Read', { file_path: join(root, 'skills/ordinary/SKILL.md') })).toBeNull()
  await turn.return(undefined as never)
}))

it('cold unmentioned paths normalize double-slash, relative and symlink aliases before direct Read/Bash authorization', async () => own(async (root, skill) => {
  const { symlink } = await import('node:fs/promises')
  const cold = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), session: { id: 'alias-session', workspaceRootPath: root, workingDirectory: root, createdAt: Date.now(), lastUsedAt: Date.now() } }))
  const target = join(skill.path, 'SKILL.md')
  const double = target.replace('/.polo/canonical-skills/', '/.polo//canonical-skills/')
  expect(await cold.check('Read', { file_path: double })).toContain('no current')
  expect(await cold.check('Read', { file_path: `./.polo/canonical-skills/${'a'.repeat(64)}/skills/original-slug/../original-slug/SKILL.md` })).toContain('no current')
  await symlink(skill.path, join(root, 'shortcut'))
  expect(await cold.check('Read', { file_path: join(root, 'shortcut/SKILL.md') })).toContain('no current')
  expect(await cold.check('Bash', { command: `cat '${double}'` })).toContain('no current')
}))

it('actual chat generator uses one original UUID for every tool and finishes it on return and denied admission', async () => own(async (root, skill) => {
  const calls: string[] = [], finished: string[] = []
  const agent = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), canonicalSkills: { load: async () => [skill], authorize: async (_paths, turnId) => { calls.push(turnId) }, finish: async turnId => { finished.push(turnId) } } }))
  const first = agent.chat(`[skill:${skill.slug}] use it`); await first.next()
  await agent.check('Read', { file_path: join(skill.path, 'SKILL.md') })
  expect(new Set(calls).size).toBe(1); expect(calls[0]).toMatch(/^[a-f0-9-]{36}$/)
  await first.return(undefined as never); expect(finished).toEqual([calls[0]!])
  const second = agent.chat(`[skill:${skill.slug}] new turn`); await second.next(); await second.return(undefined as never)
  expect(finished[1]).not.toBe(finished[0])
  const deniedFinish: string[] = []
  const denied = new Consumer(createMockBackendConfig({ workspace: createMockWorkspace({ rootPath: root }), canonicalSkills: { load: async () => [skill], authorize: async () => { throw new Error('revoked') }, finish: async id => { deniedFinish.push(id) } } }))
  expect((await collectEvents(denied.chat(`[skill:${skill.slug}] denied`))).some(e => e.type === 'error')).toBe(true)
  expect(deniedFinish).toHaveLength(1)
}))

it('cold lexical canonical paths remain protected when the entire canonical root is redirected outside', async () => {
  const { symlink } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'canonical-redirect-read-')), foreign = await mkdtemp(join(tmpdir(), 'canonical-redirect-neighbor-'))
  try {
    await mkdir(join(root,'.polo')); await writeFile(join(foreign,'SKILL.md'),'redirected native bytes'); await symlink(foreign,join(root,'.polo/canonical-skills'))
    const agent = new Consumer(createMockBackendConfig({workspace:createMockWorkspace({rootPath:root})}))
    expect(await agent.check('Read',{file_path:join(root,'.polo/canonical-skills/SKILL.md')})).toContain('no current')
  } finally { await rm(root,{recursive:true,force:true}); await rm(foreign,{recursive:true,force:true}) }
})
